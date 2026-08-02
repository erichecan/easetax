// 核心链落库：收单 → OCR → 分类。全程走状态机（assertTransition）+ 写 AuditLog。
// DB + Provider 编排层，不含 HTTP/Next。上传路由与后台任务都调这里。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertTransition,
  resolveTaxTreatment,
  rollupConfidence,
  type Confidence,
  type DocSource,
  type DocStatus,
} from "@/domain";
import { fileHash, validateUpload } from "@/lib/intake/file-validation";
import { withRetry } from "@/lib/retry";
import {
  classifyLine,
  getClassifier,
  getOcrProvider,
  getStorageProvider,
  storageKeyFor,
  type GlAccountRef,
  type RuleLike,
} from "@/lib/providers";

const SYSTEM_USER = "system";
// DEV-PLAN P2：OCR 失败重试 3 次 + 退避
const OCR_MAX_ATTEMPTS = 3;

async function audit(
  firmId: string,
  userId: string,
  documentId: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: { firmId, userId, documentId, action, detail: detail as Prisma.InputJsonValue },
  });
}

type DocLite = { id: string; firmId: string; status: string };

// 单步状态跃迁：断言合法 → 更新 → 审计。本地 doc.status 同步，供链式调用。
async function transitionTo(
  doc: DocLite,
  to: DocStatus,
  userId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  assertTransition(doc.status as DocStatus, to);
  await prisma.document.update({ where: { id: doc.id }, data: { status: to } });
  await audit(doc.firmId, userId, doc.id, `status:${doc.status}->${to}`, detail);
  doc.status = to;
}

export type IngestInput = {
  firmId: string;
  clientId: string;
  source: DocSource;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  userId?: string;
};

export type IngestResult = { documentId: string; duplicate: boolean };

// 收单：校验 → 指纹去重 → 存储 → 建 Document(received)。
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const v = validateUpload({ fileName: input.fileName, mimeType: input.mimeType, size: input.bytes.byteLength });
  if (!v.ok) throw new Error(v.error);

  const hash = fileHash(input.bytes);
  const existing = await prisma.document.findUnique({
    where: { firmId_fileHash: { firmId: input.firmId, fileHash: hash } },
  });
  if (existing) return { documentId: existing.id, duplicate: true };

  const storageKey = storageKeyFor(input.clientId, hash, input.fileName);
  await getStorageProvider().put(storageKey, input.bytes, input.mimeType);

  const doc = await prisma.document.create({
    data: {
      firmId: input.firmId,
      clientId: input.clientId,
      source: input.source,
      fileName: input.fileName,
      mimeType: input.mimeType,
      storageKey,
      fileHash: hash,
      status: "received",
    },
  });
  await audit(input.firmId, input.userId ?? SYSTEM_USER, doc.id, "ingest", { fileName: input.fileName });
  return { documentId: doc.id, duplicate: false };
}

export type ProcessResult = { status: DocStatus; lines: number; docConfidence?: Confidence };

// 可重跑的状态（契约 §4.1 重跑边）。confirmed 之后人工结果即权威，要重跑先退回 needs_review。
export const REPROCESSABLE: readonly DocStatus[] = ["needs_review", "ocr_failed"];

// 重跑：销毁上一次识别结果（Extraction + LineItem）后重走 OCR→分类。
// 用于 OCR/分类能力升级（如接入 Claude）后重跑存量单据，无需客户重传。
export async function reprocessDocument(documentId: string, userId = SYSTEM_USER): Promise<ProcessResult> {
  const record = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  if (!REPROCESSABLE.includes(record.status as DocStatus)) {
    throw new Error(`当前状态「${record.status}」不可重跑`);
  }

  // 不预删旧结果：processDocument 在 OCR/分类成功后才替换，失败则保留上一次的可用数据。
  await audit(record.firmId, userId, documentId, "reprocess", { from: record.status });

  return processDocument(documentId, userId);
}

// 处理：OCR → Extraction，逐行分类 → LineItem，落到 needs_review。
export async function processDocument(documentId: string, userId = SYSTEM_USER): Promise<ProcessResult> {
  const record = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const doc: DocLite = { id: record.id, firmId: record.firmId, status: record.status };

  // 客户科目表：既是分类候选，也作为 Veryfi categories（文档级分类建议）。
  const accounts: GlAccountRef[] = (
    await prisma.glAccountCache.findMany({ where: { clientId: record.clientId } })
  ).map((a) => ({ qboAccountId: a.qboAccountId, name: a.name, accountType: a.accountType }));

  await transitionTo(doc, "ocr_processing", userId);

  let ocr;
  let ocrAttempts = 1;
  const retryLog: { attempt: number; delayMs: number; error: string }[] = [];
  try {
    const bytes = await getStorageProvider().get(record.storageKey);
    // 网络抖动或 OCR 服务 5xx 不该让单据直接报废（DEV-PLAN §6：重试+退避）。
    // 4xx（凭据失效、试用到期、文件类型不支持）不重试 —— 试几次都一样。
    const r = await withRetry(
      () =>
        getOcrProvider().extract({
          bytes,
          fileName: record.fileName,
          mimeType: record.mimeType,
          categories: accounts.map((a) => a.name),
        }),
      {
        attempts: OCR_MAX_ATTEMPTS,
        onRetry: ({ attempt, delayMs, error }) =>
          retryLog.push({ attempt, delayMs, error: error instanceof Error ? error.message : String(error) }),
      },
    );
    ocr = r.value;
    ocrAttempts = r.attempts;
  } catch (e) {
    await transitionTo(doc, "ocr_failed", userId, {
      error: e instanceof Error ? e.message : String(e),
      attempts: retryLog.length + 1,
      retries: retryLog,
    });
    return { status: "ocr_failed", lines: 0 };
  }
  if (ocrAttempts > 1) {
    await audit(doc.firmId, userId, doc.id, "ocr:recovered_after_retry", { attempts: ocrAttempts, retries: retryLog });
  }

  // 重跑时替换上一次识别结果：**先 OCR 成功再删**，OCR 失败则旧结果原样保留。
  await prisma.$transaction([
    prisma.extraction.deleteMany({ where: { documentId } }),
    prisma.extraction.create({
      data: {
        documentId,
        rawJson: ocr.raw as Prisma.InputJsonValue,
        vendorName: ocr.vendorName,
        invoiceNo: ocr.invoiceNo,
        txnDate: ocr.txnDate ? new Date(ocr.txnDate) : null,
        dueDate: ocr.dueDate ? new Date(ocr.dueDate) : null,
        currency: ocr.currency,
        subTotal: ocr.subTotal,
        taxAmount: ocr.taxAmount,
        total: ocr.total,
        supplierTaxNumber: ocr.supplierTaxNumber,
        recipientName: ocr.recipientName,
        paymentTerms: ocr.paymentTerms,
        fieldConfidence: ocr.fieldConfidence as Prisma.InputJsonValue,
      },
    }),
  ]);

  // 付款状态：OCR 给初值，人工可改（契约 G9）。已人工设过的不覆盖。
  if (ocr.settlementHint && !record.settlement) {
    await prisma.document.update({ where: { id: documentId }, data: { settlement: ocr.settlementHint } });
  }
  await transitionTo(doc, "ocr_done", userId);
  await transitionTo(doc, "classifying", userId);

  const rules: RuleLike[] = (
    await prisma.classificationRule.findMany({
      where: { firmId: record.firmId, OR: [{ clientId: record.clientId }, { clientId: null }] },
    })
  ).map((r) => ({
    matchType: r.matchType as RuleLike["matchType"],
    matchValue: r.matchValue,
    glAccountId: r.glAccountId,
    glAccountName: r.glAccountName,
  }));

  // Veryfi 文档级分类建议 → 映射到本地科目（按名字），作分类兜底。
  const suggAcct = ocr.suggestedCategory
    ? accounts.find((a) => a.name === ocr.suggestedCategory!.value)
    : undefined;
  const suggestedCategory =
    suggAcct && ocr.suggestedCategory
      ? { glAccountId: suggAcct.qboAccountId, glAccountName: suggAcct.name, score: ocr.suggestedCategory.score }
      : null;

  // 税码语义键 → 该客户 QBO 实际 TaxCode.Id（契约 §4.8）。表为空时全部行留空税码 → 强制人工。
  const taxCodeByKey = new Map(
    (await prisma.taxCodeCache.findMany({ where: { clientId: record.clientId } }))
      .filter((t) => t.semanticKey)
      .map((t) => [t.semanticKey!, t.qboTaxCodeId]),
  );

  const classifier = getClassifier();
  const confidences: Confidence[] = [];
  const lineRows: Prisma.LineItemCreateManyInput[] = [];
  for (const line of ocr.lines) {
    const c = await classifyLine(
      {
        description: line.description,
        amount: line.amount,
        vendorName: ocr.vendorName,
        accounts,
        suggestedCategory,
      },
      rules,
      classifier,
    );

    // 税码走确定性规则，AI 不参与（契约 G10）。未命中 → 留空 + 降为 low，逼人工处理。
    const rule = resolveTaxTreatment({
      glAccountName: c.glAccountName,
      docTaxAmount: ocr.taxAmount == null ? null : Number(ocr.taxAmount),
      supplierTaxNumber: ocr.supplierTaxNumber,
      docTotal: ocr.total == null ? null : Number(ocr.total),
    });
    const taxCode = rule.treatment ? (taxCodeByKey.get(rule.treatment) ?? null) : null;
    const confidence: Confidence = taxCode ? c.confidence : "low";

    confidences.push(confidence);
    lineRows.push({
      documentId,
      description: line.description,
      amount: line.amount,
      glAccountId: c.glAccountId,
      glAccountName: c.glAccountName,
      taxCode,
      confidence,
    });
  }

  // 同上：分类全部完成后才替换旧行，中途失败不留半套数据。
  await prisma.$transaction([
    prisma.lineItem.deleteMany({ where: { documentId } }),
    prisma.lineItem.createMany({ data: lineRows }),
  ]);

  // 文档级 confidence 派生（契约 §4.7），仅入审计，不物化在 Document 上。
  const docConfidence = rollupConfidence(confidences.length ? confidences : ["low"]);
  await transitionTo(doc, "needs_review", userId, { lines: ocr.lines.length, docConfidence });

  return { status: "needs_review", lines: ocr.lines.length, docConfidence };
}

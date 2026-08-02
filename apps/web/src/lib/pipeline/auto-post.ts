// 绿色通道执行层（契约 §4.10）：评估六条与门 → 自动确认 → 自动录入 QBO。
// 不新增状态：仍走 needs_review → confirmed → syncing_qbo → synced，
// 只在 AuditLog 上留 auto_confirm / userId=system，并进「已自动过账」抽查列表。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertTransition,
  checkItc,
  evaluateAutoPost,
  type AutoPostDecision,
  type Confidence,
  type DocStatus,
} from "@/domain";
import { syncDocumentToQbo } from "./sync-qbo";

export const AUTO_POST_USER = "system";

export type AutoPostOutcome = {
  decision: AutoPostDecision;
  confirmed: boolean;
  synced: boolean;
  syncError?: string;
};

// 评估某单据是否够格自动过账。只读，可单独用于 UI 解释「为什么没自动过」。
export async function evaluateDocumentAutoPost(documentId: string): Promise<AutoPostDecision> {
  const doc = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { extraction: true, lines: true, client: true },
  });

  // 命中的供应商规则的人工确认次数 —— 绿色通道条件 1。
  const vendor = doc.extraction?.vendorName?.trim();
  const rule = vendor
    ? await prisma.classificationRule.findFirst({
        where: { firmId: doc.firmId, clientId: doc.clientId, matchType: "vendor", matchValue: vendor },
      })
    : null;

  const e = doc.extraction;
  const itc = checkItc({
    total: e?.total == null ? null : Number(e.total),
    taxAmount: e?.taxAmount == null ? null : Number(e.taxAmount),
    vendorName: e?.vendorName ?? null,
    txnDate: e?.txnDate ?? null,
    supplierTaxNumber: e?.supplierTaxNumber ?? null,
    recipientName: e?.recipientName ?? null,
    paymentTerms: e?.paymentTerms ?? null,
    lineDescriptions: doc.lines.map((l) => l.description),
  });

  return evaluateAutoPost({
    enabled: doc.client.autoPostEnabled,
    threshold: doc.client.autoPostThreshold == null ? null : Number(doc.client.autoPostThreshold),
    status: doc.status as DocStatus,
    total: e?.total == null ? null : Number(e.total),
    ruleConfirmedCount: rule?.confirmedCount ?? null,
    lineConfidences: doc.lines.map((l) => l.confidence as Confidence),
    lineTaxCodes: doc.lines.map((l) => l.taxCode),
    itcStatus: itc.status,
  });
}

// 处理完一张单据后调用：够格就自动确认并录入。任何一步失败都不影响单据本身，
// 只是退回人工（失败不改写已达成的状态）。
export async function maybeAutoPost(documentId: string): Promise<AutoPostOutcome> {
  const decision = await evaluateDocumentAutoPost(documentId);
  if (!decision.eligible) return { decision, confirmed: false, synced: false };

  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  if (doc.status !== "needs_review") return { decision, confirmed: false, synced: false };

  assertTransition(doc.status as DocStatus, "confirmed");
  await prisma.document.update({ where: { id: documentId }, data: { status: "confirmed" } });
  await prisma.auditLog.create({
    data: {
      firmId: doc.firmId,
      userId: AUTO_POST_USER,
      documentId,
      action: "auto_confirm",
      // 留下当时的判定依据，抽查时能复盘为什么放行
      detail: { gates: "all_passed" } as Prisma.InputJsonValue,
    },
  });

  // 自动确认**不累加** ClassificationRule.confirmedCount：那是人工验证的计数，
  // 让机器自己加会形成自我强化，绿色通道条件 1 就失去意义。

  try {
    const r = await syncDocumentToQbo(documentId, doc.firmId, AUTO_POST_USER);
    return { decision, confirmed: true, synced: r.status === "synced" };
  } catch (e) {
    // 录入失败（未连 QBO / QBO 报错）：单据停在 confirmed 或 sync_failed，等人工处理。
    return { decision, confirmed: true, synced: false, syncError: e instanceof Error ? e.message : String(e) };
  }
}

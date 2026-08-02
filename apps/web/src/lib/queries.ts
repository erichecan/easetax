// firm-scoped 读取 + DB→视图类型映射。所有查询强制带 firmId（契约 G8）。
// stats / 文档级 confidence 一律派生（契约 G4/§4.7），不物化。
import { prisma } from "@/lib/db";
import {
  checkItc,
  itcRiskRank,
  rollupConfidence,
  summarizePipeline,
  STAGE_META,
  type Confidence,
  type DocStatus,
  type PipelineSummary,
  type Settlement,
} from "@/domain";
import { reconcile } from "@/lib/reconcile";
import type {
  Client,
  DocumentRec,
  GlAccount,
  LineItem,
  ReconCandidate,
  ReconRow,
  TaxCodeRef,
  TaxTreatment,
} from "@/lib/types";

// ①–③ 机器自动跑的三段。从流程 SSOT 派生，不另写一份（否则加状态时两处漂移）。
const INBOX_STATUSES: DocStatus[] = [
  ...STAGE_META.intake.statuses,
  ...STAGE_META.extract.statuses,
  ...STAGE_META.classify.statuses,
];

function relativeTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return d.toISOString().slice(0, 10);
}

type DbDoc = {
  id: string;
  clientId: string;
  source: string;
  fileName: string;
  mimeType: string;
  status: string;
  settlement: string | null;
  createdAt: Date;
  extraction: {
    vendorName: string | null;
    invoiceNo: string | null;
    txnDate: Date | null;
    dueDate: Date | null;
    currency: string | null;
    subTotal: unknown;
    taxAmount: unknown;
    total: unknown;
    supplierTaxNumber: string | null;
    recipientName: string | null;
    paymentTerms: string | null;
  } | null;
  lines: {
    id: string;
    description: string;
    amount: unknown;
    glAccountId: string | null;
    glAccountName: string | null;
    taxCode: string | null;
    confidence: string;
  }[];
};

function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function toDocumentRec(d: DbDoc): DocumentRec {
  const e = d.extraction;
  const lines: LineItem[] = d.lines.map((l) => ({
    id: l.id,
    description: l.description,
    amount: num(l.amount),
    glAccountId: l.glAccountId,
    glAccountName: l.glAccountName,
    taxCode: l.taxCode ?? "",
    confidence: l.confidence as Confidence,
  }));
  const docConfidence = rollupConfidence(lines.length ? lines.map((l) => l.confidence) : ["low"]);
  const tax = num(e?.taxAmount);
  // CRA 凭证等级：实时派生，不物化（契约 §4.9）
  const itc = checkItc({
    total: numOrNull(e?.total),
    taxAmount: numOrNull(e?.taxAmount),
    vendorName: e?.vendorName ?? null,
    txnDate: e?.txnDate ?? null,
    supplierTaxNumber: e?.supplierTaxNumber ?? null,
    recipientName: e?.recipientName ?? null,
    paymentTerms: e?.paymentTerms ?? null,
    lineDescriptions: lines.map((l) => l.description),
  });
  return {
    itc,
    supplierTaxNumber: e?.supplierTaxNumber ?? null,
    recipientName: e?.recipientName ?? null,
    paymentTerms: e?.paymentTerms ?? null,
    settlement: (d.settlement as Settlement | null) ?? null,
    id: d.id,
    clientId: d.clientId,
    source: d.source === "email" ? "email" : "upload",
    fileName: d.fileName,
    fileKind: d.mimeType === "application/pdf" ? "pdf" : "image",
    vendor: e?.vendorName ?? "—",
    invoiceNo: e?.invoiceNo ?? "—",
    txnDate: e?.txnDate ? e.txnDate.toISOString().slice(0, 10) : "",
    dueDate: e?.dueDate ? e.dueDate.toISOString().slice(0, 10) : "",
    currency: e?.currency ?? "CAD",
    subTotal: num(e?.subTotal),
    tax,
    taxLabel: tax > 0 ? "含税 HST" : "免税",
    total: num(e?.total),
    status: d.status as DocStatus,
    confidence: docConfidence,
    receivedAt: relativeTime(d.createdAt),
    lines,
  };
}

const DOC_INCLUDE = { extraction: true, lines: { orderBy: { id: "asc" as const } } };

async function statsByClient(firmId: string): Promise<Map<string, Client["stats"]>> {
  const groups = await prisma.document.groupBy({
    by: ["clientId", "status"],
    where: { firmId },
    _count: { _all: true },
  });
  const map = new Map<string, Client["stats"]>();
  for (const g of groups) {
    const s = map.get(g.clientId) ?? { inbox: 0, review: 0, synced: 0 };
    const n = g._count._all;
    if (g.status === "needs_review") s.review += n;
    else if (g.status === "synced") s.synced += n;
    else if (INBOX_STATUSES.includes(g.status as DocStatus)) s.inbox += n;
    map.set(g.clientId, s);
  }
  return map;
}

export async function getFirm(firmId: string): Promise<{ name: string } | null> {
  return prisma.firm.findUnique({ where: { id: firmId }, select: { name: true } });
}

export async function getClientsForFirm(firmId: string): Promise<Client[]> {
  const [clients, stats] = await Promise.all([
    prisma.client.findMany({ where: { firmId }, orderBy: { createdAt: "asc" } }),
    statsByClient(firmId),
  ]);
  return clients.map((c) => ({
    id: c.id,
    name: c.name,
    industry: c.industry ?? "",
    qboConnected: c.qboRealmId != null,
    qboRealmId: c.qboRealmId,
    inboundEmail: c.inboundEmail,
    province: c.province,
    taxNumber: c.taxNumber,
    qboPaymentAccountId: c.qboPaymentAccountId,
    autoPostEnabled: c.autoPostEnabled,
    autoPostThreshold: c.autoPostThreshold == null ? null : Number(c.autoPostThreshold),
    stats: stats.get(c.id) ?? { inbox: 0, review: 0, synced: 0 },
  }));
}

export async function getClient(firmId: string, clientId: string): Promise<Client | null> {
  const c = await prisma.client.findFirst({ where: { id: clientId, firmId } });
  if (!c) return null;
  const stats = await statsByClient(firmId);
  return {
    id: c.id,
    name: c.name,
    industry: c.industry ?? "",
    qboConnected: c.qboRealmId != null,
    qboRealmId: c.qboRealmId,
    inboundEmail: c.inboundEmail,
    province: c.province,
    taxNumber: c.taxNumber,
    qboPaymentAccountId: c.qboPaymentAccountId,
    autoPostEnabled: c.autoPostEnabled,
    autoPostThreshold: c.autoPostThreshold == null ? null : Number(c.autoPostThreshold),
    stats: stats.get(c.id) ?? { inbox: 0, review: 0, synced: 0 },
  };
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

// 复核队列排序：凭证风险 > 置信度 > 金额（业务流程设计 §2.3）。
// 待复核的排在前面，已完结的（confirmed/synced/rejected）按时间倒序垫底。
export function sortReviewQueue(docs: DocumentRec[]): DocumentRec[] {
  const pending = (d: DocumentRec) => d.status === "needs_review" || d.status === "duplicate_suspected";
  return [...docs].sort((a, b) => {
    if (pending(a) !== pending(b)) return pending(a) ? -1 : 1;
    if (!pending(a)) return 0; // 非待办保持原有的时间倒序
    const risk = itcRiskRank(a.itc.status) - itcRiskRank(b.itc.status);
    if (risk !== 0) return risk;
    const conf = CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
    if (conf !== 0) return conf;
    return b.total - a.total;
  });
}

export async function getClientDocuments(firmId: string, clientId: string): Promise<DocumentRec[]> {
  const docs = await prisma.document.findMany({
    where: { firmId, clientId },
    include: DOC_INCLUDE,
    orderBy: { createdAt: "desc" },
  });

  // 自动过账标记：绿色通道不新增状态（契约 §4.10），凭 AuditLog 识别，一次查询避免 N+1。
  const autoIds = new Set(
    (
      await prisma.auditLog.findMany({
        where: { firmId, action: "auto_confirm", documentId: { in: docs.map((d) => d.id) } },
        select: { documentId: true },
      })
    ).map((a) => a.documentId!),
  );

  return sortReviewQueue(docs.map((d) => ({ ...toDocumentRec(d as DbDoc), autoPosted: autoIds.has(d.id) })));
}

// 客户工作台：五段管道 + 两条护栏（缺收据、凭证缺件）。一次查询喂满首屏。
export async function getClientWorkbench(
  firmId: string,
  clientId: string,
): Promise<{ docs: DocumentRec[]; pipeline: PipelineSummary; missingReceipts: { count: number; amount: number } }> {
  const [docs, recon] = await Promise.all([
    getClientDocuments(firmId, clientId),
    getReconciliation(firmId, clientId),
  ]);

  const missing = recon.rows.filter((r) => r.matchKind === "none");
  return {
    docs,
    pipeline: summarizePipeline(docs.map((d) => d.status)),
    missingReceipts: {
      count: missing.length,
      amount: missing.reduce((s, r) => s + r.txn.amount, 0),
    },
  };
}

// 侧边栏用：复核页路由里没有 clientId，由单据反查（带 firmId 隔离，契约 G8）。
export async function getClientIdOfDocument(firmId: string, documentId: string): Promise<string | null> {
  const d = await prisma.document.findFirst({
    where: { id: documentId, firmId },
    select: { clientId: true },
  });
  return d?.clientId ?? null;
}

export async function getClientTaxCodes(clientId: string): Promise<TaxCodeRef[]> {
  const rows = await prisma.taxCodeCache.findMany({ where: { clientId }, orderBy: { name: "asc" } });
  return rows.map((t) => ({
    id: t.qboTaxCodeId,
    name: t.name,
    treatment: (t.semanticKey as TaxTreatment | null) ?? null,
  }));
}

export async function getClientAccounts(clientId: string): Promise<GlAccount[]> {
  const accts = await prisma.glAccountCache.findMany({ where: { clientId }, orderBy: { name: "asc" } });
  return accts.map((a) => ({ id: a.qboAccountId, code: a.qboAccountId, name: a.name }));
}

// 期间标签：由流水日期派生（契约 G4「能算的不存」），无流水时为空串。
function periodLabel(dates: Date[]): string {
  if (dates.length === 0) return "";
  const fmt = (d: Date) => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const first = fmt(sorted[0]);
  const last = fmt(sorted[sorted.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

// 对账视图：银行流水 + 单据实时匹配（契约 §4.6，匹配结果 derived 不落库）。
export async function getReconciliation(
  firmId: string,
  clientId: string,
): Promise<{ rows: ReconRow[]; period: string; candidates: ReconCandidate[] }> {
  const [txns, docs, notices] = await Promise.all([
    prisma.bankTxn.findMany({ where: { firmId, clientId }, orderBy: { date: "asc" } }),
    prisma.document.findMany({
      where: { firmId, clientId, status: { notIn: ["rejected", "duplicate_suspected"] } },
      select: { id: true, fileName: true, extraction: { select: { vendorName: true, total: true, txnDate: true } } },
    }),
    // 催票记录（契约 §4.12）：只反映「催过没有」，是否解决看当前匹配状态
    prisma.chaseNotice.groupBy({
      by: ["bankTxnId"],
      where: { firmId, clientId },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
  ]);
  const chaseByTxn = new Map(notices.map((n) => [n.bankTxnId, n]));

  const reconDocs = docs.map((d) => ({
    id: d.id,
    fileName: d.fileName,
    vendorName: d.extraction?.vendorName ?? null,
    total: d.extraction?.total == null ? null : Number(d.extraction.total),
    txnDate: d.extraction?.txnDate ?? null,
  }));

  const results = reconcile(
    txns.map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: Number(t.amount),
      matchedDocumentId: t.matchedDocumentId,
      matchStatus: t.matchStatus,
    })),
    reconDocs,
  );
  const byTxn = new Map(results.map((r) => [r.txnId, r]));

  const rows: ReconRow[] = txns.map((t) => {
    const r = byTxn.get(t.id)!;
    const chase = chaseByTxn.get(t.id);
    return {
      txn: {
        id: t.id,
        clientId: t.clientId,
        date: t.date.toISOString().slice(0, 10),
        description: t.description,
        amount: Number(t.amount),
      },
      matchKind: r.matchKind,
      matchedDocId: r.matchedDocId,
      matchedFileName: r.matchedFileName,
      chaseCount: chase?._count._all ?? 0,
      lastChasedAt: chase?._max.createdAt ? chase._max.createdAt.toISOString().slice(0, 10) : null,
    };
  });

  // 人工匹配的候选单据：给会计师挑的时候要看得出是哪张（供应商+金额+日期）
  const candidates: ReconCandidate[] = reconDocs.map((d) => ({
    id: d.id,
    fileName: d.fileName,
    vendor: d.vendorName ?? "—",
    total: d.total ?? 0,
    txnDate: d.txnDate ? d.txnDate.toISOString().slice(0, 10) : "",
  }));

  return { rows, period: periodLabel(txns.map((t) => t.date)), candidates };
}

export async function getDocumentForReview(
  firmId: string,
  documentId: string,
): Promise<{
  doc: DocumentRec;
  client: Client;
  accounts: GlAccount[];
  taxCodes: TaxCodeRef[];
  ocrText: string | null;
} | null> {
  const d = await prisma.document.findFirst({
    where: { id: documentId, firmId },
    include: DOC_INCLUDE,
  });
  if (!d) return null;
  const client = await getClient(firmId, d.clientId);
  if (!client) return null;
  const [accts, taxes] = await Promise.all([
    prisma.glAccountCache.findMany({ where: { clientId: d.clientId }, orderBy: { name: "asc" } }),
    prisma.taxCodeCache.findMany({ where: { clientId: d.clientId }, orderBy: { name: "asc" } }),
  ]);
  const accounts: GlAccount[] = accts.map((a) => ({ id: a.qboAccountId, code: a.qboAccountId, name: a.name }));
  const taxCodes: TaxCodeRef[] = taxes.map((t) => ({
    id: t.qboTaxCodeId,
    name: t.name,
    treatment: (t.semanticKey as TaxTreatment | null) ?? null,
  }));
  const ocrText = (d.extraction?.rawJson as { ocr_text?: string } | null)?.ocr_text ?? null;
  return { doc: toDocumentRec(d as DbDoc), client, accounts, taxCodes, ocrText };
}

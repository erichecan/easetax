// firm-scoped 读取 + DB→视图类型映射。所有查询强制带 firmId（契约 G8）。
// stats / 文档级 confidence 一律派生（契约 G4/§4.7），不物化。
import type { Prisma } from "@prisma/client";
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
  qboBillId: string | null;
  qboEntity: string | null;
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
    qboBillId: d.qboBillId,
    qboEntity: d.qboEntity,
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

export type RuleRow = {
  id: string;
  matchType: string;
  matchValue: string;
  glAccountId: string;
  glAccountName: string;
  confirmedCount: number;
  createdAt: string;
};

// 分类规则列表。规则优先级最高（业务流程设计 §2.3），学错一条会持续污染后续单据，
// 所以要能看见、能改。confirmedCount 一并给出——它是绿色通道的信任依据（§4.10）。
export async function getClientRules(firmId: string, clientId: string): Promise<RuleRow[]> {
  const rows = await prisma.classificationRule.findMany({
    where: { firmId, OR: [{ clientId }, { clientId: null }] },
    orderBy: [{ confirmedCount: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    matchType: r.matchType,
    matchValue: r.matchValue,
    glAccountId: r.glAccountId,
    glAccountName: r.glAccountName,
    confirmedCount: r.confirmedCount,
    createdAt: r.createdAt.toISOString().slice(0, 10),
  }));
}

export type ItcReportRow = {
  id: string;
  fileName: string;
  vendor: string;
  txnDate: string;
  total: number;
  taxAmount: number;
  status: DocStatus;
  missing: string[];
  tier: string | null;
};

// 月末「不可抵扣清单」（业务流程设计 §2.2 护栏 B）。
// 关键口径：只算**税额**不可抵的部分，不是整张票的金额 —— 费用照记，抵不了的是 ITC。
export async function getItcReport(
  firmId: string,
  clientId: string,
  range?: { from?: string; to?: string },
): Promise<{ rows: ItcReportRow[]; unrecoverableTax: number; period: string }> {
  const docs = await getClientDocuments(firmId, clientId);

  const from = range?.from ? new Date(range.from) : null;
  const to = range?.to ? new Date(`${range.to}T23:59:59`) : null;

  const rows = docs
    .filter((d) => d.itc.status === "incomplete")
    .filter((d) => {
      if (!d.txnDate) return !from && !to; // 无日期的只在不筛期间时出现
      const t = new Date(d.txnDate);
      if (from && t < from) return false;
      if (to && t > to) return false;
      return true;
    })
    .map((d) => ({
      id: d.id,
      fileName: d.fileName,
      vendor: d.vendor,
      txnDate: d.txnDate,
      total: d.total,
      taxAmount: d.tax,
      status: d.status,
      missing: d.itc.missing,
      tier: d.itc.tier,
    }));

  return {
    rows,
    unrecoverableTax: rows.reduce((s, r) => s + r.taxAmount, 0),
    period: from || to ? `${range?.from ?? "最早"} ~ ${range?.to ?? "至今"}` : "全部期间",
  };
}

export type AuditEntry = {
  id: string;
  createdAt: string;
  userId: string;
  action: string;
  documentId: string | null;
  fileName: string | null;
  detail: unknown;
};

// 该客户的审计流。AuditLog 上没有 clientId（契约 §3 的表结构），所以两路取：
// 单据级靠 documentId ∈ 该客户的单据；客户级靠 detail.clientId。
export async function getClientAudit(
  firmId: string,
  clientId: string,
  opts: { documentId?: string; limit?: number; offset?: number } = {},
): Promise<{ entries: AuditEntry[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 300);
  const offset = opts.offset ?? 0;

  const docs = await prisma.document.findMany({
    where: { firmId, clientId },
    select: { id: true, fileName: true },
  });
  const nameById = new Map(docs.map((d) => [d.id, d.fileName]));

  const where: Prisma.AuditLogWhereInput = opts.documentId
    ? { firmId, documentId: opts.documentId }
    : {
        firmId,
        OR: [
          { documentId: { in: docs.map((d) => d.id) } },
          { detail: { path: ["clientId"], equals: clientId } },
        ],
      };

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      userId: r.userId,
      action: r.action,
      documentId: r.documentId,
      fileName: r.documentId ? (nameById.get(r.documentId) ?? null) : null,
      detail: r.detail,
    })),
    total,
  };
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
  nextDocId: string | null;
  remainingCount: number;
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

  // 「确认并下一张」用：同客户下按复核队列顺序排在这张之后的第一张待复核单据。
  // 顺序与工作台一致（凭证风险 > 置信度 > 金额），否则跳转顺序会和列表对不上。
  const pending = (await getClientDocuments(firmId, d.clientId)).filter((x) => x.status === "needs_review");
  const idx = pending.findIndex((x) => x.id === documentId);
  const nextDocId = idx >= 0 ? (pending[idx + 1]?.id ?? null) : (pending[0]?.id ?? null);
  const remainingCount = idx >= 0 ? pending.length - idx - 1 : pending.length;

  return { doc: toDocumentRec(d as DbDoc), client, accounts, taxCodes, ocrText, nextDocId, remainingCount };
}

// ⚠️ 枚举类型的唯一来源是 @/domain（数据契约 G7）。本文件只 re-export，
// 并保留「演示 UI 专用」的视图类型（真实 DB 版本用 Prisma 生成类型）。
export type { Confidence, DocStatus, DocSource, ItcCheck, ItcStatus, Settlement, TaxTreatment } from "@/domain";
export type { MatchKind } from "@/lib/reconcile";
export type { RuleRow, AuditEntry, ItcReportRow } from "@/lib/queries";
import type { Confidence, DocStatus, ItcCheck, Settlement, TaxTreatment } from "@/domain";
import type { MatchKind } from "@/lib/reconcile";

// ---- 以下为 demo/mock 的视图类型，非持久层模型 ----

export type GlAccount = {
  id: string;
  code: string;
  name: string;
};

// 客户 QBO 税码（本地 cache，契约 §4.8）。treatment = 规则表语义键。
export type TaxCodeRef = {
  id: string;
  name: string;
  treatment: TaxTreatment | null;
};

export type LineItem = {
  id: string;
  description: string;
  amount: number;
  glAccountId: string | null;
  glAccountName: string | null;
  taxCode: string;
  confidence: Confidence;
};

export type ClientStats = {
  inbox: number;
  review: number;
  synced: number;
};

export type Client = {
  id: string;
  name: string;
  industry: string;
  qboConnected: boolean;
  qboRealmId: string | null;
  inboundEmail: string;
  // 税码规则输入 + 绿色通道配置（契约 §4.11）
  province: string | null;
  taxNumber: string | null;
  qboPaymentAccountId: string | null;
  autoPostEnabled: boolean;
  autoPostThreshold: number | null;
  stats: ClientStats;
};

export type BankTxn = {
  id: string;
  clientId: string;
  date: string;
  description: string;
  amount: number;
};

// 人工匹配时可选的单据（契约 §4.6：人工裁决是 canonical）
export type ReconCandidate = {
  id: string;
  fileName: string;
  vendor: string;
  total: number;
  txnDate: string;
};

export type ReconRow = {
  txn: BankTxn;
  matchKind: MatchKind;
  matchedDocId: string | null;
  matchedFileName: string | null;
  // 追票记录（契约 §4.12）：催过几次、最近一次何时。是否已解决看 matchKind，不单独存。
  chaseCount: number;
  lastChasedAt: string | null;
};

export type DocumentRec = {
  id: string;
  clientId: string;
  source: "email" | "upload";
  fileName: string;
  fileKind: "pdf" | "image";
  vendor: string;
  invoiceNo: string;
  txnDate: string;
  dueDate: string;
  currency: string;
  subTotal: number;
  tax: number;
  taxLabel: string;
  total: number;
  status: DocStatus;
  confidence: Confidence;
  // CRA 凭证要件原值（供复核页人工订正，契约 §4.9）
  supplierTaxNumber: string | null;
  recipientName: string | null;
  paymentTerms: string | null;
  itc: ItcCheck; // CRA 抵扣凭证等级，derived（契约 §4.9）
  settlement: Settlement | null; // 已付/未付，决定录 Expense 还是 Bill（契约 G9）
  autoPosted?: boolean; // 由绿色通道自动确认（契约 §4.10），供抽查
  qboBillId: string | null;
  qboEntity: string | null;
  receivedAt: string;
  lines: LineItem[];
  note?: string;
};

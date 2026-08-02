// P2 OCR 抽象。上层只依赖 OcrProvider 接口；Veryfi 有 key 就真跑，否则 mock。
import type { Confidence } from "@/domain";

// 金额一律用 decimal 字符串跨边界，禁 float（契约 G1）。持久化时 new Prisma.Decimal(str)。
export type DecimalString = string;

export type OcrLine = {
  description: string;
  quantity?: DecimalString;
  unitPrice?: DecimalString;
  amount: DecimalString;
};

// OCR 结构化结果 → 一一对应 Extraction 字段（契约 §3）。
export type OcrExtraction = {
  vendorName: string | null;
  invoiceNo: string | null;
  txnDate: string | null; // ISO yyyy-mm-dd
  dueDate: string | null; // ISO yyyy-mm-dd
  currency: string | null;
  subTotal: DecimalString | null;
  taxAmount: DecimalString | null;
  total: DecimalString | null;
  // CRA 抵扣凭证要件（契约 §4.9）——决定这笔 ITC 能不能抵，不是可选的锦上添花。
  supplierTaxNumber: string | null; // 供应商 GST/HST 登记号
  recipientName: string | null; // 购方名称
  paymentTerms: string | null; // 付款条款
  // 付款状态线索（契约 G9）：provider 能判就给，判不了给 null，由复核人定。
  settlementHint: "paid" | "unpaid" | null;
  lines: OcrLine[];
  overallConfidence: Confidence; // 落 provider 判定；doc 级 confidence 仍由 §4.7 派生
  fieldConfidence: Record<string, number>; // 原始字段级分数 → Extraction.fieldConfidence(Json)
  // Veryfi 文档级分类建议（传 categories 时返回）：value ∈ 客户科目名，score 0–1。
  suggestedCategory: { value: string; score: number } | null;
  raw: unknown; // 原始响应 → Extraction.rawJson（审计/重放）
};

export type OcrInput = {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  categories?: string[]; // 客户科目名列表 → Veryfi 文档级分类
  documentType?: string; // 强制识别模式（不传则自动判定）
};

export interface OcrProvider {
  readonly name: string;
  extract(input: OcrInput): Promise<OcrExtraction>;
}

// 供 provider 内部把 0–1 分数映射到 Confidence 分级的公用阈值。
export function scoreToConfidence(score: number, low = 0.6, high = 0.85): Confidence {
  if (score < low) return "low";
  if (score < high) return "medium";
  return "high";
}

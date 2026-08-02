// CRA 进项税抵扣（ITC）凭证等级 —— 契约 §4.9。
// 依据：Input Tax Credit Information (GST/HST) Regulations，凭证要件按票面总额分三档。
// **derived，不物化**（契约 G4）：由 Extraction 已抽字段实时算。
// ⚠️ 这是风险信号不是拦截器：凭证不达标照样能入账，只是这笔 ITC 不能抵，必须显式提示会计师。

export const ITC_TIERS = ["under_30", "under_150", "over_150"] as const;
export type ItcTier = (typeof ITC_TIERS)[number];

export const ITC_STATUSES = ["ok", "incomplete", "not_applicable", "unknown"] as const;
export type ItcStatus = (typeof ITC_STATUSES)[number];

export const ITC_REQUIREMENTS = [
  "vendorName",
  "txnDate",
  "total",
  "supplierTaxNumber",
  "taxAmount",
  "recipientName",
  "paymentTerms",
  "lineDescriptions",
] as const;
export type ItcRequirement = (typeof ITC_REQUIREMENTS)[number];

export const ITC_REQUIREMENT_LABELS: Record<ItcRequirement, string> = {
  vendorName: "供应商名称",
  txnDate: "发票/付款日期",
  total: "票面总额",
  supplierTaxNumber: "供应商 GST/HST 登记号",
  taxAmount: "税额或含税声明",
  recipientName: "购方名称",
  paymentTerms: "付款条款",
  lineDescriptions: "每项供应的描述",
};

export const TIER_THRESHOLD_LOW = 30;
export const TIER_THRESHOLD_HIGH = 150;

export function itcTierFor(total: number): ItcTier {
  if (total < TIER_THRESHOLD_LOW) return "under_30";
  if (total < TIER_THRESHOLD_HIGH) return "under_150";
  return "over_150";
}

export type ItcInput = {
  total: number | null;
  taxAmount: number | null;
  vendorName: string | null;
  txnDate: Date | string | null;
  supplierTaxNumber: string | null;
  recipientName: string | null;
  paymentTerms: string | null;
  lineDescriptions: string[];
};

export type ItcCheck = {
  status: ItcStatus;
  tier: ItcTier | null;
  missing: ItcRequirement[];
};

function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

// 三档累进：高档包含低档的全部要件。
export function checkItc(input: ItcInput): ItcCheck {
  // 总额未知 → 连档位都定不了，无法判断，按未知处理（复核时人工补）。
  if (input.total == null) {
    return { status: "unknown", tier: null, missing: ["total"] };
  }

  const tier = itcTierFor(input.total);

  // 无税额（免税/零税供应）→ 本就没有 ITC 可抵，凭证要件不适用。
  if (input.taxAmount != null && input.taxAmount === 0) {
    return { status: "not_applicable", tier, missing: [] };
  }

  const missing: ItcRequirement[] = [];
  if (!present(input.vendorName)) missing.push("vendorName");
  if (!input.txnDate) missing.push("txnDate");

  if (tier !== "under_30") {
    if (!present(input.supplierTaxNumber)) missing.push("supplierTaxNumber");
    // 税额未知时无法确定 ITC 金额 → 视同缺失（法规要求可确定税额）
    if (input.taxAmount == null) missing.push("taxAmount");
  }

  if (tier === "over_150") {
    if (!present(input.recipientName)) missing.push("recipientName");
    if (!present(input.paymentTerms)) missing.push("paymentTerms");
    if (!input.lineDescriptions.some(present)) missing.push("lineDescriptions");
  }

  return { status: missing.length ? "incomplete" : "ok", tier, missing };
}

// 复核队列排序权重：凭证风险 > 置信度 > 金额（业务流程设计 §2.3）。
// 数值越小越靠前。
export function itcRiskRank(status: ItcStatus): number {
  switch (status) {
    case "incomplete":
      return 0;
    case "unknown":
      return 1;
    default:
      return 2;
  }
}

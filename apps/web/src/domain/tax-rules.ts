// 税码规则表 —— 契约 G10 / §4.8：税码**不由 AI 裁定**，只由确定性规则产出。
// 规则输出的是「税务处理语义」(TaxTreatment)，再经 TaxCodeCache.semanticKey 映射到
// 该客户 QBO 里真实的 TaxCode.Id —— 这层间接让同一套规则适配不同省份、不同客户的税码表。
// 未命中 → 返回 null，行 taxCode 留空并强制人工，禁止兜底猜。

import type { Province } from "./enums";

export const TAX_TREATMENTS = [
  "standard", // 该省标准可抵扣（HST，或 GST(+PST)）
  "meals_50", // 餐饮招待：仅 50% 可抵 ITC，QBO 用 group rate 拆
  "no_itc", // 有税但凭证不足以抵扣 → 税额并入费用成本
  "no_tax", // 票面无税（免税/零税/不在 GST 范围）
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  standard: "标准可抵扣",
  meals_50: "餐饮 50% 抵扣",
  no_itc: "不可抵扣（凭证不足）",
  no_tax: "无税",
};

// 各省 2026 年采购侧税率，用于校验票面税额是否合理（不用于计税——计税权威在 QBO，契约 G6）。
export const PROVINCE_TAX_RATES: Record<Province, { gstHst: number; pst: number }> = {
  AB: { gstHst: 0.05, pst: 0 },
  BC: { gstHst: 0.05, pst: 0.07 },
  MB: { gstHst: 0.05, pst: 0.07 },
  NB: { gstHst: 0.15, pst: 0 },
  NL: { gstHst: 0.15, pst: 0 },
  NS: { gstHst: 0.14, pst: 0 },
  NT: { gstHst: 0.05, pst: 0 },
  NU: { gstHst: 0.05, pst: 0 },
  ON: { gstHst: 0.13, pst: 0 },
  PE: { gstHst: 0.15, pst: 0 },
  QC: { gstHst: 0.05, pst: 0.09975 },
  SK: { gstHst: 0.05, pst: 0.06 },
  YT: { gstHst: 0.05, pst: 0 },
};

// 只有「餐饮招待」需要按科目改变税务处理（50% 限制）。其余科目的税务处理由票面事实决定。
const MEALS_KEYWORDS = ["meals", "entertainment", "restaurant", "餐饮", "招待"];

export function isMealsAccount(glAccountName: string | null | undefined): boolean {
  if (!glAccountName) return false;
  const n = glAccountName.toLowerCase();
  return MEALS_KEYWORDS.some((k) => n.includes(k));
}

export type TaxRuleInput = {
  glAccountName: string | null; // 该行的科目名（判定是否餐饮）
  docTaxAmount: number | null; // 票面税额；null = 未知
  supplierTaxNumber: string | null; // 供应商 GST/HST 登记号
  docTotal: number | null; // 票面总额（决定 $30 以下是否豁免登记号）
};

export type TaxRuleResult = {
  treatment: TaxTreatment | null; // null = 规则未命中，强制人工
  reason: string;
};

// $30 以下 CRA 不要求票面印登记号，因此缺号不视为「未登记」（§4.9 三档要求）。
const REG_NUMBER_EXEMPT_BELOW = 30;

export function resolveTaxTreatment(input: TaxRuleInput): TaxRuleResult {
  if (input.docTaxAmount == null) {
    return { treatment: null, reason: "票面税额未知，无法判定税务处理" };
  }

  if (input.docTaxAmount === 0) {
    return { treatment: "no_tax", reason: "票面无税（免税 / 零税率 / 不在 GST 范围）" };
  }

  const needsRegNumber = input.docTotal == null || input.docTotal >= REG_NUMBER_EXEMPT_BELOW;
  if (needsRegNumber && !input.supplierTaxNumber?.trim()) {
    return {
      treatment: "no_itc",
      reason: "$30 以上但无供应商 GST/HST 登记号，ITC 不可抵，税额并入费用",
    };
  }

  if (isMealsAccount(input.glAccountName)) {
    return { treatment: "meals_50", reason: "餐饮招待科目，ITC 仅 50% 可抵" };
  }

  return { treatment: "standard", reason: "标准可抵扣采购" };
}

// 票面税额是否与该省法定税率相符（±2% 容差，覆盖分项税、舍入、部分免税行）。
// 不符不阻断，只作提示 —— 真实票据混合税率的情况很常见。
export function taxRateLooksOff(
  province: Province | null,
  subTotal: number | null,
  taxAmount: number | null,
): boolean {
  if (!province || subTotal == null || taxAmount == null || subTotal <= 0) return false;
  const { gstHst, pst } = PROVINCE_TAX_RATES[province];
  const actual = taxAmount / subTotal;
  const plausible = [gstHst, gstHst + pst];
  return !plausible.some((r) => Math.abs(actual - r) <= 0.02);
}

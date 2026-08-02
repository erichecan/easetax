// 绿色通道（自动过账）准入 —— 契约 §4.10。六条**与门**，全过才自动录入。
// 与竞品（Dext 的 auto-publish 只看供应商开关）的差别：把凭证合规与置信度也做成门禁。
// 纯函数，无 IO —— 便于测试与在 UI 上解释「为什么这张没自动过」。
import type { Confidence } from "./enums";
import type { DocStatus } from "./doc-status";
import type { ItcStatus } from "./itc";

export const DEFAULT_AUTO_POST_THRESHOLD = 200;
export const MIN_RULE_CONFIRMATIONS = 3;

export const AUTO_POST_GATES = [
  "enabled",
  "rule_confirmed",
  "all_high_confidence",
  "itc_ok",
  "under_threshold",
  "not_duplicate",
  "tax_codes_resolved",
] as const;
export type AutoPostGate = (typeof AUTO_POST_GATES)[number];

export const AUTO_POST_GATE_LABELS: Record<AutoPostGate, string> = {
  enabled: "客户已开启绿色通道",
  rule_confirmed: `供应商规则人工确认过 ≥ ${MIN_RULE_CONFIRMATIONS} 次`,
  all_high_confidence: "所有行分类置信度为高",
  itc_ok: "CRA 抵扣凭证要件齐全",
  under_threshold: "金额不超过客户阈值",
  not_duplicate: "非疑似重复单据",
  tax_codes_resolved: "所有行税码由规则表命中",
};

export type AutoPostInput = {
  enabled: boolean;
  threshold: number | null; // null → 用默认 200
  status: DocStatus;
  total: number | null;
  ruleConfirmedCount: number | null; // null = 没命中供应商规则
  lineConfidences: Confidence[];
  lineTaxCodes: (string | null)[];
  itcStatus: ItcStatus;
};

export type AutoPostDecision = {
  eligible: boolean;
  failed: AutoPostGate[];
};

export function evaluateAutoPost(input: AutoPostInput): AutoPostDecision {
  const failed: AutoPostGate[] = [];

  if (!input.enabled) failed.push("enabled");
  if ((input.ruleConfirmedCount ?? 0) < MIN_RULE_CONFIRMATIONS) failed.push("rule_confirmed");
  if (!input.lineConfidences.length || !input.lineConfidences.every((c) => c === "high")) {
    failed.push("all_high_confidence");
  }
  // not_applicable = 免税单据，本就没有 ITC 可抵，凭证要件不适用 → 不构成风险，放行。
  if (input.itcStatus !== "ok" && input.itcStatus !== "not_applicable") failed.push("itc_ok");

  const threshold = input.threshold ?? DEFAULT_AUTO_POST_THRESHOLD;
  if (input.total == null || input.total > threshold) failed.push("under_threshold");

  if (input.status === "duplicate_suspected") failed.push("not_duplicate");

  // 税码只可能来自规则表（AI 不产出税码，契约 G10），所以「非空」即「规则命中」。
  if (!input.lineTaxCodes.length || input.lineTaxCodes.some((t) => !t)) failed.push("tax_codes_resolved");

  return { eligible: failed.length === 0, failed };
}

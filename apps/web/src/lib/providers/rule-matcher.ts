// 规则匹配（纯函数，DB 无关）。规则来自 ClassificationRule，由调用方查出后传入。
import type { Classification, ClassifyInput } from "./classifier";
import type { RuleMatchType } from "@/domain";

export type RuleLike = {
  matchType: RuleMatchType; // vendor | keyword
  matchValue: string;
  glAccountId: string;
  glAccountName: string;
};

// 命中第一条规则即返回 high 置信（契约 M3：规则优先）。vendor 比对供应商名，keyword 比对描述。
export function matchRule(input: ClassifyInput, rules: RuleLike[]): Classification | null {
  const vendor = (input.vendorName ?? "").toLowerCase();
  const desc = input.description.toLowerCase();
  for (const r of rules) {
    const val = r.matchValue.trim().toLowerCase();
    if (!val) continue;
    const hit = r.matchType === "vendor" ? vendor.includes(val) : desc.includes(val);
    if (hit) {
      return {
        glAccountId: r.glAccountId,
        glAccountName: r.glAccountName,
        confidence: "high",
        reason: `规则命中（${r.matchType}: ${r.matchValue}）`,
        source: "rule",
      };
    }
  }
  return null;
}

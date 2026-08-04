// 分类编排（DB 无关）：规则优先 → LLM/mock → Veryfi 文档级建议兜底。
import type { Classification, Classifier, ClassifyInput } from "./classifier";
import { matchRule, type RuleLike } from "./rule-matcher";
import { matchVendorSeed } from "./vendor-seed";
import { scoreToConfidence } from "./ocr";

export async function classifyLine(
  input: ClassifyInput,
  rules: RuleLike[],
  provider: Classifier,
): Promise<Classification> {
  // 1. 规则命中（per-client 学习，high）
  const ruled = matchRule(input, rules);
  if (ruled) return ruled;

  // 2. LLM / mock 分类器（逐行）
  const c = await provider.classify(input);
  if (c.glAccountId) return c;

  // 3. 兜底：常见商户预设种子（冷启动优先级，medium）
  const seeded = matchVendorSeed(input);
  if (seeded) return seeded;

  // 4. 兜底：Veryfi 文档级分类建议
  if (input.suggestedCategory) {
    const s = input.suggestedCategory;
    return {
      glAccountId: s.glAccountId,
      glAccountName: s.glAccountName,
      confidence: scoreToConfidence(s.score),
      reason: `Veryfi 文档级分类建议（score ${s.score.toFixed(2)}）`,
      source: "veryfi",
    };
  }

  return c;
}

// Mock 分类器：无外部依赖，按描述/供应商与候选科目名的关键词重叠打分，确定性输出。
// 密钥未配置时由 factory 选用，站位真实 LLM 路径（source 记 "llm"）。
import type { Classification, Classifier, ClassifyInput, GlAccountRef } from "./classifier";
import { NO_MATCH } from "./classifier";

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/)
    .filter((t) => t.length >= 2);
}

function scoreAccount(acctName: string, hay: string[]): number {
  const at = tokens(acctName);
  let score = 0;
  for (const t of at) if (hay.includes(t)) score++;
  return score;
}

export class MockClassifier implements Classifier {
  readonly name = "mock-classifier";

  async classify(input: ClassifyInput): Promise<Classification> {
    if (input.accounts.length === 0) return { ...NO_MATCH, reason: "无候选科目表" };

    const hay = [...tokens(input.description), ...tokens(input.vendorName ?? "")];
    let best: GlAccountRef | null = null;
    let bestScore = 0;
    for (const a of input.accounts) {
      const s = scoreAccount(a.name, hay);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }

    if (best && bestScore > 0) {
      return {
        glAccountId: best.qboAccountId,
        glAccountName: best.name,
        confidence: bestScore >= 2 ? "high" : "medium",
        reason: `mock：与科目「${best.name}」关键词重叠 ${bestScore}`,
        source: "llm",
      };
    }

    // 无重叠 → 低置信、需人工（不硬猜，契约边界优先）
    return { ...NO_MATCH, reason: "mock：描述与任何科目无关键词重叠，需人工" };
  }
}

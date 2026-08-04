// 分类器选择：有 ANTHROPIC_API_KEY 走 Claude，否则 mock（P3 密钥门控）。
import type { Classifier } from "./classifier";
import { ClaudeClassifier } from "./classifier-claude";
import { MockClassifier } from "./classifier-mock";

let cached: Classifier | null = null;

export function getClassifier(): Classifier {
  if (cached) return cached;
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    cached = new ClaudeClassifier(key);
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[classifier] ANTHROPIC_API_KEY 未配置，使用 mock 分类器");
    }
    cached = new MockClassifier();
  }
  return cached;
}

export function setClassifier(c: Classifier | null): void {
  cached = c;
}

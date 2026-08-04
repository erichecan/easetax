// OCR provider 选择：Claude 优先 → Veryfi → mock（密钥门控，DEV-PLAN §4）。
//
// Claude 排在 Veryfi 前面是因为它能直接被要求抽 CRA 凭证要件（契约 §4.9），
// 而不是靠通用字段猜；Veryfi 的试用已于 2026-08-03 到期（403），保留只为将来
// 有人续费时不用改代码。
import type { OcrProvider } from "./ocr";
import { MockOcrProvider } from "./ocr-mock";
import { ClaudeOcrProvider, claudeOcrKeyFromEnv } from "./ocr-claude";
import { VeryfiOcrProvider, veryfiCredsFromEnv } from "./ocr-veryfi";

let cached: OcrProvider | null = null;

export function getOcrProvider(): OcrProvider {
  if (cached) return cached;

  const claudeKey = claudeOcrKeyFromEnv();
  if (claudeKey) {
    cached = new ClaudeOcrProvider(claudeKey);
    return cached;
  }

  const creds = veryfiCredsFromEnv();
  if (creds) {
    cached = new VeryfiOcrProvider(creds);
    return cached;
  }

  if (process.env.NODE_ENV !== "production") {
    console.warn("[ocr] 未配置 ANTHROPIC_API_KEY 或 VERYFI_*，使用 mock OCR provider");
  }
  cached = new MockOcrProvider();
  return cached;
}

// 测试/多租户场景可注入替身。
export function setOcrProvider(p: OcrProvider | null): void {
  cached = p;
}

/** 当前识别引擎是不是真的（mock 时界面该说清楚，别让人以为在演示真识别）。 */
export function isOcrMock(): boolean {
  return getOcrProvider().name === "mock-ocr";
}

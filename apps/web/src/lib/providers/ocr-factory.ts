// OCR provider 选择：Veryfi 凭据齐全就真跑，否则 mock（P2 密钥门控）。
import type { OcrProvider } from "./ocr";
import { MockOcrProvider } from "./ocr-mock";
import { VeryfiOcrProvider, veryfiCredsFromEnv } from "./ocr-veryfi";

let cached: OcrProvider | null = null;

export function getOcrProvider(): OcrProvider {
  if (cached) return cached;
  const creds = veryfiCredsFromEnv();
  if (creds) {
    cached = new VeryfiOcrProvider(creds);
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[ocr] VERYFI_* 未配置，使用 mock OCR provider");
    }
    cached = new MockOcrProvider();
  }
  return cached;
}

// 测试/多租户场景可注入替身。
export function setOcrProvider(p: OcrProvider | null): void {
  cached = p;
}

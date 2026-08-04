// QBO provider 选择：Intuit 凭据齐全就真跑，否则 mock（P5 密钥门控，DEV-PLAN §4）。
import type { QboProvider } from "./qbo";
import { MockQboProvider } from "./qbo-mock";
import { IntuitQboProvider, intuitCredsFromEnv } from "./qbo-intuit";

let cached: QboProvider | null = null;

export function getQboProvider(): QboProvider {
  if (cached) return cached;
  const creds = intuitCredsFromEnv();
  if (creds) {
    cached = new IntuitQboProvider(creds);
  } else {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[qbo] QBO_CLIENT_ID/SECRET 未配置，使用 mock QBO provider");
    }
    cached = new MockQboProvider();
  }
  return cached;
}

export function setQboProvider(p: QboProvider | null): void {
  cached = p;
}

export function isQboMock(): boolean {
  return getQboProvider().name === "mock-qbo";
}

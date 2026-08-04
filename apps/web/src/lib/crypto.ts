// QBO refresh token 等长期凭据的静态加密（DEV-PLAN §7 风险表：明文存储不可接受）。
// AES-256-GCM，密钥只在服务端 env。密文格式：base64(iv).base64(tag).base64(cipher)。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LEN = 12;

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("缺少 TOKEN_ENCRYPTION_KEY：无法加密存储 QBO refresh token");
  // 允许任意长度口令：SHA-256 派生固定 32 字节密钥。
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("密文格式非法");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(dataB64, "base64")), d.final()]).toString("utf8");
}

export function hasEncryptionKey(): boolean {
  return Boolean(process.env.TOKEN_ENCRYPTION_KEY);
}

// 邮件入站解析（契约 §4.3 的反向：从收件地址反推 clientId）。
// 不绑定具体邮件服务商：SendGrid/Mailgun/Postmark 的 webhook 字段名各不相同，
// 这里定义一个中立的载荷形状，适配层负责把各家格式映射过来。
import { createHmac, timingSafeEqual } from "node:crypto";

export type InboundAttachment = {
  fileName: string;
  mimeType: string;
  /** base64 内容 */
  content: string;
};

export type InboundPayload = {
  to: string;
  from?: string;
  subject?: string;
  attachments?: InboundAttachment[];
};

// 收单邮箱形如 client-<clientId>@inbound.easetax.ca（契约 §4.3：clientId 原样，保留连字符）。
// 收件地址可能带显示名或 +tag，都要能剥出来。
export function clientIdFromAddress(raw: string, domain = "inbound.easetax.ca"): string | null {
  if (!raw) return null;
  // "Easetax Inbox <client-abc@inbound.easetax.ca>" → client-abc@inbound.easetax.ca
  const angled = /<([^>]+)>/.exec(raw);
  const addr = (angled ? angled[1] : raw).trim().toLowerCase();

  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const local = addr.slice(0, at);
  const host = addr.slice(at + 1);
  if (host !== domain.toLowerCase()) return null;

  // 去掉 +tag（很多邮件系统会加）
  const withoutTag = local.split("+")[0];
  if (!withoutTag.startsWith("client-")) return null;

  const clientId = withoutTag.slice("client-".length);
  return clientId || null;
}

// 多个收件人时取第一个能解析出 clientId 的（转发链里常有多个地址）
export function firstClientId(toField: string, domain?: string): string | null {
  for (const part of toField.split(",")) {
    const id = clientIdFromAddress(part, domain);
    if (id) return id;
  }
  return null;
}

// HMAC-SHA256 签名校验。webhook 是公开端点（proxy 白名单放行），
// 没有签名任何人都能往客户账上塞单据。
export function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b); // 定长比较，避免时序侧信道
}

export const INBOUND_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

// 邮件附件的 MIME 常常不可信（客户端乱标），按扩展名兜一层
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
};

export function resolveMime(fileName: string, declared: string): string {
  const normalized = declared?.split(";")[0].trim().toLowerCase();
  if (INBOUND_ALLOWED_MIME.has(normalized)) return normalized;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? normalized ?? "application/octet-stream";
}

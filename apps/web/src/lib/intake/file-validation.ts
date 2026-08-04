// P1 收单：文件校验与去重指纹（纯逻辑，服务端专用，不依赖 DB）。
import { createHash } from "node:crypto";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB（PRD M1）

// 类型白名单（PRD：PDF/JPG/PNG/HEIC）
export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);

export type UploadCandidate = {
  fileName: string;
  mimeType: string;
  size: number;
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateUpload(f: UploadCandidate): ValidationResult {
  if (!ALLOWED_MIME_TYPES.has(f.mimeType)) {
    return { ok: false, error: `不支持的文件类型：${f.mimeType}` };
  }
  if (f.size <= 0) return { ok: false, error: "空文件" };
  if (f.size > MAX_FILE_BYTES) {
    return { ok: false, error: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限` };
  }
  return { ok: true };
}

// 收单去重指纹（契约 Document @@unique([firmId, fileHash])）。
export function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

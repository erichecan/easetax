// 单据状态机 —— 全系统唯一合法 DocStatus 来源（数据契约 §4.1）。
// 任何模块、前端、mock 只能从这里导入，禁止自定义子集或别名。

export const DOC_STATUSES = [
  "received",
  "ocr_processing",
  "ocr_done",
  "classifying",
  "needs_review",
  "confirmed",
  "syncing_qbo",
  "synced",
  // 旁支
  "ocr_failed",
  "duplicate_suspected",
  "sync_failed",
  "rejected",
] as const;

export type DocStatus = (typeof DOC_STATUSES)[number];

// 合法跃迁表：key → 允许到达的下一状态集合。非法转移抛错（契约 §6 步6）。
const TRANSITIONS: Record<DocStatus, readonly DocStatus[]> = {
  received: ["ocr_processing", "duplicate_suspected", "rejected"],
  ocr_processing: ["ocr_done", "ocr_failed"],
  ocr_failed: ["ocr_processing", "rejected"], // 可重试
  ocr_done: ["classifying"],
  classifying: ["needs_review"],
  // ocr_processing：重跑（reprocess）——OCR/分类能力升级后重跑存量单据（契约 §4.1）
  needs_review: ["confirmed", "rejected", "duplicate_suspected", "ocr_processing"],
  duplicate_suspected: ["needs_review", "rejected"], // 人工判非重复可回主链
  confirmed: ["syncing_qbo", "needs_review"], // 可退回再改
  syncing_qbo: ["synced", "sync_failed"],
  sync_failed: ["syncing_qbo", "needs_review"], // 可重试
  synced: [], // 终态：QBO 成为权威（契约 G5）
  rejected: [], // 终态
};

export function canTransition(from: DocStatus, to: DocStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(from: DocStatus, to: DocStatus) {
    super(`非法状态跃迁: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

// 断言合法跃迁；调用方在通过后再落库并写 AuditLog。
export function assertTransition(from: DocStatus, to: DocStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(status: DocStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

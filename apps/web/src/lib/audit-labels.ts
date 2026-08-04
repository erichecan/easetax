// 审计动作 → 人话。审计日志是给会计师和事后追责看的，
// 直接甩 `status:ocr_done->classifying` 等于没有界面。
import { STAGE_META, stageOf, type DocStatus } from "@/domain";

export type AuditKind = "flow" | "human" | "system" | "external" | "exception";

export type AuditLabel = {
  text: string;
  kind: AuditKind;
};

const DOC_STATUS_TEXT: Record<string, string> = {
  received: "已收单",
  ocr_processing: "识别中",
  ocr_done: "识别完成",
  classifying: "分类中",
  needs_review: "待复核",
  confirmed: "已确认",
  syncing_qbo: "录入中",
  synced: "已录入 QBO",
  ocr_failed: "识别失败",
  duplicate_suspected: "疑似重复",
  sync_failed: "录入失败",
  rejected: "已退回",
};

const FIXED: Record<string, AuditLabel> = {
  ingest: { text: "收单：文件入库、指纹去重", kind: "flow" },
  reprocess: { text: "重新识别（丢弃上次结果重跑）", kind: "human" },
  "ocr:recovered_after_retry": { text: "OCR 重试后成功", kind: "system" },
  "extraction:manual_edit": { text: "人工订正抬头字段", kind: "human" },
  "line:add": { text: "人工新增行项目", kind: "human" },
  "line:delete": { text: "人工删除行项目", kind: "human" },
  auto_confirm: { text: "绿色通道自动确认（未经人工复核）", kind: "system" },
  reconfirm: { text: "重新确认", kind: "human" },
  "settlement:change": { text: "修改付款状态（决定录 Bill 还是 Purchase）", kind: "human" },
  "qbo:connected": { text: "连接 QuickBooks 成功", kind: "external" },
  "qbo:attach_failed": { text: "原件挂附件失败（单据已建，附件可补挂）", kind: "exception" },
  "tax_codes:assign": { text: "指认税码用途", kind: "human" },
  "client:create": { text: "创建客户", kind: "human" },
  "client:settings_update": { text: "修改客户设置", kind: "human" },
  "bank_txns:import": { text: "导入银行流水", kind: "human" },
  "bank_txn:match": { text: "人工裁决流水匹配", kind: "human" },
  "chase:notice": { text: "生成催票内容", kind: "human" },
  "inbound:received": { text: "收到入站邮件", kind: "external" },
  "inbound:no_attachment": { text: "入站邮件无附件", kind: "external" },
};

export function labelAudit(action: string): AuditLabel {
  const fixed = FIXED[action];
  if (fixed) return fixed;

  // status:from->to
  const m = /^status:(.+?)->(.+)$/.exec(action);
  if (m) {
    const from = DOC_STATUS_TEXT[m[1]] ?? m[1];
    const to = DOC_STATUS_TEXT[m[2]] ?? m[2];
    const stage = stageOf(m[2] as DocStatus);
    const stagePart = stage ? `第 ${STAGE_META[stage].index} 步 · ` : "";
    const kind: AuditKind = /failed|rejected|duplicate/.test(m[2]) ? "exception" : "flow";
    return { text: `${stagePart}${from} → ${to}`, kind };
  }
  return { text: action, kind: "flow" };
}

// 操作者：区分人、系统自动、外部入站
export function labelActor(userId: string): { text: string; isHuman: boolean } {
  if (userId === "system") return { text: "系统自动", isHuman: false };
  if (userId === "inbound") return { text: "邮件入站", isHuman: false };
  if (userId === "test" || userId === "restore") return { text: `脚本(${userId})`, isHuman: false };
  return { text: "会计师", isHuman: true };
}

// detail 里挑出值得显示的，避免把整块 JSON 糊到界面上
export function summarizeDetail(action: string, detail: unknown): string {
  if (!detail || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;

  const pick = (keys: string[]) =>
    keys
      .filter((k) => d[k] !== undefined && d[k] !== null && d[k] !== "")
      .map((k) => `${k}=${typeof d[k] === "object" ? JSON.stringify(d[k]) : String(d[k])}`)
      .join(" · ");

  if (action.endsWith("->rejected")) return String(d.reason ?? "");
  if (action === "extraction:manual_edit") return `改了 ${(d.fields as string[] | undefined)?.join("、") ?? ""}`;
  if (action === "bank_txns:import") return pick(["fileName", "parsed", "imported", "duplicates", "rowErrors"]);
  if (action === "inbound:received") return pick(["from", "subject", "accepted"]);
  if (action === "ocr:recovered_after_retry") return `尝试 ${d.attempts} 次后成功`;
  if (action === "chase:notice") return pick(["count", "delivered"]);
  if (action.startsWith("line:")) return pick(["description", "amount"]);
  if (action === "status:syncing_qbo->synced") return pick(["entity", "qboId", "duplicate", "attached"]);
  if (action.includes("ocr_failed")) return String(d.error ?? "").slice(0, 120);

  const s = JSON.stringify(d);
  return s === "{}" ? "" : s.slice(0, 120);
}

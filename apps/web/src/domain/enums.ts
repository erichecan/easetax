// 其余共享枚举 —— 单一来源（数据契约 G7）。

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

// 文档级 confidence 由行/字段置信度取「最差」派生（契约 §4.7），不物化在 Document 上。
export function rollupConfidence(parts: Confidence[]): Confidence {
  if (parts.includes("low")) return "low";
  if (parts.includes("medium")) return "medium";
  return "high";
}

export const DOC_SOURCES = ["email", "upload"] as const;
export type DocSource = (typeof DOC_SOURCES)[number];

export const USER_ROLES = ["accountant", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// 银行流水对账：人工/自动关联状态（契约 §4.6）。matchedDocumentId 为 canonical。
export const MATCH_STATUSES = ["unmatched", "auto", "manual", "ignored"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const RULE_MATCH_TYPES = ["vendor", "keyword"] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

// 付款状态：canonical，决定录入 QBO 时建 Purchase 还是 Bill（契约 G9）。
export const SETTLEMENTS = ["paid", "unpaid"] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

// 录入 QBO 的对象类型（契约 G9）：已付 → Purchase（冲银行/信用卡），未付 → Bill（挂 AP）。
export const QBO_ENTITIES = ["Purchase", "Bill"] as const;
export type QboEntity = (typeof QBO_ENTITIES)[number];

export function qboEntityFor(settlement: Settlement): QboEntity {
  return settlement === "paid" ? "Purchase" : "Bill";
}

// 录入后要能一键回到 QBO 里那张单据核对。QBO 的深链形如
// https://app.qbo.intuit.com/app/bill?txnId=123 （sandbox 走 sandbox. 前缀）
export function qboDeepLink(entity: string | null, qboId: string | null, sandbox = false): string | null {
  if (!qboId || !entity) return null;
  const path = entity === "Purchase" ? "expense" : "bill";
  const host = sandbox ? "https://sandbox.qbo.intuit.com" : "https://app.qbo.intuit.com";
  return `${host}/app/${path}?txnId=${encodeURIComponent(qboId)}`;
}

// 省份/地区：税码规则表的输入之一（契约 §4.8）。
export const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export type Province = (typeof PROVINCES)[number];

export const PROVINCE_NAMES: Record<Province, string> = {
  AB: "Alberta 艾伯塔",
  BC: "British Columbia 卑诗",
  MB: "Manitoba 曼尼托巴",
  NB: "New Brunswick 新不伦瑞克",
  NL: "Newfoundland and Labrador 纽芬兰",
  NS: "Nova Scotia 新斯科舍",
  NT: "Northwest Territories 西北地区",
  NU: "Nunavut 努纳武特",
  ON: "Ontario 安大略",
  PE: "Prince Edward Island 爱德华王子岛",
  QC: "Quebec 魁北克",
  SK: "Saskatchewan 萨斯喀彻温",
  YT: "Yukon 育空",
};

// 客户专属收单邮箱派生规则（契约 §4.3）：clientId 原样、保留连字符。
export function inboundEmailFor(clientId: string, domain = "inbound.easetax.ca"): string {
  return `client-${clientId}@${domain}`;
}

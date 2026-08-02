// P5 录入 QBO 抽象。上层（sync 路由）只依赖此接口；有 Intuit 凭据走真实实现，否则 mock。
// 关键裁定（契约 G9）：已付 → Purchase（直接冲银行/信用卡），未付 → Bill（挂 AP）。
// 税额一律交给 QBO 计算（契约 G6），我方只传每行的 AccountRef + TaxCodeRef + 金额。
import type { DecimalString } from "./ocr";
import type { QboEntity } from "@/domain";

export type QboConnection = {
  realmId: string;
  refreshToken: string;
};

// 换到的新 refresh token 要回写（Intuit 每次刷新都轮换），否则下次连接失效。
export type QboAccessContext = {
  realmId: string;
  accessToken: string;
  rotatedRefreshToken: string | null;
};

export type QboLine = {
  description: string;
  amount: DecimalString;
  glAccountId: string; // = QBO Account.Id
  taxCodeId: string; // = QBO TaxCode.Id
};

export type QboPostInput = {
  entity: QboEntity;
  vendorName: string;
  docNumber: string | null; // 发票号，用于 QBO 侧去重
  txnDate: string | null; // ISO yyyy-mm-dd
  dueDate: string | null;
  currency: string | null;
  lines: QboLine[];
  // Purchase（已付）必须指定资金来源账户；未提供时由 provider 用客户默认。
  paymentAccountId?: string | null;
};

export type QboPostResult = {
  entity: QboEntity;
  id: string;
  docNumber: string | null;
  duplicate: boolean; // true = QBO 里已存在同 vendor+docNumber，未重复创建
};

export type QboAttachment = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type QboAccount = { qboAccountId: string; name: string; accountType: string; accountSubType: string | null };
export type QboTaxCode = { qboTaxCodeId: string; name: string; isGroup: boolean };

export interface QboProvider {
  readonly name: string;
  /** 刷新 access token（Intuit access token 仅 1 小时，refresh token 会轮换）。 */
  connect(conn: QboConnection): Promise<QboAccessContext>;
  /** 供应商按名查，不存在则建（QBO 的 Vendor 名唯一）。 */
  findOrCreateVendor(ctx: QboAccessContext, name: string): Promise<{ id: string; name: string }>;
  /** 建 Bill 或 Purchase；内部先按 vendor+docNumber 查重（契约：QBO 侧二次去重）。 */
  post(ctx: QboAccessContext, input: QboPostInput): Promise<QboPostResult>;
  /** 原件挂成 Attachable，关联到刚建的对象。 */
  attach(ctx: QboAccessContext, entity: QboEntity, entityId: string, file: QboAttachment): Promise<void>;
  /** 同步客户科目表 / 税码表到本地 cache（契约 §4.5/§4.8）。 */
  listAccounts(ctx: QboAccessContext): Promise<QboAccount[]>;
  listTaxCodes(ctx: QboAccessContext): Promise<QboTaxCode[]>;
}

export class QboNotConnectedError extends Error {
  constructor() {
    super("该客户尚未连接 QBO");
    this.name = "QboNotConnectedError";
  }
}

// 真实 QBO 实现。API 形状依据 docs/20260707-qbo-api-录入链验证.md。
// 2026-08-03 已用真实沙箱（realmId 9341457529837142）实测通过 minorversion=75 下的
// 刷 token / 列科目 / 列税码 / 查建供应商 / 建 Bill / 挂附件 / 去重（scripts/verify-qbo.ts）。
// ⚠️ 仍未实测：**加拿大税**。沙箱是美国公司，税码只有 TAX/NON/California/Tucson，
// 没有 GST/HST —— 行级 TaxCodeRef + GlobalTaxCalculation 那套（契约 G6）要等加拿大账套才能验。
// 加拿大公司：行级 TaxCodeRef + GlobalTaxCalculation 表达税，税额交给 QBO 算（契约 G6）。
import { withRetry } from "@/lib/retry";
import type {
  QboAccessContext,
  QboAccount,
  QboAttachment,
  QboConnection,
  QboPostInput,
  QboPostResult,
  QboProvider,
  QboTaxCode,
} from "./qbo";
import type { QboEntity } from "@/domain";

const QBO_MAX_ATTEMPTS = 3;
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const MINOR_VERSION = process.env.QBO_MINOR_VERSION ?? "75";

export type IntuitCreds = { clientId: string; clientSecret: string; environment: "sandbox" | "production" };

export function intuitCredsFromEnv(): IntuitCreds | null {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const environment = process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox";
  return { clientId, clientSecret, environment };
}

function apiBase(env: IntuitCreds["environment"]): string {
  return env === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

// QBO 的 DocNumber 上限 21 字符（沙箱实测：超了报 code 2050 ValidationFault）。
// 发票号来自 OCR，长过 21 的真实存在，原样传过去就是一个会计师看不懂的 400。
//
// **保留尾部**而不是头部：发票号的区分度几乎都在尾部流水号上，
// 截头部会把 `…0000012345` 和 `…0000012346` 截成同一个值，去重就会误判成重复单。
// 完整号仍存在我方 Extraction.invoiceNo 里，审计不丢。
export const QBO_DOC_NUMBER_MAX = 21;

export function qboDocNumber(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  return s.length <= QBO_DOC_NUMBER_MAX ? s : s.slice(-QBO_DOC_NUMBER_MAX);
}

type QueryResponse<T> = { QueryResponse?: Record<string, T[] | undefined> };

export class IntuitQboProvider implements QboProvider {
  readonly name = "qbo";
  constructor(private creds: IntuitCreds) {}

  private get base(): string {
    return apiBase(this.creds.environment);
  }

  private headers(ctx: QboAccessContext): Record<string, string> {
    return {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private async call<T>(ctx: QboAccessContext, path: string, init?: RequestInit): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.base}/v3/company/${ctx.realmId}${path}${sep}minorversion=${MINOR_VERSION}`;

    // QBO 限流约 500/min/公司（DEV-PLAN §6）。429 必须**真的退避重试**，
    // 而且要尊重 Retry-After —— 自己拍一个间隔可能比对方要求的还短，等于继续打。
    const { value } = await withRetry(
      async () => {
        const res = await fetch(url, {
          ...init,
          headers: { ...this.headers(ctx), ...(init?.headers as Record<string, string> | undefined) },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const retryAfter = res.headers.get("Retry-After");
          const err = new Error(`QBO ${res.status}: ${text.slice(0, 300)}`) as Error & {
            status?: number;
            retryAfterMs?: number;
          };
          err.status = res.status;
          if (retryAfter) {
            const secs = Number(retryAfter);
            if (Number.isFinite(secs)) err.retryAfterMs = secs * 1000;
          }
          throw err;
        }
        return (await res.json()) as T;
      },
      { attempts: QBO_MAX_ATTEMPTS, respectRetryAfter: true },
    );
    return value;
  }

  private async query<T>(ctx: QboAccessContext, sql: string, entity: string): Promise<T[]> {
    const r = await this.call<QueryResponse<T>>(ctx, `/query?query=${encodeURIComponent(sql)}`);
    return r.QueryResponse?.[entity] ?? [];
  }

  // refresh token 换 access token；Intuit 每次刷新都轮换 refresh token，必须回写。
  async connect(conn: QboConnection): Promise<QboAccessContext> {
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refreshToken }),
    });
    if (!res.ok) {
      throw new Error(`QBO token 刷新失败 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    const j = (await res.json()) as { access_token: string; refresh_token?: string };
    return {
      realmId: conn.realmId,
      accessToken: j.access_token,
      rotatedRefreshToken: j.refresh_token && j.refresh_token !== conn.refreshToken ? j.refresh_token : null,
    };
  }

  async findOrCreateVendor(ctx: QboAccessContext, name: string): Promise<{ id: string; name: string }> {
    const escaped = name.replace(/'/g, "\\'");
    const found = await this.query<{ Id: string; DisplayName: string }>(
      ctx,
      `SELECT * FROM Vendor WHERE DisplayName = '${escaped}'`,
      "Vendor",
    );
    if (found[0]) return { id: found[0].Id, name: found[0].DisplayName };

    const created = await this.call<{ Vendor: { Id: string; DisplayName: string } }>(ctx, "/vendor", {
      method: "POST",
      body: JSON.stringify({ DisplayName: name }),
    });
    return { id: created.Vendor.Id, name: created.Vendor.DisplayName };
  }

  async post(ctx: QboAccessContext, input: QboPostInput): Promise<QboPostResult> {
    // 截断必须在查重之前算好，且查重与建单用同一个值 —— 分别算的话，
    // 查重查的是完整号（QBO 里根本不存在），必然查不到，去重直接失效。
    const docNumber = qboDocNumber(input.docNumber);

    // QBO 侧二次去重：QBO 不强制 DocNumber 唯一，只能自己查（验证文档 §动作 5）。
    if (docNumber) {
      const escaped = docNumber.replace(/'/g, "\\'");
      const existing = await this.query<{ Id: string; DocNumber?: string }>(
        ctx,
        `SELECT * FROM ${input.entity} WHERE DocNumber = '${escaped}'`,
        input.entity,
      );
      if (existing[0]) {
        return { entity: input.entity, id: existing[0].Id, docNumber, duplicate: true };
      }
    }

    const vendor = await this.findOrCreateVendor(ctx, input.vendorName);
    const lines = input.lines.map((l) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: Number(l.amount),
      Description: l.description.slice(0, 4000),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: l.glAccountId },
        TaxCodeRef: { value: l.taxCodeId },
      },
    }));

    const common: Record<string, unknown> = {
      Line: lines,
      // 票面金额为不含税小计时用 TaxExcluded；税额由 QBO 按 TaxCodeRef 计算（契约 G6）
      GlobalTaxCalculation: "TaxExcluded",
      ...(input.txnDate ? { TxnDate: input.txnDate } : {}),
      ...(docNumber ? { DocNumber: docNumber } : {}),
      ...(input.currency ? { CurrencyRef: { value: input.currency } } : {}),
    };

    if (input.entity === "Bill") {
      const body = {
        ...common,
        VendorRef: { value: vendor.id },
        ...(input.dueDate ? { DueDate: input.dueDate } : {}),
      };
      const r = await this.call<{ Bill: { Id: string; DocNumber?: string } }>(ctx, "/bill", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { entity: "Bill", id: r.Bill.Id, docNumber: r.Bill.DocNumber ?? docNumber, duplicate: false };
    }

    // 已付 → Purchase：必须指定资金来源账户（银行/信用卡），否则 QBO 拒收。
    if (!input.paymentAccountId) {
      throw new Error("已付单据需要先配置该客户的付款账户（银行或信用卡）才能录入 QBO");
    }
    const body = {
      ...common,
      PaymentType: "CreditCard",
      AccountRef: { value: input.paymentAccountId },
      EntityRef: { value: vendor.id, type: "Vendor" },
    };
    const r = await this.call<{ Purchase: { Id: string; DocNumber?: string } }>(ctx, "/purchase", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { entity: "Purchase", id: r.Purchase.Id, docNumber: r.Purchase.DocNumber ?? docNumber, duplicate: false };
  }

  // 原件挂 Attachable：multipart，两个 part（元数据 + 文件内容）。
  async attach(ctx: QboAccessContext, entity: QboEntity, entityId: string, file: QboAttachment): Promise<void> {
    const form = new FormData();
    form.append(
      "file_metadata_01",
      new Blob(
        [
          JSON.stringify({
            FileName: file.fileName,
            ContentType: file.mimeType,
            AttachableRef: [{ EntityRef: { type: entity, value: entityId } }],
          }),
        ],
        { type: "application/json" },
      ),
      "attachment.json",
    );
    const body = new ArrayBuffer(file.bytes.byteLength);
    new Uint8Array(body).set(file.bytes);
    form.append("file_content_01", new Blob([body], { type: file.mimeType }), file.fileName);

    const res = await fetch(`${this.base}/v3/company/${ctx.realmId}/upload?minorversion=${MINOR_VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.accessToken}`, Accept: "application/json" },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`QBO 附件上传失败 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  }

  async listAccounts(ctx: QboAccessContext): Promise<QboAccount[]> {
    const rows = await this.query<{
      Id: string;
      Name: string;
      AccountType: string;
      AccountSubType?: string;
    }>(ctx, "SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1000", "Account");
    return rows.map((a) => ({
      qboAccountId: a.Id,
      name: a.Name,
      accountType: a.AccountType,
      accountSubType: a.AccountSubType ?? null,
    }));
  }

  async listTaxCodes(ctx: QboAccessContext): Promise<QboTaxCode[]> {
    const rows = await this.query<{ Id: string; Name: string; TaxGroup?: boolean }>(
      ctx,
      "SELECT * FROM TaxCode MAXRESULTS 1000",
      "TaxCode",
    );
    return rows.map((t) => ({ qboTaxCodeId: t.Id, name: t.Name, isGroup: Boolean(t.TaxGroup) }));
  }
}

// Veryfi OCR 实现。字段映射已用真实响应核对。
// 请求带 confidence_details=true（拿字段级 score）+ categories（客户科目名，文档级分类建议）。
// ⚠️ 实测：confidence_details 下 invoice_number/date/subtotal/tax/total/currency_code/category
//    会从普通值变成 {value,score,ocr_score} 对象 → 统一用 unwrap() 解包；line_items 字段不受影响。
// 实测：categories 是「文档级」建议（line_items[].category 为 null），作分类兜底用。
import type { OcrExtraction, OcrInput, OcrLine, OcrProvider } from "./ocr";
import { scoreToConfidence } from "./ocr";

const VERYFI_URL = "https://api.veryfi.com/api/v8/partner/documents/";

type VeryfiCreds = { clientId: string; apiKey: string; username: string };

export function veryfiCredsFromEnv(): VeryfiCreds | null {
  const clientId = process.env.VERYFI_CLIENT_ID;
  const apiKey = process.env.VERYFI_API_KEY;
  const username = process.env.VERYFI_USERNAME;
  if (!clientId || !apiKey || !username) return null;
  return { clientId, apiKey, username };
}

// 金额 → decimal 字符串（契约 G1）。Veryfi 返回 number，货币值已 2dp。
function dec(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  // Veryfi date 形如 "2026-06-28 00:00:00"；取日期段。
  return v.slice(0, 10);
}

// confidence_details 开启后，标量字段变成 { value, score, ocr_score } 对象。统一解包取值。
function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>).value;
  }
  return v;
}
// 取第一个非空字符串（各字段在不同地区/文档类型下位置不同，逐个兜）。
function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    const u = unwrap(v);
    if (typeof u === "string" && u.trim()) return u.trim();
    if (typeof u === "number") return String(u);
  }
  return null;
}

function fieldScore(v: unknown): number | undefined {
  if (v && typeof v === "object" && "score" in (v as Record<string, unknown>)) {
    const s = (v as Record<string, unknown>).score;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

export class VeryfiOcrProvider implements OcrProvider {
  readonly name = "veryfi";
  constructor(private creds: VeryfiCreds) {}

  async extract(input: OcrInput): Promise<OcrExtraction> {
    const b64 = Buffer.from(input.bytes).toString("base64");
    const body: Record<string, unknown> = {
      file_name: input.fileName,
      file_data: b64,
      confidence_details: true, // 拿字段级 score（会把标量字段包成 {value,score}，见 unwrap）
    };
    if (input.categories && input.categories.length) body.categories = input.categories;
    if (input.documentType) body.document_type = input.documentType;

    const res = await fetch(VERYFI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Client-Id": this.creds.clientId,
        Authorization: `apikey ${this.creds.username}:${this.creds.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Veryfi ${res.status}: ${text.slice(0, 300)}`);
    }

    const raw = (await res.json()) as Record<string, unknown>;

    // 供应商名（vendor 恒为对象；name 在 confidence_details 下也可能是 {value,score}）。
    const vendorObj = raw.vendor as { name?: unknown } | undefined;
    const vendorName = vendorObj?.name != null ? String(unwrap(vendorObj.name)) : null;

    // 行项目字段不受 confidence_details 影响，仍是普通值。描述优先用规整版。
    const lineItemsRaw = (raw.line_items as Array<Record<string, unknown>> | undefined) ?? [];
    const lines: OcrLine[] = lineItemsRaw.map((li) => ({
      description: String(li.normalized_description ?? li.description ?? li.text ?? ""),
      quantity: dec(li.quantity) ?? undefined,
      unitPrice: dec(li.price) ?? undefined,
      amount: dec(li.total) ?? "0.00",
    }));

    // 字段级 score → fieldConfidence（真实数据，落 Extraction.fieldConfidence）。
    const fieldConfidence: Record<string, number> = {};
    for (const [k, v] of Object.entries({
      invoiceNo: raw.invoice_number,
      date: raw.date,
      subTotal: raw.subtotal,
      tax: raw.tax,
      total: raw.total,
      category: raw.category,
    })) {
      const s = fieldScore(v);
      if (s !== undefined) fieldConfidence[k] = s;
    }
    // 整体 OCR 置信度：关键字段 score 取最小值（保守）；无则 medium。
    const keyScores = [fieldConfidence.total, fieldConfidence.subTotal, fieldConfidence.date].filter(
      (n): n is number => typeof n === "number",
    );
    const overallConfidence = keyScores.length ? scoreToConfidence(Math.min(...keyScores)) : "medium";

    // 文档级分类建议（传 categories 时返回；value ∈ 客户科目名）。
    const catRaw = raw.category as { value?: unknown; score?: unknown } | string | undefined;
    let suggestedCategory: { value: string; score: number } | null = null;
    if (catRaw && typeof catRaw === "object" && catRaw.value != null) {
      suggestedCategory = {
        value: String(catRaw.value),
        score: typeof catRaw.score === "number" ? catRaw.score : 0,
      };
    } else if (typeof catRaw === "string" && catRaw) {
      suggestedCategory = { value: catRaw, score: 0 };
    }

    // CRA 凭证要件（契约 §4.9）：Veryfi 把供应商税号放在 vendor.reg_number / vat_number（视地区），
    // 购方在 bill_to.name。取不到就是 null —— 复核页据此提示"这笔 ITC 抵不了"。
    const billTo = raw.bill_to as { name?: unknown } | undefined;
    const vendorAny = raw.vendor as Record<string, unknown> | undefined;
    const supplierTaxNumber = firstString(
      vendorAny?.reg_number,
      vendorAny?.vat_number,
      raw.vat_number,
      raw.reg_number,
    );
    const paymentTerms = firstString(raw.payment_terms, (raw.payment as Record<string, unknown> | undefined)?.terms);
    const paymentType = firstString((raw.payment as Record<string, unknown> | undefined)?.type);
    const isPaid = paymentType ? !/invoice|terms|net\s*\d+/i.test(paymentType) : null;

    return {
      vendorName,
      supplierTaxNumber,
      recipientName: billTo?.name != null ? String(unwrap(billTo.name)) : null,
      paymentTerms,
      // 有付款方式（信用卡/现金等）视为已付；有账期/发票条款视为未付；判不出留给复核人。
      settlementHint: isPaid === null ? (isoDate(unwrap(raw.due_date)) ? "unpaid" : null) : isPaid ? "paid" : "unpaid",
      invoiceNo: unwrap(raw.invoice_number) != null ? String(unwrap(raw.invoice_number)) : null,
      txnDate: isoDate(unwrap(raw.date)),
      dueDate: isoDate(unwrap(raw.due_date)),
      currency: (unwrap(raw.currency_code) as string | null) ?? null,
      subTotal: dec(unwrap(raw.subtotal)),
      taxAmount: dec(unwrap(raw.tax)),
      total: dec(unwrap(raw.total)),
      lines,
      overallConfidence,
      fieldConfidence,
      suggestedCategory,
      raw,
    };
  }
}

// Claude vision OCR。相比通用 OCR 供应商的固定 schema，这里可以**直接要求**加拿大
// 抵扣凭证要件（契约 §4.9）：供应商 GST/HST/QST 登记号、购方名称、付款条款——
// Veryfi 那边只能靠 vendor.reg_number / vat_number 逐个兜底猜。
//
// 结构化输出用 output_config.format（json_schema），不是 tool use：
// 这是纯抽取任务，不需要模型"决定调不调工具"。
//
// ⚠️ 本文件的**真实 API 调用路径未经实测**——写它时环境里没有 ANTHROPIC_API_KEY。
// 纯函数部分（payload → OcrExtraction 的映射、金额规整、行项合计校验）有单测覆盖。
// 拿到 key 后第一件事：用 scripts/verify-ocr.ts 打真实单据，核对字段与成本。
import Anthropic from "@anthropic-ai/sdk";
import type { Confidence } from "@/domain";
import { scoreToConfidence, type DecimalString, type OcrExtraction, type OcrInput, type OcrProvider } from "./ocr";

// 默认 Opus 5：抽取准确率优先。成本敏感时用 ANTHROPIC_OCR_MODEL 换 claude-sonnet-5
// （约 1/2 成本）或 claude-haiku-4-5（约 1/5），换之前拿真实单据 A/B 一轮再定。
const DEFAULT_MODEL = "claude-opus-5";
// 思考默认开启且计入 max_tokens，抽取结果本身很小，余量留给思考。
const MAX_TOKENS = 16000;

const SYSTEM_PROMPT = [
  "你是加拿大记账事务所的应付账款单据抽取引擎。从发票/收据图像中抽出结构化字段。",
  "",
  "铁律：",
  "1. 只抽单据上**真实存在**的信息。看不清或没有的字段一律返回 null，绝不猜测、绝不编造。",
  "   记账场景里编造一个 GST 号比留空危害大得多——留空只是要人工补，编造会让客户抵错税。",
  "2. 金额一律用字符串，保留两位小数，不带货币符号和千分位（例：\"1234.50\"）。",
  "3. 行项目金额之和必须等于税前金额（subTotal）。单据本身对不上时，按单据原样抽取，",
  "   不要替它调平——对不上本身就是需要人工看的信号。",
  "4. 日期用 ISO 格式 yyyy-mm-dd。",
  "",
  "加拿大进项税抵扣（ITC）凭证要件，务必尽力找全：",
  "· supplierTaxNumber：供应商的 GST/HST 登记号，形如 123456789RT0001，",
  "  也可能标成 GST/HST No.、Business Number、BN、TPS/TVH（魁北克法语单据）。",
  "  魁北克单据可能另有 QST/TVQ 号（形如 1234567890TQ0001）——优先取 GST/HST 那个。",
  "· recipientName：购方（我方客户）名称，通常在 Bill To / Sold To / Ship To。",
  "· paymentTerms：付款条款，如 Net 30、Due on receipt、Paid by Visa ****1234。",
  "",
  "confidence 字段填你对该字段的把握（0–1）。字迹模糊、被遮挡、需要推断的，如实给低分。",
].join("\n");

/** 结构化输出的 schema。结构化输出要求所有属性都在 required 里、additionalProperties: false，
 *  可空字段用 ["string","null"] 这种联合类型表达。 */
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "vendorName", "invoiceNo", "txnDate", "dueDate", "currency",
    "subTotal", "taxAmount", "total",
    "supplierTaxNumber", "recipientName", "paymentTerms", "settlementHint",
    "lines", "confidence", "suggestedCategory",
  ],
  properties: {
    vendorName: { type: ["string", "null"], description: "供应商（卖方）名称" },
    invoiceNo: { type: ["string", "null"], description: "发票号 / 收据号" },
    txnDate: { type: ["string", "null"], description: "开票日期 yyyy-mm-dd" },
    dueDate: { type: ["string", "null"], description: "到期日 yyyy-mm-dd，已付单据通常没有" },
    currency: { type: ["string", "null"], description: "ISO 货币代码，如 CAD / USD" },
    subTotal: { type: ["string", "null"], description: "税前金额" },
    taxAmount: { type: ["string", "null"], description: "税额合计（GST+PST 或 HST）" },
    total: { type: ["string", "null"], description: "含税总额" },
    supplierTaxNumber: { type: ["string", "null"], description: "供应商 GST/HST 登记号，如 123456789RT0001" },
    recipientName: { type: ["string", "null"], description: "购方名称（Bill To）" },
    paymentTerms: { type: ["string", "null"], description: "付款条款" },
    settlementHint: {
      type: ["string", "null"],
      enum: ["paid", "unpaid", null],
      description: "单据显示已付款则 paid；有账期/应付则 unpaid；判断不了给 null",
    },
    lines: {
      type: "array",
      description: "行项目。单据只有一个总额时给一行。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "amount"],
        properties: {
          description: { type: "string", description: "行项目描述，保留单据原文" },
          amount: { type: "string", description: "该行税前金额" },
        },
      },
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["vendorName", "invoiceNo", "txnDate", "total", "supplierTaxNumber"],
      properties: {
        vendorName: { type: "number" },
        invoiceNo: { type: "number" },
        txnDate: { type: "number" },
        total: { type: "number" },
        supplierTaxNumber: { type: "number" },
      },
    },
    suggestedCategory: {
      type: ["string", "null"],
      description: "从候选科目名里选最贴切的一个；候选里没有合适的就给 null",
    },
  },
} as const;

type ClaudePayload = {
  vendorName: string | null;
  invoiceNo: string | null;
  txnDate: string | null;
  dueDate: string | null;
  currency: string | null;
  subTotal: string | null;
  taxAmount: string | null;
  total: string | null;
  supplierTaxNumber: string | null;
  recipientName: string | null;
  paymentTerms: string | null;
  settlementHint: "paid" | "unpaid" | null;
  lines: { description: string; amount: string }[];
  confidence: Record<string, number>;
  suggestedCategory: string | null;
};

/** 金额规整为两位小数字符串（契约 G1：跨边界不用 float）。非法值一律 null，不猜。 */
export function normalizeAmount(v: unknown): DecimalString | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

/** 行项合计是否等于税前金额。对不上不代表模型错——单据本身可能就有杂费/折扣行，
 *  但这是"需要人工看一眼"的强信号，所以据此压低整体置信度。 */
export function linesReconcile(lines: { amount: DecimalString }[], subTotal: DecimalString | null): boolean {
  if (!subTotal || !lines.length) return false;
  const sum = lines.reduce((acc, l) => acc + Math.round(Number(l.amount) * 100), 0);
  return sum === Math.round(Number(subTotal) * 100);
}

/** payload → OcrExtraction。纯函数，单测覆盖，不碰网络。 */
export function toOcrExtraction(payload: ClaudePayload, raw: unknown, categories?: string[]): OcrExtraction {
  const lines = (payload.lines ?? [])
    .map((l) => ({ description: String(l.description ?? "").trim(), amount: normalizeAmount(l.amount) }))
    .filter((l): l is { description: string; amount: DecimalString } => l.amount !== null);

  const subTotal = normalizeAmount(payload.subTotal);
  const fieldConfidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(payload.confidence ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) fieldConfidence[k] = v;
  }

  const keyScores = [fieldConfidence.total, fieldConfidence.txnDate, fieldConfidence.vendorName].filter(
    (n): n is number => typeof n === "number",
  );
  let overallConfidence: Confidence = keyScores.length ? scoreToConfidence(Math.min(...keyScores)) : "medium";
  // 行项对不上税前金额 → 压到 low，强制进人工复核
  if (!linesReconcile(lines, subTotal)) overallConfidence = "low";

  // 只接受确实在候选科目表里的建议——模型可能返回一个近似但不存在的科目名
  const suggested =
    payload.suggestedCategory && categories?.includes(payload.suggestedCategory)
      ? { value: payload.suggestedCategory, score: fieldConfidence.vendorName ?? 0.5 }
      : null;

  return {
    vendorName: payload.vendorName?.trim() || null,
    invoiceNo: payload.invoiceNo?.trim() || null,
    txnDate: normalizeDate(payload.txnDate),
    dueDate: normalizeDate(payload.dueDate),
    currency: payload.currency?.trim().toUpperCase() || null,
    subTotal,
    taxAmount: normalizeAmount(payload.taxAmount),
    total: normalizeAmount(payload.total),
    supplierTaxNumber: payload.supplierTaxNumber?.trim() || null,
    recipientName: payload.recipientName?.trim() || null,
    paymentTerms: payload.paymentTerms?.trim() || null,
    settlementHint: payload.settlementHint === "paid" || payload.settlementHint === "unpaid" ? payload.settlementHint : null,
    lines,
    overallConfidence,
    fieldConfidence,
    suggestedCategory: suggested,
    raw,
  };
}

/** PDF 走 document 块，图片走 image 块 —— 类型不匹配 API 会直接 400。 */
export function contentBlockFor(bytes: Uint8Array, mimeType: string): Anthropic.ContentBlockParam {
  const data = Buffer.from(bytes).toString("base64");
  if (mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  const mt = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  return {
    type: "image",
    source: { type: "base64", media_type: mt as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data },
  };
}

export class ClaudeOcrProvider implements OcrProvider {
  readonly name = "claude-ocr";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = process.env.ANTHROPIC_OCR_MODEL ?? DEFAULT_MODEL) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async extract(input: OcrInput): Promise<OcrExtraction> {
    const hint = input.categories?.length
      ? `\n\n该客户的会计科目表（suggestedCategory 只能从中选，或给 null）：\n${input.categories.map((c) => `· ${c}`).join("\n")}`
      : "";

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown> } },
      messages: [
        {
          role: "user",
          content: [
            contentBlockFor(input.bytes, input.mimeType),
            { type: "text", text: `抽取这张单据的字段。文件名：${input.fileName}${hint}` },
          ],
        },
      ],
    });

    // 安全分类器可能拒答（HTTP 200 + stop_reason=refusal），此时 content 是空的，
    // 直接读 content[0] 会抛一个看不懂的错。
    if (res.stop_reason === "refusal") {
      throw new Error("Claude 拒绝处理该单据（安全分类器），需人工识别");
    }
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!text) throw new Error("Claude 未返回文本内容");

    let payload: ClaudePayload;
    try {
      payload = JSON.parse(text) as ClaudePayload;
    } catch {
      throw new Error(`Claude 返回的不是合法 JSON：${text.slice(0, 200)}`);
    }

    return toOcrExtraction(payload, { provider: "claude", model: this.model, usage: res.usage, payload }, input.categories);
  }
}

export function claudeOcrKeyFromEnv(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

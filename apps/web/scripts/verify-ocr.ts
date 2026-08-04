// 用 app 自己的 ClaudeOcrProvider 打一张真实单据（不是平行实现）——
// 这个脚本过了，就等于 app 的识别路径过了。
//
// 跑：npm run verify:ocr -- <单据文件路径>
//     npm run verify:ocr -- ~/Desktop/invoice.pdf
//
// 需要 .env 里有 ANTHROPIC_API_KEY。可选 ANTHROPIC_OCR_MODEL 换模型做 A/B。
//
// 为什么要有这个脚本：单测只覆盖了 payload → OcrExtraction 的纯函数映射，
// 真实 API 的行为（schema 是否被遵守、PDF 块能不能读、GST 号找不找得到、
// 一张单据到底多少钱）只能拿真单据打一次才知道。
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { ClaudeOcrProvider, claudeOcrKeyFromEnv } from "@/lib/providers/ocr-claude";
import { checkItc } from "@/domain";

// 与 app 上传白名单保持一致
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// 一套典型加拿大小企业科目，用来实测 suggestedCategory 是否只从候选里选
const CATEGORIES = [
  "Office Supplies 办公用品",
  "Telephone & Internet 电话网络",
  "Meals & Entertainment 餐饮招待",
  "Software & Subscriptions 软件订阅",
  "Utilities 水电杂费",
  "Vehicle & Fuel 汽车油费",
  "Repairs & Maintenance 维修保养",
  "Supplies & Materials 材料耗材",
  "Cost of Goods Sold 销货成本",
  "General Expenses 一般费用",
];

// 每百万 token 单价（用于估算单张成本；改模型时一并更新）
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("用法：npm run verify:ocr -- <单据文件路径>");
    process.exit(1);
  }

  const key = claudeOcrKeyFromEnv();
  if (!key) {
    console.error("❌ .env 里没有 ANTHROPIC_API_KEY —— 识别引擎仍会退回 mock");
    process.exit(1);
  }

  const ext = extname(path).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    console.error(`❌ 不支持的文件类型 ${ext}，可用：${Object.keys(MIME_BY_EXT).join(" / ")}`);
    process.exit(1);
  }

  const bytes = new Uint8Array(readFileSync(path));
  const model = process.env.ANTHROPIC_OCR_MODEL ?? "claude-opus-5";
  console.log(`📄 ${basename(path)}  (${(bytes.byteLength / 1024).toFixed(0)} KB, ${mimeType})`);
  console.log(`🤖 模型 ${model}\n`);

  const started = Date.now();
  const e = await new ClaudeOcrProvider(key).extract({
    bytes,
    fileName: basename(path),
    mimeType,
    categories: CATEGORIES,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log("── 抬头 ──");
  console.log(`  供应商      ${e.vendorName ?? "—"}`);
  console.log(`  发票号      ${e.invoiceNo ?? "—"}`);
  console.log(`  开票 / 到期 ${e.txnDate ?? "—"} / ${e.dueDate ?? "—"}`);
  console.log(`  金额        税前 ${e.subTotal ?? "—"} + 税 ${e.taxAmount ?? "—"} = ${e.total ?? "—"} ${e.currency ?? ""}`);
  console.log(`  付款状态    ${e.settlementHint ?? "判断不了（交人工）"}`);

  console.log("\n── CRA 抵扣凭证要件（契约 §4.9）──");
  console.log(`  供应商 GST/HST 号  ${e.supplierTaxNumber ?? "❌ 没找到"}`);
  console.log(`  购方名称           ${e.recipientName ?? "❌ 没找到"}`);
  console.log(`  付款条款           ${e.paymentTerms ?? "❌ 没找到"}`);

  const itc = checkItc({
    total: e.total == null ? null : Number(e.total),
    taxAmount: e.taxAmount == null ? null : Number(e.taxAmount),
    vendorName: e.vendorName,
    txnDate: e.txnDate ? new Date(e.txnDate) : null,
    supplierTaxNumber: e.supplierTaxNumber,
    recipientName: e.recipientName,
    paymentTerms: e.paymentTerms,
    lineDescriptions: e.lines.map((l) => l.description),
  });
  console.log(`  → ITC 判定：${itc.status}${itc.missing?.length ? `（缺 ${itc.missing.join("、")}）` : ""}`);

  console.log("\n── 行项目 ──");
  for (const l of e.lines) console.log(`  ${l.amount.padStart(10)}  ${l.description}`);
  const sum = e.lines.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0) / 100;
  const ok = e.subTotal != null && Math.abs(sum - Number(e.subTotal)) < 0.005;
  console.log(`  合计 ${sum.toFixed(2)} ${ok ? "✅ 与税前金额一致" : "⚠️ 与税前金额对不上（会被压成 low 强制人工）"}`);

  console.log("\n── 置信度 ──");
  console.log(`  整体 ${e.overallConfidence}`);
  for (const [k, v] of Object.entries(e.fieldConfidence)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`  科目建议 ${e.suggestedCategory ? `${e.suggestedCategory.value}（${e.suggestedCategory.score}）` : "无"}`);

  const raw = e.raw as { usage?: { input_tokens?: number; output_tokens?: number } };
  const u = raw?.usage;
  if (u?.input_tokens != null && u?.output_tokens != null) {
    const p = PRICING[model];
    const cost = p ? (u.input_tokens * p.input + u.output_tokens * p.output) / 1_000_000 : null;
    console.log("\n── 成本与耗时 ──");
    console.log(`  token 入/出 ${u.input_tokens} / ${u.output_tokens}   耗时 ${elapsed}s`);
    if (cost != null) console.log(`  本张约 $${cost.toFixed(4)}  →  1000 张约 $${(cost * 1000).toFixed(2)}`);
    else console.log(`  （${model} 不在本脚本的价目表里，自行按官网单价换算）`);
  }
}

main().catch((e) => {
  console.error("\n❌ 识别失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});

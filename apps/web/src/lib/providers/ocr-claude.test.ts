import { test } from "node:test";
import assert from "node:assert/strict";
import { contentBlockFor, linesReconcile, normalizeAmount, toOcrExtraction } from "./ocr-claude";

// 一份"模型返回得很好"的基准 payload，各用例在它上面改一处。
function payload(over: Record<string, unknown> = {}) {
  return {
    vendorName: "Staples Canada",
    invoiceNo: "STA-10021",
    txnDate: "2026-07-14",
    dueDate: null,
    currency: "cad",
    subTotal: "100.00",
    taxAmount: "13.00",
    total: "113.00",
    supplierTaxNumber: "123456789RT0001",
    recipientName: "Maple Leaf Dental",
    paymentTerms: "Paid by Visa",
    settlementHint: "paid" as const,
    lines: [{ description: "Office supplies", amount: "60.00" }, { description: "Toner", amount: "40.00" }],
    confidence: { vendorName: 0.96, invoiceNo: 0.93, txnDate: 0.95, total: 0.97, supplierTaxNumber: 0.9 },
    suggestedCategory: "Office Supplies 办公用品",
    ...over,
  };
}

test("normalizeAmount：剥掉货币符号与千分位，统一两位小数", () => {
  assert.equal(normalizeAmount("$1,234.5"), "1234.50");
  assert.equal(normalizeAmount("  42 "), "42.00");
  assert.equal(normalizeAmount(113), "113.00");
});

test("normalizeAmount：认不出的一律 null，绝不猜一个数出来", () => {
  // 记账场景里编一个金额比留空危害大得多
  assert.equal(normalizeAmount("N/A"), null);
  assert.equal(normalizeAmount(""), null);
  assert.equal(normalizeAmount(null), null);
  assert.equal(normalizeAmount(undefined), null);
});

test("linesReconcile：按分比较，避免浮点误差把对得上的判成对不上", () => {
  assert.equal(linesReconcile([{ amount: "0.10" }, { amount: "0.20" }], "0.30"), true);
  assert.equal(linesReconcile([{ amount: "60.00" }, { amount: "40.01" }], "100.00"), false);
  assert.equal(linesReconcile([], "100.00"), false);
  assert.equal(linesReconcile([{ amount: "1.00" }], null), false);
});

test("行项合计对得上 + 高分 → high，货币被规范成大写", () => {
  const e = toOcrExtraction(payload(), {}, ["Office Supplies 办公用品"]);
  assert.equal(e.overallConfidence, "high");
  assert.equal(e.currency, "CAD");
  assert.equal(e.total, "113.00");
  assert.equal(e.lines.length, 2);
});

test("行项合计对不上税前金额 → 压到 low，强制进人工复核", () => {
  // 模型分数再高也不算数：对不上本身就是要人看一眼的信号
  const e = toOcrExtraction(payload({ lines: [{ description: "x", amount: "60.00" }] }), {});
  assert.equal(e.overallConfidence, "low");
});

test("关键字段分数低 → 整体降级（取 total/date/vendor 的最小值）", () => {
  const e = toOcrExtraction(
    payload({ confidence: { vendorName: 0.4, invoiceNo: 0.9, txnDate: 0.95, total: 0.97, supplierTaxNumber: 0.9 } }),
    {},
  );
  assert.equal(e.overallConfidence, "low");
});

test("缺 GST 号照实留 null —— 后续 ITC 检查据此判定抵不了", () => {
  const e = toOcrExtraction(payload({ supplierTaxNumber: null }), {});
  assert.equal(e.supplierTaxNumber, null);
});

test("空字符串字段按缺失处理，不要把 '' 当成有值存进库", () => {
  const e = toOcrExtraction(payload({ vendorName: "   ", invoiceNo: "" }), {});
  assert.equal(e.vendorName, null);
  assert.equal(e.invoiceNo, null);
});

test("suggestedCategory 不在候选科目表里就丢弃", () => {
  // 模型可能返回一个语义接近但客户科目表里并不存在的名字，直接采信会造出假科目
  const e = toOcrExtraction(payload({ suggestedCategory: "Office Expenses" }), {}, ["Office Supplies 办公用品"]);
  assert.equal(e.suggestedCategory, null);

  const ok = toOcrExtraction(payload(), {}, ["Office Supplies 办公用品"]);
  assert.equal(ok.suggestedCategory?.value, "Office Supplies 办公用品");
});

test("没传候选科目表时不采信任何建议", () => {
  const e = toOcrExtraction(payload(), {});
  assert.equal(e.suggestedCategory, null);
});

test("非法日期不进库（只接受 yyyy-mm-dd）", () => {
  assert.equal(toOcrExtraction(payload({ txnDate: "July 14, 2026" }), {}).txnDate, null);
  assert.equal(toOcrExtraction(payload({ txnDate: "2026-07-14T00:00:00Z" }), {}).txnDate, "2026-07-14");
});

test("settlementHint 只接受 paid/unpaid，其余归 null 交人工定", () => {
  assert.equal(toOcrExtraction(payload({ settlementHint: "maybe" }), {}).settlementHint, null);
  assert.equal(toOcrExtraction(payload({ settlementHint: null }), {}).settlementHint, null);
  assert.equal(toOcrExtraction(payload({ settlementHint: "unpaid" }), {}).settlementHint, "unpaid");
});

test("金额无法解析的行被丢掉，不会污染合计", () => {
  const e = toOcrExtraction(payload({ lines: [{ description: "good", amount: "100.00" }, { description: "bad", amount: "TBD" }] }), {});
  assert.equal(e.lines.length, 1);
  assert.equal(e.overallConfidence, "high"); // 剩下这行正好等于 subTotal
});

test("PDF 走 document 块、图片走 image 块（类型错 API 直接 400）", () => {
  const bytes = new TextEncoder().encode("x");
  const pdf = contentBlockFor(bytes, "application/pdf");
  assert.equal(pdf.type, "document");

  const png = contentBlockFor(bytes, "image/png");
  assert.equal(png.type, "image");

  // image/jpg 不是合法 media_type，必须规范成 image/jpeg
  const jpg = contentBlockFor(bytes, "image/jpg");
  assert.equal(jpg.type, "image");
  assert.equal((jpg as { source: { media_type: string } }).source.media_type, "image/jpeg");
});

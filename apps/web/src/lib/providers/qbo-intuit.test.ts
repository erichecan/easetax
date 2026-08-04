import { test } from "node:test";
import assert from "node:assert/strict";
import { qboDocNumber, QBO_DOC_NUMBER_MAX } from "./qbo-intuit";

test("21 字符以内原样保留", () => {
  assert.equal(qboDocNumber("INV-001"), "INV-001");
  assert.equal(qboDocNumber("A".repeat(QBO_DOC_NUMBER_MAX)), "A".repeat(QBO_DOC_NUMBER_MAX));
});

test("超长发票号截到 21 字符（沙箱实测上限，超了 QBO 报 code 2050）", () => {
  const raw = "EASETAX-VERIFY-2026-08-03"; // 25 字符，就是实测里炸掉的那个
  assert.equal(raw.length, 25);
  assert.equal(qboDocNumber(raw), "TAX-VERIFY-2026-08-03");
});

test("保留尾部：只差尾号的两张发票截断后仍然不同（截头部会把它们混成一张）", () => {
  const a = qboDocNumber("SUPPLIER-INVOICE-0000012345");
  const b = qboDocNumber("SUPPLIER-INVOICE-0000012346");
  assert.notEqual(a, b);
  assert.equal(a?.length, QBO_DOC_NUMBER_MAX);
  // 反证：若截头部，这两个会相同
  assert.equal(
    "SUPPLIER-INVOICE-0000012345".slice(0, QBO_DOC_NUMBER_MAX),
    "SUPPLIER-INVOICE-0000012346".slice(0, QBO_DOC_NUMBER_MAX),
  );
});

test("空值与纯空白当作没有发票号", () => {
  assert.equal(qboDocNumber(null), null);
  assert.equal(qboDocNumber(""), null);
  assert.equal(qboDocNumber("   "), null);
});

test("前后空白被去掉后才判长度", () => {
  assert.equal(qboDocNumber("  INV-002  "), "INV-002");
});

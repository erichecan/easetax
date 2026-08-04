import { test } from "node:test";
import assert from "node:assert/strict";
import { checkItc, itcRiskRank, itcTierFor, type ItcInput } from "./itc";

const FULL: ItcInput = {
  total: 200,
  taxAmount: 26,
  vendorName: "Staples Canada",
  txnDate: new Date("2026-06-28"),
  supplierTaxNumber: "123456789RT0001",
  recipientName: "Maple Leaf Dental",
  paymentTerms: "Net 30",
  lineDescriptions: ["HP 碳粉盒"],
};

test("档位按票面总额划分", () => {
  assert.equal(itcTierFor(29.99), "under_30");
  assert.equal(itcTierFor(30), "under_150");
  assert.equal(itcTierFor(149.99), "under_150");
  assert.equal(itcTierFor(150), "over_150");
});

test("要件齐全 → ok", () => {
  assert.deepEqual(checkItc(FULL), { status: "ok", tier: "over_150", missing: [] });
});

test("$30 以下只要三项，缺 GST 号也 ok", () => {
  const r = checkItc({ ...FULL, total: 20, taxAmount: 2.6, supplierTaxNumber: null, recipientName: null, paymentTerms: null });
  assert.equal(r.status, "ok");
  assert.equal(r.tier, "under_30");
});

test("$30–150 缺供应商 GST 号 → incomplete", () => {
  const r = checkItc({ ...FULL, total: 100, taxAmount: 13, supplierTaxNumber: null });
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.missing, ["supplierTaxNumber"]);
});

test("$30–150 税额未知 → 缺税额（无法确定 ITC 金额）", () => {
  const r = checkItc({ ...FULL, total: 100, taxAmount: null });
  assert.equal(r.status, "incomplete");
  assert.ok(r.missing.includes("taxAmount"));
});

test("$150 以上还要购方名、付款条款、行描述", () => {
  const r = checkItc({ ...FULL, recipientName: null, paymentTerms: null, lineDescriptions: [] });
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.missing, ["recipientName", "paymentTerms", "lineDescriptions"]);
});

test("免税/零税（税额为 0）→ 不适用，不报缺件", () => {
  const r = checkItc({ ...FULL, taxAmount: 0, supplierTaxNumber: null, recipientName: null, paymentTerms: null });
  assert.equal(r.status, "not_applicable");
  assert.deepEqual(r.missing, []);
});

test("总额未知 → unknown，档位判不了", () => {
  const r = checkItc({ ...FULL, total: null });
  assert.equal(r.status, "unknown");
  assert.equal(r.tier, null);
});

test("空白字符串不算已填", () => {
  const r = checkItc({ ...FULL, total: 100, supplierTaxNumber: "   " });
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.missing, ["supplierTaxNumber"]);
});

test("排序权重：缺件最优先，其次未知，达标垫底", () => {
  assert.ok(itcRiskRank("incomplete") < itcRiskRank("unknown"));
  assert.ok(itcRiskRank("unknown") < itcRiskRank("ok"));
  assert.equal(itcRiskRank("ok"), itcRiskRank("not_applicable"));
});

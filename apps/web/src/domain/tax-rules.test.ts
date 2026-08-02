import { test } from "node:test";
import assert from "node:assert/strict";
import { isMealsAccount, resolveTaxTreatment, taxRateLooksOff, type TaxRuleInput } from "./tax-rules";

const BASE: TaxRuleInput = {
  glAccountName: "Office Supplies 办公用品",
  docTaxAmount: 13,
  supplierTaxNumber: "123456789RT0001",
  docTotal: 113,
};

test("标准可抵扣采购", () => {
  assert.equal(resolveTaxTreatment(BASE).treatment, "standard");
});

test("餐饮科目 → 50% 抵扣", () => {
  assert.equal(
    resolveTaxTreatment({ ...BASE, glAccountName: "Meals & Entertainment 餐饮招待" }).treatment,
    "meals_50",
  );
});

test("票面无税 → no_tax，不看科目也不看登记号", () => {
  const r = resolveTaxTreatment({ ...BASE, docTaxAmount: 0, supplierTaxNumber: null });
  assert.equal(r.treatment, "no_tax");
});

test("$30 以上无供应商登记号 → 不可抵扣", () => {
  assert.equal(resolveTaxTreatment({ ...BASE, supplierTaxNumber: null }).treatment, "no_itc");
});

test("$30 以下无登记号仍可抵（CRA 不要求票面印号）", () => {
  const r = resolveTaxTreatment({ ...BASE, docTotal: 22, docTaxAmount: 2.5, supplierTaxNumber: null });
  assert.equal(r.treatment, "standard");
});

test("不可抵扣优先于餐饮 50%（先看能不能抵，再看抵多少）", () => {
  const r = resolveTaxTreatment({
    ...BASE,
    glAccountName: "Meals & Entertainment 餐饮招待",
    supplierTaxNumber: null,
  });
  assert.equal(r.treatment, "no_itc");
});

test("税额未知 → 不命中，强制人工（禁止兜底猜）", () => {
  const r = resolveTaxTreatment({ ...BASE, docTaxAmount: null });
  assert.equal(r.treatment, null);
  assert.match(r.reason, /未知/);
});

test("总额未知且无登记号 → 按需要登记号处理", () => {
  const r = resolveTaxTreatment({ ...BASE, docTotal: null, supplierTaxNumber: null });
  assert.equal(r.treatment, "no_itc");
});

test("科目名识别餐饮：中英文都认，其他科目不误判", () => {
  assert.ok(isMealsAccount("Meals & Entertainment"));
  assert.ok(isMealsAccount("餐饮招待"));
  assert.ok(!isMealsAccount("Office Supplies 办公用品"));
  assert.ok(!isMealsAccount(null));
});

test("税率校验：安大略 13% 合理，异常比例报警", () => {
  assert.equal(taxRateLooksOff("ON", 100, 13), false);
  assert.equal(taxRateLooksOff("ON", 100, 40), true);
  assert.equal(taxRateLooksOff("BC", 100, 12), false); // GST 5 + PST 7
  assert.equal(taxRateLooksOff("BC", 100, 5), false); // 仅 GST 也合理
  assert.equal(taxRateLooksOff(null, 100, 40), false); // 省份未设不报警
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAutoPost, type AutoPostInput } from "./auto-post";

const PASSING: AutoPostInput = {
  enabled: true,
  threshold: 200,
  status: "needs_review",
  total: 113,
  ruleConfirmedCount: 3,
  lineConfidences: ["high", "high"],
  lineTaxCodes: ["4", "4"],
  itcStatus: "ok",
};

test("六条全过 → 放行", () => {
  assert.deepEqual(evaluateAutoPost(PASSING), { eligible: true, failed: [] });
});

test("客户没开绿色通道 → 拦下", () => {
  const r = evaluateAutoPost({ ...PASSING, enabled: false });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.failed, ["enabled"]);
});

test("规则确认次数不足 3 次 → 拦下", () => {
  assert.deepEqual(evaluateAutoPost({ ...PASSING, ruleConfirmedCount: 2 }).failed, ["rule_confirmed"]);
  assert.deepEqual(evaluateAutoPost({ ...PASSING, ruleConfirmedCount: null }).failed, ["rule_confirmed"]);
});

test("任一行置信度不是 high → 拦下", () => {
  assert.deepEqual(evaluateAutoPost({ ...PASSING, lineConfidences: ["high", "medium"] }).failed, [
    "all_high_confidence",
  ]);
});

test("没有行项目 → 拦下（空单不能自动过）", () => {
  const r = evaluateAutoPost({ ...PASSING, lineConfidences: [], lineTaxCodes: [] });
  assert.equal(r.eligible, false);
  assert.ok(r.failed.includes("all_high_confidence"));
  assert.ok(r.failed.includes("tax_codes_resolved"));
});

test("凭证缺件 → 拦下", () => {
  assert.deepEqual(evaluateAutoPost({ ...PASSING, itcStatus: "incomplete" }).failed, ["itc_ok"]);
});

test("免税单据（not_applicable）不算风险 → 放行", () => {
  assert.equal(evaluateAutoPost({ ...PASSING, itcStatus: "not_applicable" }).eligible, true);
});

test("超过客户阈值 → 拦下；总额未知也拦下", () => {
  assert.deepEqual(evaluateAutoPost({ ...PASSING, total: 201 }).failed, ["under_threshold"]);
  assert.deepEqual(evaluateAutoPost({ ...PASSING, total: null }).failed, ["under_threshold"]);
});

test("阈值未设时用默认 200", () => {
  assert.equal(evaluateAutoPost({ ...PASSING, threshold: null, total: 199 }).eligible, true);
  assert.equal(evaluateAutoPost({ ...PASSING, threshold: null, total: 201 }).eligible, false);
});

test("疑似重复 → 拦下", () => {
  assert.deepEqual(evaluateAutoPost({ ...PASSING, status: "duplicate_suspected" }).failed, ["not_duplicate"]);
});

test("有行没税码 → 拦下", () => {
  assert.deepEqual(evaluateAutoPost({ ...PASSING, lineTaxCodes: ["4", null] }).failed, ["tax_codes_resolved"]);
});

test("多条不满足时全部列出，便于向会计师解释", () => {
  const r = evaluateAutoPost({
    ...PASSING,
    enabled: false,
    ruleConfirmedCount: 0,
    itcStatus: "incomplete",
    total: 999,
  });
  assert.deepEqual(r.failed, ["enabled", "rule_confirmed", "itc_ok", "under_threshold"]);
});

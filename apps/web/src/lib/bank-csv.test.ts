import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, parseBankCsv, parseCsvLines, parseDate, txnFingerprint } from "./bank-csv";

test("CSV 解析：引号包裹、引号内逗号、双引号转义", () => {
  const rows = parseCsvLines('a,b\n"x, y","he said ""hi"""');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x, y", 'he said "hi"'],
  ]);
});

test("CSV 解析：去 BOM、跳过空行、兼容 CRLF", () => {
  const rows = parseCsvLines('﻿date,amount\r\n2026-01-01,10\r\n\r\n');
  assert.deepEqual(rows, [
    ["date", "amount"],
    ["2026-01-01", "10"],
  ]);
});

test("日期：ISO / 北美 mm-dd-yyyy / dd-MMM-yyyy", () => {
  assert.equal(parseDate("2026-06-28")?.toISOString().slice(0, 10), "2026-06-28");
  assert.equal(parseDate("06/28/2026")?.toISOString().slice(0, 10), "2026-06-28");
  assert.equal(parseDate("28-Jun-2026")?.toISOString().slice(0, 10), "2026-06-28");
});

test("日期：非法值返回 null，不返回 Invalid Date", () => {
  assert.equal(parseDate("2026-13-45"), null);
  assert.equal(parseDate("not a date"), null);
  assert.equal(parseDate(""), null);
});

test("金额：货币符号、千分位、括号负数、负号", () => {
  assert.equal(parseAmount("$1,234.56"), 1234.56);
  assert.equal(parseAmount("(123.45)"), -123.45);
  assert.equal(parseAmount("-99.00"), -99);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount(""), null);
});

const SINGLE_COL = `Date,Description,Amount
2026-06-28,"STAPLES CANADA #88",-279.68
2026-06-29,PAYROLL DEPOSIT,3000.00
2026-06-30,"TIM HORTONS #4021",-18.40`;

test("单金额列：只收支出，收入行跳过且不算错误", () => {
  const r = parseBankCsv(SINGLE_COL);
  assert.equal(r.rows.length, 2);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(
    r.rows.map((x) => x.amount),
    [279.68, 18.4],
  );
});

test("借贷分列：取借方为支出", () => {
  const r = parseBankCsv(`Transaction Date,Details,Withdrawals,Deposits
2026-06-28,STAPLES,279.68,
2026-06-29,SALARY,,3000.00`);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].description, "STAPLES");
  assert.equal(r.rows[0].amount, 279.68);
});

test("列名同义词：中文表头也认", () => {
  const r = parseBankCsv(`日期,摘要,金额\n2026-06-28,办公用品,-100.00`);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].description, "办公用品");
});

test("表头缺列：明确报出缺什么与实际表头，不静默返回空", () => {
  const r = parseBankCsv(`foo,bar\n1,2`);
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0].reason, /表头缺少/);
  assert.match(r.errors[0].reason, /实际表头/);
});

test("坏行逐行报错但不中断后续解析", () => {
  const r = parseBankCsv(`Date,Description,Amount
2026-06-28,GOOD ONE,-10.00
BAD DATE,X,-1.00
2026-06-29,,-2.00
2026-06-30,BAD AMOUNT,abc
2026-07-01,GOOD TWO,-20.00`);
  assert.equal(r.rows.length, 2);
  assert.equal(r.errors.length, 3);
  assert.deepEqual(
    r.errors.map((e) => e.line),
    [3, 4, 5],
  );
});

test("空文件返回错误而不是崩溃", () => {
  const r = parseBankCsv("");
  assert.equal(r.rows.length, 0);
  assert.ok(r.errors.length > 0);
});

test("识别到的列名回传，便于人工确认解析对不对", () => {
  const r = parseBankCsv(SINGLE_COL);
  assert.equal(r.detected.date, "Date");
  assert.equal(r.detected.description, "Description");
  assert.equal(r.detected.amount, "Amount");
});

test("指纹：日期+摘要+金额相同即重复，大小写与空格不敏感", () => {
  const a = { date: new Date("2026-06-28"), description: "Staples ", amount: 279.68 };
  const b = { date: new Date("2026-06-28"), description: "STAPLES", amount: 279.68 };
  assert.equal(txnFingerprint("c1", a), txnFingerprint("c1", b));
});

test("指纹：不同客户不互相冲突", () => {
  const t = { date: new Date("2026-06-28"), description: "X", amount: 1 };
  assert.notEqual(txnFingerprint("c1", t), txnFingerprint("c2", t));
});

test("金额为 0 的行不计入（既非支出也非收入）", () => {
  const r = parseBankCsv(`Date,Description,Amount\n2026-06-28,ZERO,0.00`);
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 0);
});

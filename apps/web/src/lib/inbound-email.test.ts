import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { clientIdFromAddress, firstClientId, resolveMime, verifySignature } from "./inbound-email";

test("从收件地址解析 clientId：clientId 原样保留连字符（契约 §4.3）", () => {
  assert.equal(clientIdFromAddress("client-client-demo@inbound.easetax.ca"), "client-demo");
  assert.equal(clientIdFromAddress("client-abc123@inbound.easetax.ca"), "abc123");
});

test("带显示名与大小写的地址也能解析", () => {
  assert.equal(clientIdFromAddress("Easetax <Client-Demo1@Inbound.Easetax.CA>"), "demo1");
});

test("+tag 被剥掉", () => {
  assert.equal(clientIdFromAddress("client-abc+invoices@inbound.easetax.ca"), "abc");
});

test("非本域、非 client- 前缀、无 @ 一律返回 null", () => {
  assert.equal(clientIdFromAddress("client-abc@evil.com"), null);
  assert.equal(clientIdFromAddress("support@inbound.easetax.ca"), null);
  assert.equal(clientIdFromAddress("garbage"), null);
  assert.equal(clientIdFromAddress(""), null);
});

test("空 clientId（client-@…）不通过", () => {
  assert.equal(clientIdFromAddress("client-@inbound.easetax.ca"), null);
});

test("多收件人取第一个可解析的", () => {
  assert.equal(
    firstClientId("someone@else.com, client-target@inbound.easetax.ca"),
    "target",
  );
  assert.equal(firstClientId("a@b.com, c@d.com"), null);
});

const SECRET = "test-secret";
const BODY = '{"to":"client-x@inbound.easetax.ca"}';
const SIG = createHmac("sha256", SECRET).update(BODY).digest("hex");

test("签名正确即通过", () => {
  assert.equal(verifySignature(BODY, SIG, SECRET), true);
});

test("签名错误 / 缺失 / 被篡改的 body 一律不通过", () => {
  assert.equal(verifySignature(BODY, "deadbeef", SECRET), false);
  assert.equal(verifySignature(BODY, null, SECRET), false);
  assert.equal(verifySignature(BODY + " ", SIG, SECRET), false);
  assert.equal(verifySignature(BODY, SIG, "wrong-secret"), false);
});

test("签名大小写与空白不敏感", () => {
  assert.equal(verifySignature(BODY, `  ${SIG.toUpperCase()}  `, SECRET), true);
});

test("MIME 以扩展名兜底（邮件客户端常乱标 octet-stream）", () => {
  assert.equal(resolveMime("invoice.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(resolveMime("photo.HEIC", "application/octet-stream"), "image/heic");
  assert.equal(resolveMime("scan.jpg", "image/jpeg"), "image/jpeg");
});

test("MIME 带参数时取主类型", () => {
  assert.equal(resolveMime("a.pdf", "application/pdf; charset=binary"), "application/pdf");
});

test("未知类型原样返回，由上层白名单拦截", () => {
  assert.equal(resolveMime("virus.exe", "application/x-msdownload"), "application/x-msdownload");
});

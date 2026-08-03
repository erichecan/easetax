import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResendNotifyProvider,
  DraftOnlyNotifyProvider,
  type NoticeInput,
  type NotifyProvider,
} from "./notify";

const INPUT: NoticeInput = {
  to: "owner@client.ca",
  subject: "【易账】示例 — 3 笔支出待补收据",
  body: "正文",
  replyTo: "client-abc@inbound.easetax.ca",
};

const noSleep = async () => {};

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("没配通道时只出草稿，不假装已发送", async () => {
  const p: NotifyProvider = new DraftOnlyNotifyProvider(); // 顺带确认它仍满足接口
  const r = await p.send(INPUT);
  assert.equal(r.delivered, false);
  assert.equal(r.providerId, null);
  assert.equal(r.error, undefined);
});

test("Resend 成功：返回 providerId，并把 replyTo 传成 reply_to", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { id: "re_123" } }]);
  const p = new ResendNotifyProvider({ apiKey: "k", from: "易账 <noreply@easetax.ca>", fetchImpl: impl });

  const r = await p.send(INPUT);
  assert.deepEqual(r, { delivered: true, providerId: "re_123" });
  assert.equal(calls.length, 1);

  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent.to, ["owner@client.ca"]);
  assert.equal(sent.from, "易账 <noreply@easetax.ca>");
  assert.equal(sent.text, "正文");
  assert.equal(sent.reply_to, "client-abc@inbound.easetax.ca");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer k");
});

test("没有 replyTo 时不带 reply_to 字段（不发空串给 Resend）", async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { id: "re_1" } }]);
  const p = new ResendNotifyProvider({ apiKey: "k", from: "f@x.ca", fetchImpl: impl });

  await p.send({ to: "a@b.ca", subject: "s", body: "b" });
  assert.equal("reply_to" in JSON.parse(String(calls[0].init.body)), false);
});

test("429 先重试；重试成功后仍算已发送", async () => {
  const { impl, calls } = fakeFetch([
    { status: 429, body: { message: "rate limit" }, headers: { "retry-after": "1" } },
    { status: 200, body: { id: "re_after_retry" } },
  ]);
  const p = new ResendNotifyProvider({ apiKey: "k", from: "f@x.ca", fetchImpl: impl, sleep: noSleep });

  const r = await p.send(INPUT);
  assert.equal(r.delivered, true);
  assert.equal(r.providerId, "re_after_retry");
  assert.equal(calls.length, 2);
});

test("发送失败降级成草稿，不抛错、不假装成功，且带回可读原因", async () => {
  const { impl } = fakeFetch([{ status: 500, body: { message: "boom" } }]);
  const p = new ResendNotifyProvider({ apiKey: "k", from: "f@x.ca", fetchImpl: impl, sleep: noSleep });

  const r = await p.send(INPUT);
  assert.equal(r.delivered, false);
  assert.equal(r.providerId, null);
  assert.match(String(r.error), /Resend 500/);
  assert.match(String(r.error), /boom/);
});

test("403（发件域名没验证）不重试——重试多少次都一样", async () => {
  const { impl, calls } = fakeFetch([{ status: 403, body: { message: "domain is not verified" } }]);
  const p = new ResendNotifyProvider({ apiKey: "k", from: "f@x.ca", fetchImpl: impl, sleep: noSleep });

  const r = await p.send(INPUT);
  assert.equal(r.delivered, false);
  assert.equal(calls.length, 1);
  assert.match(String(r.error), /domain is not verified/);
});

test("网络异常同样降级为草稿", async () => {
  const impl = (async () => {
    throw new Error("fetch failed");
  }) as unknown as typeof fetch;
  const p = new ResendNotifyProvider({ apiKey: "k", from: "f@x.ca", fetchImpl: impl, sleep: noSleep });

  const r = await p.send(INPUT);
  assert.equal(r.delivered, false);
  assert.match(String(r.error), /fetch failed/);
});

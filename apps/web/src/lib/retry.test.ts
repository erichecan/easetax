import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, isRetryable, retryAfterMsOf, withRetry } from "./retry";

const noSleep = async () => {};

test("可重试：5xx / 429 / 408（含消息里带状态码的形式）", () => {
  assert.equal(isRetryable(new Error("Veryfi 503: service unavailable")), true);
  assert.equal(isRetryable(new Error("QBO 429 retry-after=30")), true);
  assert.equal(isRetryable({ status: 500 }), true);
  assert.equal(isRetryable({ status: 429 }), true);
});

test("可重试：网络层错误", () => {
  assert.equal(isRetryable(new Error("fetch failed")), true);
  assert.equal(isRetryable(new Error("connect ETIMEDOUT 1.2.3.4:443")), true);
  assert.equal(isRetryable(new Error("socket hang up")), true);
});

test("不可重试：4xx 业务错误 —— 重试多少次都一样", () => {
  assert.equal(isRetryable(new Error("Veryfi 403: You trial has ended")), false);
  assert.equal(isRetryable({ status: 401 }), false);
  assert.equal(isRetryable(new Error("不支持的文件类型")), false);
  assert.equal(isRetryable(null), false);
});

test("成功时不重试，attempts=1", async () => {
  let calls = 0;
  const r = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    { sleep: noSleep },
  );
  assert.equal(r.value, "ok");
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
});

test("可重试错误：重试到成功，报告实际尝试次数", async () => {
  let calls = 0;
  const r = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("Veryfi 503: temporarily down");
      return "recovered";
    },
    { attempts: 3, sleep: noSleep },
  );
  assert.equal(r.value, "recovered");
  assert.equal(r.attempts, 3);
});

test("耗尽次数后抛最后一个错误", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("Veryfi 500: always down");
      },
      { attempts: 3, sleep: noSleep },
    ),
    /always down/,
  );
  assert.equal(calls, 3);
});

test("不可重试错误只调用一次就抛出（不浪费外部额度）", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("Veryfi 403: You trial has ended");
      },
      { attempts: 5, sleep: noSleep },
    ),
    /trial has ended/,
  );
  assert.equal(calls, 1);
});

test("退避递增且不超过上限", () => {
  const d1 = backoffDelay(1, 500, 8000);
  const d2 = backoffDelay(2, 500, 8000);
  const d3 = backoffDelay(3, 500, 8000);
  assert.ok(d1 < d2 && d2 < d3, `应递增：${d1} ${d2} ${d3}`);
  assert.ok(backoffDelay(10, 500, 8000) <= 8000);
});

test("onRetry 回调报告每次重试的轮次与延迟", async () => {
  const seen: number[] = [];
  await assert.rejects(
    withRetry(async () => { throw new Error("503"); }, {
      attempts: 3,
      sleep: noSleep,
      onRetry: ({ attempt, delayMs }) => {
        seen.push(attempt);
        assert.ok(delayMs > 0);
      },
    }),
  );
  assert.deepEqual(seen, [1, 2]); // 第 3 次失败后直接抛，不再回调
});

test("respectRetryAfter：服务端说等多久就等多久，不用自己算的退避", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls === 1) {
        const e = new Error("QBO 429: rate limited") as Error & { status: number; retryAfterMs: number };
        e.status = 429;
        e.retryAfterMs = 30_000; // 服务端要求等 30s，远大于本地退避
        throw e;
      }
      return "ok";
    },
    { attempts: 3, respectRetryAfter: true, sleep: async (ms) => void waits.push(ms) },
  );
  assert.deepEqual(waits, [30_000]);
});

test("不开 respectRetryAfter 时仍用本地退避", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls === 1) {
        const e = new Error("QBO 429") as Error & { retryAfterMs: number };
        e.retryAfterMs = 30_000;
        throw e;
      }
      return "ok";
    },
    { attempts: 3, sleep: async (ms) => void waits.push(ms) },
  );
  assert.ok(waits[0] < 5_000, `应使用本地退避而非 30s，实际 ${waits[0]}`);
});

test("retryAfterMsOf：只接受正数", () => {
  assert.equal(retryAfterMsOf({ retryAfterMs: 5000 }), 5000);
  assert.equal(retryAfterMsOf({ retryAfterMs: 0 }), null);
  assert.equal(retryAfterMsOf({ retryAfterMs: "abc" }), null);
  assert.equal(retryAfterMsOf(new Error("x")), null);
});

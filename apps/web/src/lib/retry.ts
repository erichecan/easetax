// 外部调用重试（DEV-PLAN §6：外部调用重试+退避+状态落库，失败可重放）。
// 关键判断是**什么错该重试**：网络抖动和 5xx/429 值得重试，
// 401/403/400 重试多少次都一样，只会拖长上传响应、浪费额度。

export type RetryOptions = {
  attempts?: number; // 总尝试次数（含第一次）
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 注入用：默认真实 sleep，测试里换成立即返回 */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** 错误上带 retryAfterMs 时优先用它——服务端说等多久就等多久，自己拍的间隔可能更短 */
  respectRetryAfter?: boolean;
};

// 服务端明确要求的等待时间（QBO/Intuit 的 429 会带 Retry-After）
export function retryAfterMsOf(err: unknown): number | null {
  if (err && typeof err === "object" && "retryAfterMs" in err) {
    const v = Number((err as { retryAfterMs: unknown }).retryAfterMs);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export type RetryOutcome<T> = {
  value: T;
  attempts: number; // 实际尝试了几次
};

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 从错误里认出「值得再试一次」的信号。provider 抛的是 Error(`Veryfi 503: ...`)
// 这类字符串，所以既看 status 字段也看消息文本。
export function isRetryable(err: unknown): boolean {
  if (err == null) return false;

  const status =
    typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : NaN;
  if (Number.isFinite(status)) {
    return status === 408 || status === 429 || status >= 500;
  }

  const msg = err instanceof Error ? err.message : String(err);
  // HTTP 状态码出现在消息里（provider 的抛错格式）
  if (/\b(5\d{2}|429|408)\b/.test(msg)) return true;
  // 网络层错误
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|timeout/i.test(msg)) return true;
  return false;
}

// 指数退避 + 抖动。抖动避免多个并发请求在同一时刻重试打爆对方。
// 抖动**只向下**：向上抖会突破 max 上限（曾算出 8400 > 8000），
// 而上限存在的意义就是「最长等这么久」。
export function backoffDelay(attempt: number, base: number, max: number, jitter = 0.25): number {
  const raw = Math.min(max, base * 2 ** (attempt - 1));
  // 确定性抖动（按 attempt 派生），避免 Math.random 让测试不稳定
  const factor = 1 - (jitter * ((attempt * 37) % 100)) / 100;
  return Math.min(max, Math.round(raw * factor));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<RetryOutcome<T>> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const sleep = opts.sleep ?? DEFAULT_SLEEP;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt };
    } catch (err) {
      lastErr = err;
      // 不可重试的错误立刻抛，不浪费时间与外部额度
      if (!isRetryable(err) || attempt === attempts) throw err;
      const serverAsked = opts.respectRetryAfter ? retryAfterMsOf(err) : null;
      const delayMs = serverAsked ?? backoffDelay(attempt, base, max);
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

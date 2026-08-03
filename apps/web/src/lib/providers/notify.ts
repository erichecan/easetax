// 通知 provider 抽象（F6 追票）。没配邮件通道时用 mock：只生成内容不真发，
// 会计师可以复制出来自己发 —— 比"假装发送成功"诚实。
import { withRetry } from "@/lib/retry";

export type NoticeInput = {
  to: string;
  subject: string;
  body: string;
  /** 催票信设为客户收单邮箱：客户点「回复」带上票据照片，直接落进入站管道（契约 §4.13） */
  replyTo?: string;
};

export type NoticeResult = {
  delivered: boolean; // false = 只生成未发送
  providerId: string | null;
  /** 发送失败时的人话原因。有值即表示「本来要发但没发成」，与"没配通道"区分开 */
  error?: string;
};

export interface NotifyProvider {
  readonly name: string;
  send(input: NoticeInput): Promise<NoticeResult>;
}

// 不真发：把内容原样交回 UI，由人工转发。
export class DraftOnlyNotifyProvider implements NotifyProvider {
  readonly name = "draft-only";
  async send(): Promise<NoticeResult> {
    return { delivered: false, providerId: null };
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

type ResendOptions = {
  apiKey: string;
  from: string;
  /** 注入用：测试里换成假 fetch */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

// Resend 出站。发送失败**不抛给上层**——催票是"顺手做的事"，
// 不该因为邮件服务商抖动就让整个催票动作失败；降级成草稿并把原因带回去，
// 会计师看到原因后可以自己转发或稍后重试。
export class ResendNotifyProvider implements NotifyProvider {
  readonly name = "resend";
  private readonly opts: ResendOptions;

  constructor(opts: ResendOptions) {
    this.opts = opts;
  }

  async send(input: NoticeInput): Promise<NoticeResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const outcome = await withRetry(
        async () => {
          const res = await doFetch(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.opts.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              from: this.opts.from,
              to: [input.to],
              subject: input.subject,
              text: input.body, // 催票内容是纯文本（buildChaseDraft 产出），不做 HTML 转义风险
              ...(input.replyTo ? { reply_to: input.replyTo } : {}),
            }),
          });

          if (!res.ok) {
            throw Object.assign(new Error(`Resend ${res.status}: ${await readError(res)}`), {
              status: res.status,
              retryAfterMs: retryAfterMs(res),
            });
          }
          const json = (await res.json().catch(() => ({}))) as { id?: string };
          return json.id ?? null;
        },
        { attempts: 3, respectRetryAfter: true, sleep: this.opts.sleep },
      );

      return { delivered: true, providerId: outcome.value };
    } catch (err) {
      return {
        delivered: false,
        providerId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { message?: string; error?: string };
    return j.message ?? j.error ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

let cached: NotifyProvider | null = null;

export function getNotifyProvider(): NotifyProvider {
  if (cached) return cached;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  // 两个都齐才算配好：只有 key 没有已验证的发件人地址，Resend 会 403，
  // 那还不如老老实实出草稿。
  cached = apiKey && from ? new ResendNotifyProvider({ apiKey, from }) : new DraftOnlyNotifyProvider();
  return cached;
}

export function setNotifyProvider(p: NotifyProvider | null): void {
  cached = p;
}

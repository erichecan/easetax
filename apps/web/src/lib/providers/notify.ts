// 通知 provider 抽象（F6 追票）。没配邮件通道时用 mock：只生成内容不真发，
// 会计师可以复制出来自己发 —— 比"假装发送成功"诚实。
export type NoticeInput = {
  to: string;
  subject: string;
  body: string;
};

export type NoticeResult = {
  delivered: boolean; // false = 只生成未发送
  providerId: string | null;
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

let cached: NotifyProvider | null = null;

export function getNotifyProvider(): NotifyProvider {
  if (cached) return cached;
  // TODO(F6+)：配 RESEND_API_KEY / SMTP 后在此分支出真实实现，接口不变。
  cached = new DraftOnlyNotifyProvider();
  return cached;
}

export function setNotifyProvider(p: NotifyProvider | null): void {
  cached = p;
}

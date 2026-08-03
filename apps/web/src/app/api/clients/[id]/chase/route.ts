import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getClient, getReconciliation } from "@/lib/queries";
import { buildChaseDraft } from "@/lib/chase";
import { getNotifyProvider } from "@/lib/providers/notify";

// 追票：按当前缺收据清单生成催票内容 → 发送（或仅生成草稿）→ 落 ChaseNotice。
// body.txnIds 可选：不传就催全部缺票流水。
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const client = await getClient(s.firmId, id);
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { txnIds?: string[]; recipient?: string };
  const { rows, period } = await getReconciliation(s.firmId, id);

  const wanted = body.txnIds?.length ? new Set(body.txnIds.map(String)) : null;
  const target = rows.filter((r) => r.matchKind === "none" && (!wanted || wanted.has(r.txn.id)));
  if (!target.length) {
    return Response.json({ error: "没有需要追票的流水（都已匹配或已标记无需收据）" }, { status: 400 });
  }

  const draft = buildChaseDraft(client.name, target, period);
  // 收件人：优先请求指定，否则用客户联系人邮箱。
  // ⛔ 契约 §4.13：绝不回退到 inboundEmail —— 那是收单机器人地址，
  // 催票寄过去客户永远收不到，还会触发一次无附件的入站解析。
  const recipient = body.recipient?.trim() || client.contactEmail?.trim();
  if (!recipient) {
    return Response.json(
      { error: "该客户还没有联系人邮箱，请先到「客户设置」填写后再催票" },
      { status: 400 },
    );
  }

  const notifier = getNotifyProvider();
  const sent = await notifier.send({
    to: recipient,
    subject: draft.subject,
    body: draft.body,
    replyTo: client.inboundEmail, // 客户回复时带上票据即自动入账
  });

  await prisma.chaseNotice.createMany({
    data: draft.txnIds.map((bankTxnId) => ({
      firmId: s.firmId,
      clientId: id,
      bankTxnId,
      channel: sent.delivered ? "email" : "manual",
      recipient,
      subject: draft.subject,
      body: draft.body,
      sentAt: sent.delivered ? new Date() : null,
      sentBy: s.userId,
    })),
  });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "chase:notice",
      detail: {
        clientId: id,
        count: draft.txnIds.length,
        delivered: sent.delivered,
        provider: notifier.name,
        ...(sent.error ? { sendError: sent.error } : {}),
      } as Prisma.InputJsonValue,
    },
  });

  return Response.json({
    ok: true,
    delivered: sent.delivered,
    // 配了通道却没发出去：UI 要说清楚原因，不能和"本来就只出草稿"混为一谈
    sendError: sent.error ?? null,
    count: draft.txnIds.length,
    recipient,
    subject: draft.subject,
    body: draft.body,
  });
}

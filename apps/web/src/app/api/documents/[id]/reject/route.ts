import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { assertTransition, type DocStatus } from "@/domain";

// 退回：不该入账的单据（重复件、私人消费、根本不是发票）要能出队，
// 否则它们永远堵在待复核里，让「④ 复核」的数字失真。
// rejected 是终态（契约 §4.1），所以必须留下原因 —— 事后问起来要答得上。
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = String(body.reason ?? "").trim();
  if (!reason) return Response.json({ error: "退回必须填写原因" }, { status: 400 });
  if (reason.length > 500) return Response.json({ error: "原因过长" }, { status: 400 });

  const doc = await prisma.document.findFirst({ where: { id, firmId: s.firmId } });
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });

  try {
    assertTransition(doc.status as DocStatus, "rejected");
  } catch {
    return Response.json({ error: `当前状态「${doc.status}」不可退回` }, { status: 409 });
  }

  await prisma.document.update({ where: { id }, data: { status: "rejected" } });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: id,
      action: `status:${doc.status}->rejected`,
      detail: { reason } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, status: "rejected" });
}

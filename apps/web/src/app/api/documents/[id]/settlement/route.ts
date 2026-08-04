import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { SETTLEMENTS, qboEntityFor, type Settlement } from "@/domain";

// 改付款状态（契约 G9）：canonical 在本地，OCR 给初值、会计师最终裁定。
// synced 之后 QBO 是权威（契约 G5），本地不再可改。
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { settlement?: string };
  const settlement = body.settlement as Settlement | undefined;
  if (!settlement || !SETTLEMENTS.includes(settlement)) {
    return Response.json({ error: "settlement 必须是 paid 或 unpaid" }, { status: 400 });
  }

  const doc = await prisma.document.findFirst({ where: { id, firmId: s.firmId } });
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });
  if (doc.status === "synced") {
    return Response.json({ error: "已录入 QBO 的单据不可修改，请到 QBO 里改" }, { status: 409 });
  }

  await prisma.document.update({ where: { id }, data: { settlement } });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: id,
      action: "settlement:change",
      detail: { from: doc.settlement, to: settlement } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, settlement, qboEntity: qboEntityFor(settlement) });
}

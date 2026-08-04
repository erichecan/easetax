import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

// 手工增删行项目。OCR 会漏行也会多切行，没有这条路，行合计对不上票面时只能干看着。
// 契约 G5：synced 后不可改。新增行的置信度固定 high —— 人填的就是权威。

type AddBody = { description?: string; amount?: string | number; glAccountId?: string | null; taxCode?: string | null };

async function loadDoc(id: string, firmId: string) {
  return prisma.document.findFirst({ where: { id, firmId }, select: { id: true, status: true, clientId: true } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const doc = await loadDoc(id, s.firmId);
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });
  if (doc.status === "synced") {
    return Response.json({ error: "已录入 QBO 的单据不可修改，请到 QBO 里改" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as AddBody;
  const description = String(body.description ?? "").trim();
  if (!description) return Response.json({ error: "行描述不能为空" }, { status: 400 });

  const amount = Number(body.amount);
  if (!Number.isFinite(amount)) return Response.json({ error: "金额格式非法" }, { status: 400 });

  // 科目与税码若传了就校验存在性，避免写入该客户不存在的 id
  if (body.glAccountId) {
    const acct = await prisma.glAccountCache.findFirst({
      where: { clientId: doc.clientId, qboAccountId: body.glAccountId },
    });
    if (!acct) return Response.json({ error: "科目不存在" }, { status: 400 });
  }
  if (body.taxCode) {
    const tax = await prisma.taxCodeCache.findFirst({
      where: { clientId: doc.clientId, qboTaxCodeId: body.taxCode },
    });
    if (!tax) return Response.json({ error: "税码不存在" }, { status: 400 });
  }

  const acctName = body.glAccountId
    ? (await prisma.glAccountCache.findFirst({ where: { clientId: doc.clientId, qboAccountId: body.glAccountId } }))
        ?.name ?? null
    : null;

  const line = await prisma.lineItem.create({
    data: {
      documentId: id,
      description,
      amount: new Prisma.Decimal(amount.toFixed(2)),
      glAccountId: body.glAccountId ?? null,
      glAccountName: acctName,
      taxCode: body.taxCode ?? null,
      confidence: "high", // 人工新增的行不需要再被机器质疑
    },
  });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: id,
      action: "line:add",
      detail: { lineId: line.id, description, amount: amount.toFixed(2) } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, lineId: line.id });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const doc = await loadDoc(id, s.firmId);
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });
  if (doc.status === "synced") {
    return Response.json({ error: "已录入 QBO 的单据不可修改，请到 QBO 里改" }, { status: 409 });
  }

  const lineId = new URL(req.url).searchParams.get("lineId");
  if (!lineId) return Response.json({ error: "缺少 lineId" }, { status: 400 });

  // 行必须属于这张单据 —— 否则可以跨单据删行
  const line = await prisma.lineItem.findFirst({ where: { id: lineId, documentId: id } });
  if (!line) return Response.json({ error: "行不存在" }, { status: 404 });

  await prisma.lineItem.delete({ where: { id: lineId } });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: id,
      action: "line:delete",
      detail: { lineId, description: line.description, amount: line.amount.toString() } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true });
}

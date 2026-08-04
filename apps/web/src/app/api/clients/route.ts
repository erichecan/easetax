import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { inboundEmailFor, PROVINCES, type Province } from "@/domain";

type Body = { name?: string; industry?: string; province?: string; taxNumber?: string };

// 建客户。inboundEmail 由 clientId 按契约 §4.3 派生后**存下来**——
// 它是对外地址，一旦发给客户就不能因为改 id 而变（契约明写：email 稳定性优先）。
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const name = String(body.name ?? "").trim();
  if (!name) return Response.json({ error: "客户名称不能为空" }, { status: 400 });
  if (name.length > 120) return Response.json({ error: "客户名称过长" }, { status: 400 });

  const province = body.province?.trim() || null;
  if (province && !PROVINCES.includes(province as Province)) {
    return Response.json({ error: "省份代码不合法" }, { status: 400 });
  }

  // 同一记账公司内重名会让会计师选错客户 —— 单据一旦记到错的客户账上很难发现
  const dup = await prisma.client.findFirst({ where: { firmId: s.firmId, name } });
  if (dup) return Response.json({ error: `已存在同名客户「${name}」` }, { status: 409 });

  // 自己生成 id 而不用 @default(cuid())：inboundEmail 要由 id 派生，
  // 必须在 create 之前就知道 id，否则得先建后改、email 有一瞬间是空的。
  const id = `client_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  const client = await prisma.client.create({
    data: {
      id,
      firmId: s.firmId,
      name,
      industry: body.industry?.trim() || null,
      province,
      taxNumber: body.taxNumber?.trim() || null,
      inboundEmail: inboundEmailFor(id),
    },
  });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "client:create",
      detail: { clientId: client.id, name } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, clientId: client.id, inboundEmail: client.inboundEmail });
}

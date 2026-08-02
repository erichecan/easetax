import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { TAX_TREATMENTS, type TaxTreatment } from "@/domain";

// 把客户 QBO 里的税码指认到规则表的语义（契约 §4.8 的「桥」）。
// 系统不猜哪个税码是什么用途（G10），必须人工指认一次 —— 不指认，
// 规则表算出的 treatment 就映射不到任何实际税码，所有行税码留空。

type Body = { assignments?: { qboTaxCodeId: string; semanticKey: string | null }[] };

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const client = await prisma.client.findFirst({ where: { id, firmId: s.firmId } });
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];
  if (!assignments.length) return Response.json({ error: "没有要更新的税码" }, { status: 400 });

  for (const a of assignments) {
    if (a.semanticKey && !TAX_TREATMENTS.includes(a.semanticKey as TaxTreatment)) {
      return Response.json({ error: `未知的税务处理：${a.semanticKey}` }, { status: 400 });
    }
  }

  // 一个语义键只能指给一个税码，否则规则表映射出二义性
  const used = new Map<string, string>();
  for (const a of assignments) {
    if (!a.semanticKey) continue;
    const prev = used.get(a.semanticKey);
    if (prev) {
      return Response.json(
        { error: `「${a.semanticKey}」被指认给了多个税码，请只留一个` },
        { status: 400 },
      );
    }
    used.set(a.semanticKey, a.qboTaxCodeId);
  }

  const owned = await prisma.taxCodeCache.findMany({
    where: { clientId: id, qboTaxCodeId: { in: assignments.map((a) => a.qboTaxCodeId) } },
    select: { qboTaxCodeId: true },
  });
  const ownedIds = new Set(owned.map((o) => o.qboTaxCodeId));
  const foreign = assignments.filter((a) => !ownedIds.has(a.qboTaxCodeId));
  if (foreign.length) {
    return Response.json({ error: "包含不属于该客户的税码" }, { status: 400 });
  }

  await prisma.$transaction(
    assignments.map((a) =>
      prisma.taxCodeCache.update({
        where: { clientId_qboTaxCodeId: { clientId: id, qboTaxCodeId: a.qboTaxCodeId } },
        data: { semanticKey: a.semanticKey || null },
      }),
    ),
  );
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "tax_codes:assign",
      detail: { clientId: id, assignments } as unknown as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, assigned: used.size });
}

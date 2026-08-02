import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PROVINCES, type Province } from "@/domain";

type Body = {
  province?: string | null;
  taxNumber?: string | null;
  qboPaymentAccountId?: string | null;
  autoPostEnabled?: boolean;
  autoPostThreshold?: number | string | null;
};

// 客户配置：税码规则输入（省份/税号）+ 绿色通道开关与阈值 + 已付单据的付款账户。
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const client = await prisma.client.findFirst({ where: { id, firmId: s.firmId } });
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const data: Prisma.ClientUpdateInput = {};

  if ("province" in body) {
    const p = body.province?.trim() || null;
    if (p && !PROVINCES.includes(p as Province)) {
      return Response.json({ error: "省份代码不合法" }, { status: 400 });
    }
    data.province = p;
  }
  if ("taxNumber" in body) data.taxNumber = body.taxNumber?.trim() || null;
  if ("qboPaymentAccountId" in body) data.qboPaymentAccountId = body.qboPaymentAccountId?.trim() || null;
  if ("autoPostEnabled" in body) data.autoPostEnabled = Boolean(body.autoPostEnabled);
  if ("autoPostThreshold" in body) {
    const raw = body.autoPostThreshold;
    if (raw == null || raw === "") {
      data.autoPostThreshold = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        return Response.json({ error: "自动过账阈值必须是正数" }, { status: 400 });
      }
      data.autoPostThreshold = new Prisma.Decimal(n.toFixed(2));
    }
  }

  if (!Object.keys(data).length) return Response.json({ error: "没有要更新的字段" }, { status: 400 });

  await prisma.client.update({ where: { id }, data });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "client:settings_update",
      detail: { clientId: id, fields: Object.keys(data) } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true });
}

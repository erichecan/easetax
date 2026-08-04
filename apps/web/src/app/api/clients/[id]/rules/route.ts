import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { RULE_MATCH_TYPES, type RuleMatchType } from "@/domain";

// 分类规则的增删改。规则此前只能靠确认时自动学习产生，学错了没法改 ——
// 而规则优先级最高（业务流程设计 §2.3），一条错规则会持续污染后续所有单据。

type CreateBody = { matchType?: string; matchValue?: string; glAccountId?: string };
type UpdateBody = { id?: string; glAccountId?: string; matchValue?: string };

async function assertClient(clientId: string, firmId: string) {
  return prisma.client.findFirst({ where: { id: clientId, firmId } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  if (!(await assertClient(id, s.firmId))) return Response.json({ error: "客户不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as CreateBody;
  const matchType = body.matchType as RuleMatchType | undefined;
  if (!matchType || !RULE_MATCH_TYPES.includes(matchType)) {
    return Response.json({ error: `matchType 必须是 ${RULE_MATCH_TYPES.join(" / ")}` }, { status: 400 });
  }
  const matchValue = String(body.matchValue ?? "").trim();
  if (!matchValue) return Response.json({ error: "匹配值不能为空" }, { status: 400 });

  const acct = await prisma.glAccountCache.findFirst({
    where: { clientId: id, qboAccountId: String(body.glAccountId ?? "") },
  });
  if (!acct) return Response.json({ error: "科目不存在" }, { status: 400 });

  // 同类型同值的规则只应有一条，否则命中顺序不确定
  const dup = await prisma.classificationRule.findFirst({
    where: { firmId: s.firmId, clientId: id, matchType, matchValue },
  });
  if (dup) return Response.json({ error: `已存在针对「${matchValue}」的${matchType === "vendor" ? "供应商" : "关键词"}规则` }, { status: 409 });

  const rule = await prisma.classificationRule.create({
    data: {
      firmId: s.firmId,
      clientId: id,
      matchType,
      matchValue,
      glAccountId: acct.qboAccountId,
      glAccountName: acct.name,
      // 人工建的规则不算「被确认过」—— confirmedCount 是绿色通道的信任依据（§4.10），
      // 必须由真实复核确认累积，不能靠手动建规则绕过
      confirmedCount: 0,
    },
  });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "rule:create",
      detail: { clientId: id, ruleId: rule.id, matchType, matchValue, glAccountId: acct.qboAccountId } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, ruleId: rule.id });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as UpdateBody;
  const rule = await prisma.classificationRule.findFirst({
    where: { id: String(body.id ?? ""), firmId: s.firmId, clientId: id },
  });
  if (!rule) return Response.json({ error: "规则不存在" }, { status: 404 });

  const data: Prisma.ClassificationRuleUpdateInput = {};
  if (body.glAccountId && body.glAccountId !== rule.glAccountId) {
    const acct = await prisma.glAccountCache.findFirst({
      where: { clientId: id, qboAccountId: body.glAccountId },
    });
    if (!acct) return Response.json({ error: "科目不存在" }, { status: 400 });
    data.glAccountId = acct.qboAccountId;
    data.glAccountName = acct.name;
    // 改了科目就等于此前的确认不再作数，计数清零（与确认路径的处理一致）
    data.confirmedCount = 0;
  }
  if (body.matchValue !== undefined) {
    const v = String(body.matchValue).trim();
    if (!v) return Response.json({ error: "匹配值不能为空" }, { status: 400 });
    data.matchValue = v;
  }
  if (!Object.keys(data).length) return Response.json({ error: "没有要更新的字段" }, { status: 400 });

  await prisma.classificationRule.update({ where: { id: rule.id }, data });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "rule:update",
      detail: {
        clientId: id,
        ruleId: rule.id,
        before: { glAccountId: rule.glAccountId, matchValue: rule.matchValue, confirmedCount: rule.confirmedCount },
        after: data,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const ruleId = new URL(req.url).searchParams.get("ruleId");
  if (!ruleId) return Response.json({ error: "缺少 ruleId" }, { status: 400 });

  const rule = await prisma.classificationRule.findFirst({ where: { id: ruleId, firmId: s.firmId, clientId: id } });
  if (!rule) return Response.json({ error: "规则不存在" }, { status: 404 });

  await prisma.classificationRule.delete({ where: { id: ruleId } });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "rule:delete",
      detail: {
        clientId: id,
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        glAccountName: rule.glAccountName,
      } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true });
}

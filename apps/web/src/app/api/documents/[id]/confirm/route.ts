import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { assertTransition, type DocStatus } from "@/domain";

type Assignment = { lineId: string; glAccountId: string | null; taxCode?: string | null };

// 确认复核：持久化每行 GL 科目 + 学习飞轮（回写供应商规则）+ 状态 → confirmed。
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { assignments?: Assignment[] };
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];

  // firm 隔离
  const doc = await prisma.document.findFirst({
    where: { id, firmId: s.firmId },
    include: { lines: true, extraction: true },
  });
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });

  // 候选科目 / 税码（校验分配是否合法）
  const [accts, taxes] = await Promise.all([
    prisma.glAccountCache.findMany({ where: { clientId: doc.clientId } }),
    prisma.taxCodeCache.findMany({ where: { clientId: doc.clientId } }),
  ]);
  const acctById = new Map(accts.map((a) => [a.qboAccountId, a]));
  const taxIds = new Set(taxes.map((t) => t.qboTaxCodeId));

  const byLine = new Map(assignments.map((a) => [String(a.lineId), a]));
  const finalByLine = doc.lines.map((l) => {
    const a = byLine.get(l.id);
    return {
      lineId: l.id,
      glAccountId: a ? (a.glAccountId ? String(a.glAccountId) : null) : l.glAccountId,
      taxCode: a && "taxCode" in a ? (a.taxCode ? String(a.taxCode) : null) : l.taxCode,
    };
  });

  const missingAcct = finalByLine.filter((x) => !x.glAccountId || !acctById.has(x.glAccountId));
  if (missingAcct.length) {
    return Response.json({ error: `还有 ${missingAcct.length} 行未选择有效科目` }, { status: 400 });
  }
  // QBO 要求每行有有效税码，缺税码不得录入（契约 §4.8）
  const missingTax = finalByLine.filter((x) => !x.taxCode || !taxIds.has(x.taxCode));
  if (missingTax.length) {
    return Response.json({ error: `还有 ${missingTax.length} 行未选择有效税码` }, { status: 400 });
  }

  // 持久化行分类（人工确认 → high）
  await prisma.$transaction(
    finalByLine.map((x) =>
      prisma.lineItem.update({
        where: { id: x.lineId },
        data: {
          glAccountId: x.glAccountId,
          glAccountName: acctById.get(x.glAccountId!)!.name,
          taxCode: x.taxCode,
          confidence: "high",
        },
      }),
    ),
  );

  // 学习飞轮：供应商已知 + 整单所有行归同一科目 → upsert 供应商规则（避免多类目噪声）。
  const vendor = doc.extraction?.vendorName?.trim();
  const uniqueAccts = new Set(finalByLine.map((x) => x.glAccountId));
  let ruleWritten = false;
  if (vendor && uniqueAccts.size === 1) {
    const acctId = [...uniqueAccts][0]!;
    const acct = acctById.get(acctId)!;
    const existing = await prisma.classificationRule.findFirst({
      where: { firmId: s.firmId, clientId: doc.clientId, matchType: "vendor", matchValue: vendor },
    });
    if (existing) {
      // confirmedCount 累加：同一供应商被人工确认得越多，规则越可信 —— 绿色通道条件 1（契约 §4.10）。
      // 科目改了则清零重数：新科目还没被反复验证过。
      const sameAccount = existing.glAccountId === acctId;
      await prisma.classificationRule.update({
        where: { id: existing.id },
        data: {
          glAccountId: acctId,
          glAccountName: acct.name,
          confirmedCount: sameAccount ? { increment: 1 } : 1,
        },
      });
    } else {
      await prisma.classificationRule.create({
        data: {
          firmId: s.firmId,
          clientId: doc.clientId,
          matchType: "vendor",
          matchValue: vendor,
          glAccountId: acctId,
          glAccountName: acct.name,
          confirmedCount: 1,
        },
      });
    }
    ruleWritten = true;
  }

  // 状态：needs_review → confirmed（已 confirmed 则仅重存，不再跃迁）
  if (doc.status === "needs_review") {
    assertTransition(doc.status as DocStatus, "confirmed");
    await prisma.document.update({ where: { id: doc.id }, data: { status: "confirmed" } });
  }
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: doc.id,
      action: doc.status === "needs_review" ? "status:needs_review->confirmed" : "reconfirm",
      detail: { ruleWritten, vendor: vendor ?? null } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, ruleWritten });
}

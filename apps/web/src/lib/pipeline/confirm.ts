// 复核确认 + 学习飞轮（契约 §4.10）。DB 编排层，不含 HTTP/Next —— HTTP 路由与 seed 共用。
// 飞轮语义：整单归同一科目才写供应商规则（多类目会污染规则）；
// 同科目再确认则 confirmedCount 累加，改科目则清零重数（新科目还没被反复验证过）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertTransition, type DocStatus } from "@/domain";

export type LineAssignment = { lineId: string; glAccountId: string | null; taxCode?: string | null };

export type ConfirmInput = {
  documentId: string;
  firmId: string;
  userId: string;
  assignments?: LineAssignment[];
  /** 附加到 AuditLog.detail 的上下文（如 batch: true），便于事后区分确认来源 */
  auditContext?: Record<string, unknown>;
};

export type ConfirmResult =
  | { ok: true; ruleWritten: boolean }
  | { ok: false; error: string; httpStatus: 400 | 404 };

export async function confirmDocument(input: ConfirmInput): Promise<ConfirmResult> {
  const assignments = Array.isArray(input.assignments) ? input.assignments : [];

  // firm 隔离
  const doc = await prisma.document.findFirst({
    where: { id: input.documentId, firmId: input.firmId },
    include: { lines: true, extraction: true },
  });
  if (!doc) return { ok: false, error: "单据不存在", httpStatus: 404 };

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
    return { ok: false, error: `还有 ${missingAcct.length} 行未选择有效科目`, httpStatus: 400 };
  }
  // QBO 要求每行有有效税码，缺税码不得录入（契约 §4.8）
  const missingTax = finalByLine.filter((x) => !x.taxCode || !taxIds.has(x.taxCode));
  if (missingTax.length) {
    return { ok: false, error: `还有 ${missingTax.length} 行未选择有效税码`, httpStatus: 400 };
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
      where: { firmId: input.firmId, clientId: doc.clientId, matchType: "vendor", matchValue: vendor },
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
          firmId: input.firmId,
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
  const wasNeedsReview = doc.status === "needs_review";
  if (wasNeedsReview) {
    assertTransition(doc.status as DocStatus, "confirmed");
    await prisma.document.update({ where: { id: doc.id }, data: { status: "confirmed" } });
  }
  await prisma.auditLog.create({
    data: {
      firmId: input.firmId,
      userId: input.userId,
      documentId: doc.id,
      action: wasNeedsReview ? "status:needs_review->confirmed" : "reconfirm",
      detail: { ...input.auditContext, ruleWritten, vendor: vendor ?? null } as Prisma.InputJsonValue,
    },
  });

  return { ok: true, ruleWritten };
}

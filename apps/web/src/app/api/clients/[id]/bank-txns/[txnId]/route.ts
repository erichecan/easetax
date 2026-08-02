import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { MATCH_STATUSES, type MatchStatus } from "@/domain";

// 人工裁决银行流水的匹配（契约 §4.6：自动匹配是 derived，人工裁决才是 canonical）。
// 自动匹配一定会有错判漏判，没有这个接口，会计师只能眼看着错的匹配没法改。
type Body = { matchStatus?: string; matchedDocumentId?: string | null };

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; txnId: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id, txnId } = await params;
  const txn = await prisma.bankTxn.findFirst({ where: { id: txnId, clientId: id, firmId: s.firmId } });
  if (!txn) return Response.json({ error: "流水不存在" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Body;
  const next = body.matchStatus as MatchStatus | undefined;
  if (!next || !MATCH_STATUSES.includes(next)) {
    return Response.json({ error: `matchStatus 必须是 ${MATCH_STATUSES.join(" / ")}` }, { status: 400 });
  }

  let matchedDocumentId: string | null = null;

  if (next === "manual") {
    const docId = body.matchedDocumentId;
    if (!docId) return Response.json({ error: "人工匹配必须指定单据" }, { status: 400 });
    // 单据必须属于同一客户，否则会把 A 客户的票匹配到 B 客户的流水上
    const doc = await prisma.document.findFirst({ where: { id: docId, clientId: id, firmId: s.firmId } });
    if (!doc) return Response.json({ error: "单据不存在或不属于该客户" }, { status: 400 });

    // 一张单据只能核销一笔付款（与自动匹配的一对一约束一致）
    const taken = await prisma.bankTxn.findFirst({
      where: { clientId: id, matchedDocumentId: docId, matchStatus: "manual", id: { not: txnId } },
    });
    if (taken) {
      return Response.json({ error: "这张单据已被另一笔流水关联" }, { status: 409 });
    }
    matchedDocumentId = docId;
  }
  // unmatched / auto / ignored 都不带 canonical 关联：
  // auto 的结果是实时算的（§4.6），不落库；ignored 表示「这笔无需收据」

  await prisma.bankTxn.update({
    where: { id: txnId },
    data: { matchStatus: next, matchedDocumentId },
  });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: matchedDocumentId,
      action: "bank_txn:match",
      detail: {
        txnId,
        from: { matchStatus: txn.matchStatus, matchedDocumentId: txn.matchedDocumentId },
        to: { matchStatus: next, matchedDocumentId },
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, matchStatus: next, matchedDocumentId });
}

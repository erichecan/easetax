import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { confirmDocument } from "@/lib/pipeline/confirm";

// 批量确认。只确认「已经齐全」的单据 —— 批量操作不该顺手替人做判断，
// 缺科目或缺税码的必须回到复核台一张张处理。
// 逐条处理并逐条报错：一张失败不该让其余 N-1 张也白干。
// 确认与学习飞轮走 lib/pipeline/confirm.ts，与单张确认共用同一份语义。
const MAX_BATCH = 100;

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { documentIds?: string[] };
  const ids = Array.isArray(body.documentIds) ? body.documentIds.map(String).slice(0, MAX_BATCH) : [];
  if (!ids.length) return Response.json({ error: "没有选中单据" }, { status: 400 });

  const docs = await prisma.document.findMany({
    where: { id: { in: ids }, firmId: s.firmId },
    include: { lines: true },
  });

  const confirmed: string[] = [];
  const failed: { documentId: string; fileName: string; reason: string }[] = [];

  for (const doc of docs) {
    if (doc.status !== "needs_review") {
      failed.push({ documentId: doc.id, fileName: doc.fileName, reason: `状态「${doc.status}」不可确认` });
      continue;
    }
    if (!doc.lines.length) {
      failed.push({ documentId: doc.id, fileName: doc.fileName, reason: "没有行项目" });
      continue;
    }
    const bad = doc.lines.filter((l) => !l.glAccountId || !l.taxCode);
    if (bad.length) {
      failed.push({ documentId: doc.id, fileName: doc.fileName, reason: `${bad.length} 行缺科目或税码` });
      continue;
    }

    try {
      // 不传 assignments → 沿用行上已有的科目/税码（上面已校验齐全）
      const r = await confirmDocument({
        documentId: doc.id,
        firmId: s.firmId,
        userId: s.userId,
        auditContext: { batch: true },
      });
      if (r.ok) confirmed.push(doc.id);
      else failed.push({ documentId: doc.id, fileName: doc.fileName, reason: r.error });
    } catch (e) {
      failed.push({
        documentId: doc.id,
        fileName: doc.fileName,
        reason: e instanceof Error ? e.message : "确认失败",
      });
    }
  }

  const missing = ids.filter((id) => !docs.some((d) => d.id === id));
  for (const id of missing) failed.push({ documentId: id, fileName: "—", reason: "单据不存在" });

  return Response.json({ ok: true, confirmed: confirmed.length, failedCount: failed.length, failed });
}

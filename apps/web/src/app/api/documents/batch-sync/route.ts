import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { syncDocumentToQbo, SyncPreconditionError } from "@/lib/pipeline/sync-qbo";
import { QboNotConnectedError } from "@/lib/providers";

const MAX_BATCH = 50;

// 批量录入已确认单据。串行而非并发：QBO 限流约 500/min/公司，
// 并发打过去只会更快触发 429，退避反而拖得更久。
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { documentIds?: string[] };
  const ids = Array.isArray(body.documentIds) ? body.documentIds.map(String).slice(0, MAX_BATCH) : [];
  if (!ids.length) return Response.json({ error: "没有选中单据" }, { status: 400 });

  const docs = await prisma.document.findMany({
    where: { id: { in: ids }, firmId: s.firmId },
    select: { id: true, fileName: true },
  });

  const synced: { documentId: string; qboId?: string; entity?: string; duplicate?: boolean }[] = [];
  const failed: { documentId: string; fileName: string; reason: string }[] = [];

  for (const d of docs) {
    try {
      const r = await syncDocumentToQbo(d.id, s.firmId, s.userId);
      synced.push({ documentId: d.id, qboId: r.qboId, entity: r.entity, duplicate: r.duplicate });
    } catch (e) {
      const reason =
        e instanceof QboNotConnectedError
          ? "该客户尚未连接 QBO"
          : e instanceof SyncPreconditionError
            ? e.message
            : e instanceof Error
              ? e.message
              : "录入失败";
      failed.push({ documentId: d.id, fileName: d.fileName, reason });
      // 未连 QBO 是客户级问题，后面每张都会撞同一堵墙，没必要继续
      if (e instanceof QboNotConnectedError) break;
    }
  }

  const missing = ids.filter((id) => !docs.some((d) => d.id === id));
  for (const id of missing) failed.push({ documentId: id, fileName: "—", reason: "单据不存在" });

  return Response.json({ ok: true, synced: synced.length, failedCount: failed.length, failed, details: synced });
}

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { reprocessDocument, REPROCESSABLE } from "@/lib/pipeline/ingest";
import { maybeAutoPost } from "@/lib/pipeline/auto-post";
import type { DocStatus } from "@/domain";

// 重跑 OCR + 分类：丢弃上次识别结果重走一遍（契约 §4.1 重跑边）。
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const doc = await prisma.document.findFirst({ where: { id, firmId: s.firmId } });
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });

  if (!REPROCESSABLE.includes(doc.status as DocStatus)) {
    return Response.json(
      { error: `当前状态「${doc.status}」不可重跑，请先退回复核` },
      { status: 409 },
    );
  }

  try {
    const r = await reprocessDocument(doc.id, s.userId);
    // 重跑后同样过一遍绿色通道（契约 §4.10）——能力升级后存量单据也该享受自动过账。
    let autoPosted = false;
    if (r.status === "needs_review") {
      const auto = await maybeAutoPost(doc.id);
      autoPosted = auto.confirmed;
    }
    return Response.json({ ok: true, status: r.status, lines: r.lines, docConfidence: r.docConfidence, autoPosted });
  } catch (e) {
    console.error("[reprocess] 失败", e);
    return Response.json({ error: e instanceof Error ? e.message : "重跑失败" }, { status: 400 });
  }
}

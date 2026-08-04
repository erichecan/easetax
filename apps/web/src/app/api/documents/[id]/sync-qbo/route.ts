import { getSession } from "@/lib/session";
import { syncDocumentToQbo, SyncPreconditionError } from "@/lib/pipeline/sync-qbo";
import { QboNotConnectedError } from "@/lib/providers";

// 录入 QBO：confirmed → syncing_qbo → synced（契约 G9 按付款状态分叉 Bill/Purchase）。
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  try {
    const r = await syncDocumentToQbo(id, s.firmId, s.userId);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof QboNotConnectedError) {
      return Response.json({ error: "该客户尚未连接 QBO，请先在客户设置里连接" }, { status: 409 });
    }
    if (e instanceof SyncPreconditionError) {
      return Response.json({ error: e.message }, { status: e.message === "单据不存在" ? 404 : 409 });
    }
    console.error("[sync-qbo] 失败", e);
    return Response.json({ error: e instanceof Error ? e.message : "录入失败" }, { status: 502 });
  }
}

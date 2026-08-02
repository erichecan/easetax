import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers";

// 原件字节流：复核页左栏预览 / 下载。firm 隔离，永不进公共缓存。
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const doc = await prisma.document.findFirst({
    where: { id, firmId: s.firmId },
    select: { storageKey: true, mimeType: true, fileName: true },
  });
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });

  const storage = getStorageProvider();
  if (!(await storage.exists(doc.storageKey))) {
    return Response.json({ error: "原件不存在（存储中已缺失）" }, { status: 404 });
  }

  const bytes = await storage.get(doc.storageKey);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const disposition = download ? "attachment" : "inline";

  // 拷进独立 ArrayBuffer：Buffer 可能挂在共享内存池上，不能直接当 BodyInit。
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  return new Response(body, {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ingestDocument, processDocument } from "@/lib/pipeline/ingest";
import { maybeAutoPost } from "@/lib/pipeline/auto-post";
import {
  firstClientId,
  INBOUND_ALLOWED_MIME,
  resolveMime,
  verifySignature,
  type InboundPayload,
} from "@/lib/inbound-email";

// 邮件入站：客户把发票转发到专属收单邮箱 → 附件直接进 pipeline。
// 这是公开端点（proxy.ts 白名单放行），**鉴权靠 HMAC 签名**，不是 JWT。
// 没有签名，任何人都能往任意客户账上塞单据。
export async function POST(req: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    // 没配密钥就不能开放这个端点 —— 宁可 503 也不要裸奔
    return Response.json({ error: "入站邮件未启用（缺 INBOUND_WEBHOOK_SECRET）" }, { status: 503 });
  }

  const raw = await req.text();
  const signature = req.headers.get("x-easetax-signature");
  if (!verifySignature(raw, signature, secret)) {
    return Response.json({ error: "签名校验失败" }, { status: 401 });
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(raw) as InboundPayload;
  } catch {
    return Response.json({ error: "载荷不是合法 JSON" }, { status: 400 });
  }

  const clientId = firstClientId(payload.to ?? "");
  if (!clientId) {
    return Response.json({ error: "收件地址无法解析出客户" }, { status: 400 });
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const attachments = payload.attachments ?? [];
  if (!attachments.length) {
    // 没附件不是错误：客户可能只是回了封信。记一笔便于排查「我发了怎么没进来」
    await prisma.auditLog.create({
      data: {
        firmId: client.firmId,
        userId: "inbound",
        action: "inbound:no_attachment",
        detail: { clientId, from: payload.from ?? null, subject: payload.subject ?? null } as Prisma.InputJsonValue,
      },
    });
    return Response.json({ ok: true, accepted: 0, skipped: 0, note: "邮件无附件" });
  }

  const accepted: { fileName: string; documentId: string; duplicate: boolean; status: string }[] = [];
  const skipped: { fileName: string; reason: string }[] = [];

  for (const att of attachments) {
    const mimeType = resolveMime(att.fileName, att.mimeType);
    if (!INBOUND_ALLOWED_MIME.has(mimeType)) {
      skipped.push({ fileName: att.fileName, reason: `不支持的类型 ${mimeType}` });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(att.content, "base64"));
    } catch {
      skipped.push({ fileName: att.fileName, reason: "附件内容不是合法 base64" });
      continue;
    }
    if (!bytes.byteLength) {
      skipped.push({ fileName: att.fileName, reason: "空附件" });
      continue;
    }

    try {
      // 与手动上传同一条 pipeline：去重、OCR、分类、绿色通道全部一致
      const ing = await ingestDocument({
        firmId: client.firmId,
        clientId,
        source: "email",
        fileName: att.fileName,
        mimeType,
        bytes,
        userId: "inbound",
      });
      let status = "duplicate_suspected";
      if (!ing.duplicate) {
        const r = await processDocument(ing.documentId, "inbound");
        status = r.status;
        if (r.status === "needs_review") {
          const auto = await maybeAutoPost(ing.documentId);
          if (auto.confirmed) status = auto.synced ? "synced" : "confirmed";
        }
      }
      accepted.push({ fileName: att.fileName, documentId: ing.documentId, duplicate: ing.duplicate, status });
    } catch (e) {
      // 单个附件失败不影响同封邮件里的其他附件
      skipped.push({ fileName: att.fileName, reason: e instanceof Error ? e.message : "处理失败" });
    }
  }

  await prisma.auditLog.create({
    data: {
      firmId: client.firmId,
      userId: "inbound",
      action: "inbound:received",
      detail: {
        clientId,
        from: payload.from ?? null,
        subject: payload.subject ?? null,
        accepted: accepted.length,
        skipped,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, accepted: accepted.length, skipped: skipped.length, documents: accepted, skippedDetail: skipped });
}

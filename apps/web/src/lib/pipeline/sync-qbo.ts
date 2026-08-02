// P5 录入 QBO 编排：confirmed → syncing_qbo → synced/sync_failed。
// 契约 G9：已付 → Purchase（冲银行/信用卡），未付 → Bill（挂 AP）。
// 契约 G5：synced 后 QBO 成为权威，本地转只读快照，靠 qboEntity + qboBillId 回查。
// 契约 §4.2：未连 QBO 是一等状态 —— 停在 confirmed，不产生 synced。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertTransition, qboEntityFor, type DocStatus, type Settlement } from "@/domain";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getQboProvider, getStorageProvider, QboNotConnectedError, type QboLine } from "@/lib/providers";

export type SyncResult = {
  status: DocStatus;
  entity?: string;
  qboId?: string;
  duplicate?: boolean;
  attached?: boolean;
};

async function audit(
  firmId: string,
  userId: string,
  documentId: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: { firmId, userId, documentId, action, detail: detail as Prisma.InputJsonValue },
  });
}

export class SyncPreconditionError extends Error {}

// 录入前置校验：状态、连接、每行科目与税码、已付单据的资金账户。
// 返回可直接用于建单的数据；任一不满足抛 SyncPreconditionError（由调用方转 4xx）。
export async function prepareSync(documentId: string, firmId: string) {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, firmId },
    include: { extraction: true, lines: true, client: true },
  });
  if (!doc) throw new SyncPreconditionError("单据不存在");
  if (doc.status !== "confirmed" && doc.status !== "sync_failed") {
    throw new SyncPreconditionError(`当前状态「${doc.status}」不可录入，需先完成复核确认`);
  }
  if (!doc.client.qboRealmId || !doc.client.qboRefreshToken) {
    throw new QboNotConnectedError();
  }
  if (!doc.lines.length) throw new SyncPreconditionError("该单据没有行项目，无法录入");

  const badLine = doc.lines.find((l) => !l.glAccountId || !l.taxCode);
  if (badLine) throw new SyncPreconditionError("存在未指定科目或税码的行，无法录入");

  // 付款状态未定时按未付处理（Bill 挂 AP 可事后付款，比错冲银行安全）。
  const settlement: Settlement = doc.settlement === "paid" ? "paid" : "unpaid";
  const entity = qboEntityFor(settlement);
  if (entity === "Purchase" && !doc.client.qboPaymentAccountId) {
    throw new SyncPreconditionError("这是已付单据，需先在客户设置里指定付款账户（银行或信用卡）");
  }

  return { doc, entity, settlement };
}

export async function syncDocumentToQbo(documentId: string, firmId: string, userId: string): Promise<SyncResult> {
  const { doc, entity } = await prepareSync(documentId, firmId);

  assertTransition(doc.status as DocStatus, "syncing_qbo");
  await prisma.document.update({ where: { id: doc.id }, data: { status: "syncing_qbo" } });
  await audit(firmId, userId, doc.id, `status:${doc.status}->syncing_qbo`, { entity });

  try {
    const qbo = getQboProvider();
    const ctx = await qbo.connect({
      realmId: doc.client.qboRealmId!,
      refreshToken: decryptSecret(doc.client.qboRefreshToken!),
    });
    // Intuit 每次刷新都轮换 refresh token，不回写下次就连不上。
    if (ctx.rotatedRefreshToken) {
      await prisma.client.update({
        where: { id: doc.clientId },
        data: { qboRefreshToken: encryptSecret(ctx.rotatedRefreshToken) },
      });
    }

    const lines: QboLine[] = doc.lines.map((l) => ({
      description: l.description,
      amount: l.amount.toString(),
      glAccountId: l.glAccountId!,
      taxCodeId: l.taxCode!,
    }));

    const e = doc.extraction;
    const posted = await qbo.post(ctx, {
      entity,
      vendorName: e?.vendorName?.trim() || "Unknown Vendor",
      docNumber: e?.invoiceNo ?? null,
      txnDate: e?.txnDate ? e.txnDate.toISOString().slice(0, 10) : null,
      dueDate: e?.dueDate ? e.dueDate.toISOString().slice(0, 10) : null,
      currency: e?.currency ?? null,
      lines,
      paymentAccountId: doc.client.qboPaymentAccountId,
    });

    // 原件挂 Attachable（审计留痕）。附件失败不回滚已建的单据 —— 单据是主，附件可补挂。
    let attached = false;
    if (!posted.duplicate) {
      try {
        const bytes = await getStorageProvider().get(doc.storageKey);
        await qbo.attach(ctx, entity, posted.id, {
          fileName: doc.fileName,
          mimeType: doc.mimeType,
          bytes,
        });
        attached = true;
      } catch (e) {
        await audit(firmId, userId, doc.id, "qbo:attach_failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "synced", qboBillId: posted.id, qboEntity: posted.entity },
    });
    await audit(firmId, userId, doc.id, "status:syncing_qbo->synced", {
      entity: posted.entity,
      qboId: posted.id,
      docNumber: posted.docNumber,
      duplicate: posted.duplicate,
      attached,
    });

    return { status: "synced", entity: posted.entity, qboId: posted.id, duplicate: posted.duplicate, attached };
  } catch (err) {
    await prisma.document.update({ where: { id: doc.id }, data: { status: "sync_failed" } });
    await audit(firmId, userId, doc.id, "status:syncing_qbo->sync_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

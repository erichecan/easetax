// Mock QBO：无外部调用，确定性 id。用于未配 Intuit 凭据时把 P5 闭环跑通（DEV-PLAN §4 密钥门控）。
// 行为刻意贴近真实：Purchase/Bill 分叉、docNumber 去重、附件调用都会被记录，便于验证。
import { createHash } from "node:crypto";
import type {
  QboAccessContext,
  QboAccount,
  QboAttachment,
  QboConnection,
  QboPostInput,
  QboPostResult,
  QboProvider,
  QboTaxCode,
} from "./qbo";
import type { QboEntity } from "@/domain";

function stableId(prefix: string, seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex").slice(0, 6);
  return `${prefix}-${parseInt(h, 16) % 100000}`;
}

// 进程内“已录入”记录，模拟 QBO 侧去重（重启即清空，仅供 dev 演示）。
const posted = new Map<string, QboPostResult>();

export class MockQboProvider implements QboProvider {
  readonly name = "mock-qbo";
  readonly attachments: { entity: QboEntity; entityId: string; fileName: string }[] = [];

  async connect(conn: QboConnection): Promise<QboAccessContext> {
    return { realmId: conn.realmId, accessToken: `mock-access-${conn.realmId}`, rotatedRefreshToken: null };
  }

  async findOrCreateVendor(_ctx: QboAccessContext, name: string) {
    return { id: stableId("vend", name), name };
  }

  async post(ctx: QboAccessContext, input: QboPostInput): Promise<QboPostResult> {
    // 去重键按 entity 分：真实 QBO 是 `SELECT * FROM Bill|Purchase WHERE DocNumber=...`，分表查。
    const key = `${ctx.realmId}|${input.entity}|${input.vendorName}|${input.docNumber ?? ""}`;
    const existing = input.docNumber ? posted.get(key) : undefined;
    if (existing) return { ...existing, duplicate: true };

    const result: QboPostResult = {
      entity: input.entity,
      id: stableId(input.entity === "Bill" ? "bill" : "purch", key + input.lines.length),
      docNumber: input.docNumber,
      duplicate: false,
    };
    if (input.docNumber) posted.set(key, result);
    return result;
  }

  async attach(_ctx: QboAccessContext, entity: QboEntity, entityId: string, file: QboAttachment): Promise<void> {
    this.attachments.push({ entity, entityId, fileName: file.fileName });
  }

  async listAccounts(): Promise<QboAccount[]> {
    return [];
  }

  async listTaxCodes(): Promise<QboTaxCode[]> {
    return [];
  }
}

// 种子数据 —— **事件重放式**，不是往表里塞行。
//
// 每张单据都真的走一遍 ingestDocument → processDocument → confirmDocument → syncDocumentToQbo，
// 状态是「流到哪一段就停在哪」的结果，而不是随手贴的标签。因此：
//   · Extraction / LineItem / AuditLog 都是链路真跑出来的副产品
//   · ClassificationRule.confirmedCount 是真确认累加出来的，头部供应商自然先到 3 次门槛
//   · 门槛到了之后，后面的单据会**真的**走绿色通道自动过账（不是硬写 synced）
// 按日期升序重放，所以"越用越准"这条曲线在数据里是真实存在的。
//
// 外部依赖全部注入替身：OCR 用设计好的 SeedOcrProvider，QBO 用 MockQboProvider
// —— seed 绝不碰真实 Intuit 沙箱，免得往沙箱里灌垃圾单据。
//
// 幂等：只清自己 3 个 client 的数据，不动 QBO 真实链路建的客户。跑：npm run seed
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { assertTransition, inboundEmailFor, type DocStatus } from "@/domain";
import { encryptSecret } from "@/lib/crypto";
import { setOcrProvider, setQboProvider, type QboProvider } from "@/lib/providers";
import { MockQboProvider } from "@/lib/providers/qbo-mock";
import { ingestDocument, processDocument } from "@/lib/pipeline/ingest";
import { confirmDocument } from "@/lib/pipeline/confirm";
import { syncDocumentToQbo } from "@/lib/pipeline/sync-qbo";
import { maybeAutoPost } from "@/lib/pipeline/auto-post";
import {
  ACCOUNTS,
  CLIENTS,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  FIRM_ID,
  NO_RECEIPT_TXNS,
  REVIEWER_EMAIL,
  TAX_CODES_BY_PROVINCE,
} from "./seed/catalog";
import { buildInvoices, fakeFileBytes, makeRng, SeedOcrProvider, type InvoiceSpec } from "./seed/invoices";

const WEEKS = 10;
const RNG_SEED = 20260803; // 固定种子 → 同样的数据，可复现

/** 一次性录入失败的替身，用来真实走出 sync_failed 分支（而不是硬改状态）。 */
class FailingQboProvider implements QboProvider {
  readonly name = "failing-qbo";
  async connect(): Promise<never> {
    throw new Error("Seed 模拟：QBO 返回 401，refresh token 已失效");
  }
  async findOrCreateVendor(): Promise<never> {
    throw new Error("unreachable");
  }
  async post(): Promise<never> {
    throw new Error("unreachable");
  }
  async attach(): Promise<never> {
    throw new Error("unreachable");
  }
  async listAccounts(): Promise<never> {
    throw new Error("unreachable");
  }
  async listTaxCodes(): Promise<never> {
    throw new Error("unreachable");
  }
}

const SEED_CLIENT_IDS = CLIENTS.map((c) => c.id);

/** 只清 seed 自己的 3 个客户 —— QBO 真实链路建的客户（另一个 realmId）必须留着。 */
async function reset(): Promise<void> {
  const docs = await prisma.document.findMany({
    where: { clientId: { in: SEED_CLIENT_IDS } },
    select: { id: true },
  });
  const ids = docs.map((d) => d.id);

  // 催票记录挂在流水上（onDelete: Cascade），先删它再删流水
  await prisma.chaseNotice.deleteMany({ where: { clientId: { in: SEED_CLIENT_IDS } } });
  await prisma.bankTxn.deleteMany({ where: { clientId: { in: SEED_CLIENT_IDS } } });
  await prisma.auditLog.deleteMany({ where: { documentId: { in: ids } } });
  await prisma.lineItem.deleteMany({ where: { documentId: { in: ids } } });
  await prisma.extraction.deleteMany({ where: { documentId: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: ids } } });
  await prisma.classificationRule.deleteMany({ where: { clientId: { in: SEED_CLIENT_IDS } } });
}

async function seedMasterData(): Promise<void> {
  const firm = await prisma.firm.upsert({
    where: { id: FIRM_ID },
    update: {},
    create: { id: FIRM_ID, name: "易账 Demo 记账公司" },
  });

  for (const email of [DEMO_EMAIL, REVIEWER_EMAIL]) {
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: { firmId: firm.id, email, passwordHash: hashPassword(DEMO_PASSWORD), role: "accountant" },
    });
  }

  for (const c of CLIENTS) {
    const common = {
      name: c.name,
      industry: c.industry,
      contactEmail: c.contactEmail,
      province: c.province,
      taxNumber: c.taxNumber,
      qboRealmId: c.qboRealmId,
      // 连了 QBO 的客户要有可解密的 refresh token，sync 才走得下去（mock provider 不校验内容）
      qboRefreshToken: c.qboRealmId ? encryptSecret(`seed-refresh-${c.id}`) : null,
      qboPaymentAccountId: c.qboPaymentAccountId,
      autoPostEnabled: c.autoPostEnabled,
      autoPostThreshold: c.autoPostThreshold == null ? null : new Prisma.Decimal(c.autoPostThreshold),
    };
    await prisma.client.upsert({
      where: { id: c.id },
      update: common,
      create: { id: c.id, firmId: firm.id, inboundEmail: inboundEmailFor(c.id), ...common },
    });

    for (const a of ACCOUNTS) {
      await prisma.glAccountCache.upsert({
        where: { clientId_qboAccountId: { clientId: c.id, qboAccountId: a.id } },
        update: { name: a.name },
        create: { clientId: c.id, qboAccountId: a.id, name: a.name, accountType: "Expense" },
      });
    }

    for (const t of TAX_CODES_BY_PROVINCE[c.province]) {
      await prisma.taxCodeCache.upsert({
        where: { clientId_qboTaxCodeId: { clientId: c.id, qboTaxCodeId: t.id } },
        update: { semanticKey: t.semanticKey, name: t.name, rate: new Prisma.Decimal(t.rate), isGroup: t.isGroup },
        create: {
          clientId: c.id,
          qboTaxCodeId: t.id,
          semanticKey: t.semanticKey,
          name: t.name,
          rate: new Prisma.Decimal(t.rate),
          isGroup: t.isGroup,
        },
      });
    }
  }
}

/** 直接跃迁（仍走状态机断言 + 审计），用于把单据「停」在机器段或异常旁支上。 */
async function park(documentId: string, to: DocStatus, userId: string, detail: Record<string, unknown> = {}) {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  assertTransition(doc.status as DocStatus, to);
  await prisma.document.update({ where: { id: documentId }, data: { status: to } });
  await prisma.auditLog.create({
    data: {
      firmId: doc.firmId,
      userId,
      documentId,
      action: `status:${doc.status}->${to}`,
      detail: detail as Prisma.InputJsonValue,
    },
  });
}

/** 复核台上人做的事：把机器没定下来的科目/税码补齐，然后确认。 */
async function reviewAssignments(documentId: string, spec: InvoiceSpec, standardTaxId: string, mealsTaxId: string) {
  const lines = await prisma.lineItem.findMany({ where: { documentId }, orderBy: { id: "asc" } });
  // 机器认不出的行业专属供应商，人工知道该归哪 —— 这正是规则值得被学下来的原因
  const fallback = spec.vendor.reviewAccountId ?? "44";
  return lines.map((l, i) => ({
    lineId: l.id,
    // 多类目单据：第二行故意归到别的科目 —— 飞轮据此**不**写规则（避免规则被污染）
    glAccountId: spec.mixedAccounts && i > 0 ? "90" : (l.glAccountId ?? fallback),
    taxCode: l.taxCode ?? (l.glAccountName?.includes("餐饮") ? mealsTaxId : standardTaxId),
  }));
}

type Stats = { autoPosted: number; byState: Record<string, number> };

async function replay(specs: InvoiceSpec[], ocr: SeedOcrProvider, stats: Stats): Promise<void> {
  const clientById = new Map(CLIENTS.map((c) => [c.id, c]));
  const mockQbo = new MockQboProvider();

  for (const [n, spec] of specs.entries()) {
    const client = clientById.get(spec.clientId)!;
    const taxCodes = TAX_CODES_BY_PROVINCE[client.province];
    const standardTaxId = taxCodes.find((t) => t.semanticKey === "standard")!.id;
    const mealsTaxId = taxCodes.find((t) => t.semanticKey === "meals_50")!.id;
    // 两个会计师轮流操作 —— 审计日志里才有多个操作人
    const actor = n % 3 === 0 ? REVIEWER_EMAIL : DEMO_EMAIL;
    const fileName = `${spec.key}-${spec.vendor.name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}.pdf`;

    ocr.register(fileName, spec.extraction, spec.target === "ocr_failed");

    // ① 收单
    const ing = await ingestDocument({
      firmId: FIRM_ID,
      clientId: spec.clientId,
      source: n % 4 === 0 ? "email" : "upload",
      fileName,
      mimeType: "application/pdf",
      bytes: fakeFileBytes(spec.key, spec.vendor.name),
      userId: actor,
    });
    const docId = ing.documentId;

    // 单据的发生时间铺开在过去 10 周（不这么做，全部单据都是「今天」，一眼假）
    const created = new Date();
    created.setDate(created.getDate() + spec.dayOffset);
    await prisma.document.update({ where: { id: docId }, data: { createdAt: created } });

    if (spec.target === "received") {
      stats.byState.received = (stats.byState.received ?? 0) + 1;
      continue;
    }
    // 机器段的「正在跑」：停在中间状态，演示时看得到管道在动
    if (spec.target === "ocr_processing") {
      await park(docId, "ocr_processing", "system");
      stats.byState.ocr_processing = (stats.byState.ocr_processing ?? 0) + 1;
      continue;
    }
    if (spec.target === "classifying") {
      await park(docId, "ocr_processing", "system");
      await park(docId, "ocr_done", "system");
      await park(docId, "classifying", "system");
      stats.byState.classifying = (stats.byState.classifying ?? 0) + 1;
      continue;
    }

    // ②③ 识别 + 定科目税码（ocr_failed 的文件会在 provider 里抛错，走真实失败分支）
    const processed = await processDocument(docId, "system");
    if (processed.status === "ocr_failed") {
      stats.byState.ocr_failed = (stats.byState.ocr_failed ?? 0) + 1;
      continue;
    }

    if (spec.target === "needs_review") {
      stats.byState.needs_review = (stats.byState.needs_review ?? 0) + 1;
      continue;
    }
    if (spec.target === "rejected") {
      await park(docId, "rejected", actor, { reason: "供应商开错抬头，已要求重开" });
      stats.byState.rejected = (stats.byState.rejected ?? 0) + 1;
      continue;
    }
    if (spec.target === "duplicate_suspected") {
      await park(docId, "duplicate_suspected", actor, { reason: "与同月同额单据疑似重复，待人工裁决" });
      stats.byState.duplicate_suspected = (stats.byState.duplicate_suspected ?? 0) + 1;
      continue;
    }

    // 绿色通道：只对目标是 synced 的单据尝试。前期规则确认次数不够会被门禁挡下来，
    // 等同一供应商被人工确认满 3 次之后，后面的单据才**真的**自动过账 —— 这条曲线是真的。
    if (spec.target === "synced" && client.autoPostEnabled) {
      setQboProvider(mockQbo);
      const auto = await maybeAutoPost(docId);
      if (auto.synced) {
        stats.autoPosted += 1;
        stats.byState.synced = (stats.byState.synced ?? 0) + 1;
        continue;
      }
    }

    // ④ 复核确认（人工补齐科目/税码 → 学习飞轮回写供应商规则）
    const assignments = await reviewAssignments(docId, spec, standardTaxId, mealsTaxId);
    const confirmed = await confirmDocument({ documentId: docId, firmId: FIRM_ID, userId: actor, assignments });
    if (!confirmed.ok) throw new Error(`[${spec.key}] 确认失败：${confirmed.error}`);

    if (spec.target === "confirmed") {
      stats.byState.confirmed = (stats.byState.confirmed ?? 0) + 1;
      continue;
    }

    // ⑤ 录入 QBO
    if (spec.target === "sync_failed") {
      setQboProvider(new FailingQboProvider());
      await syncDocumentToQbo(docId, FIRM_ID, actor).catch(() => undefined);
      setQboProvider(mockQbo);
      stats.byState.sync_failed = (stats.byState.sync_failed ?? 0) + 1;
      continue;
    }
    setQboProvider(mockQbo);
    await syncDocumentToQbo(docId, FIRM_ID, actor);
    stats.byState.synced = (stats.byState.synced ?? 0) + 1;
  }
}

/** 银行流水：一半由**真实已入库单据**派生（走真实匹配算法才会命中），
 *  一半是刻意无收据的日常支出 → 对账页形成真实的缺口清单。 */
async function seedBankTxns(): Promise<number> {
  let total = 0;
  for (const c of CLIENTS) {
    const docs = await prisma.document.findMany({
      where: { clientId: c.id, status: "synced", extraction: { isNot: null } },
      include: { extraction: true },
      orderBy: { createdAt: "desc" },
      take: 6,
    });

    const rows: Prisma.BankTxnCreateManyInput[] = docs
      .filter((d) => d.extraction?.total != null && d.extraction.vendorName)
      .map((d, i) => {
        const e = d.extraction!;
        const paid = new Date(e.txnDate ?? d.createdAt);
        paid.setDate(paid.getDate() + 2); // 银行入账滞后
        return {
          id: `seed-btxn-${c.id}-doc-${i}`,
          firmId: FIRM_ID,
          clientId: c.id,
          date: paid,
          description: `${e.vendorName!.toUpperCase()} PAYMENT`,
          amount: e.total!,
        };
      });

    const today = new Date();
    for (const [i, t] of (NO_RECEIPT_TXNS[c.id] ?? []).entries()) {
      const d = new Date(today);
      d.setDate(d.getDate() + t.dayOffset);
      rows.push({
        id: `seed-btxn-${c.id}-gap-${i}`,
        firmId: FIRM_ID,
        clientId: c.id,
        date: d,
        description: t.desc,
        amount: new Prisma.Decimal(t.amount),
      });
    }

    if (rows.length) await prisma.bankTxn.createMany({ data: rows });
    total += rows.length;
  }
  return total;
}

/** 不变量断言 —— seed 生成的数据必须自洽，否则演示时任何一个汇总数字都不可信。 */
async function assertInvariants(): Promise<void> {
  const problems: string[] = [];

  const docs = await prisma.document.findMany({
    where: { clientId: { in: SEED_CLIENT_IDS } },
    include: { extraction: true, lines: true },
  });

  for (const d of docs) {
    // ① 税前金额 == Σ 行项金额（契约 G1：金额跨边界走 decimal，不允许浮点误差）
    if (d.lines.length && d.extraction?.subTotal != null) {
      const sum = d.lines.reduce((s, l) => s.add(l.amount), new Prisma.Decimal(0));
      if (!sum.equals(d.extraction.subTotal)) {
        problems.push(`${d.fileName}: 行项合计 ${sum} ≠ 税前金额 ${d.extraction.subTotal}`);
      }
    }
    // ② 已录入 QBO 的必须有回查凭据（契约 G5：synced 后 QBO 是权威）
    if (d.status === "synced" && (!d.qboBillId || !d.qboEntity)) {
      problems.push(`${d.fileName}: synced 却没有 qboBillId/qboEntity`);
    }
    // ③ 确认之后的单据每行必须有科目与税码（契约 §4.8：缺税码不得录入）
    if (["confirmed", "syncing_qbo", "synced"].includes(d.status)) {
      const bad = d.lines.filter((l) => !l.glAccountId || !l.taxCode);
      if (bad.length) problems.push(`${d.fileName}: 状态 ${d.status} 但有 ${bad.length} 行缺科目或税码`);
    }
    // ④ 未连 QBO 的客户不可能有 synced（契约 §4.2）
  }

  const unlinked = CLIENTS.filter((c) => !c.qboRealmId).map((c) => c.id);
  const bogus = docs.filter((d) => unlinked.includes(d.clientId) && d.status === "synced");
  if (bogus.length) problems.push(`未连 QBO 的客户出现了 ${bogus.length} 张 synced 单据`);

  if (problems.length) {
    console.error("❌ 不变量校验失败：");
    for (const p of problems) console.error("   - " + p);
    throw new Error(`${problems.length} 项不变量被破坏`);
  }
}

async function main() {
  await reset();
  await seedMasterData();

  const ocr = new SeedOcrProvider();
  setOcrProvider(ocr);

  const rng = makeRng(RNG_SEED);
  const specs = CLIENTS.flatMap((c) =>
    buildInvoices(c, TAX_CODES_BY_PROVINCE[c.province][0].rate, WEEKS, rng),
  ).sort((a, b) => a.dayOffset - b.dayOffset); // 全局按时间重放，规则确认次数才会自然长起来

  const stats: Stats = { autoPosted: 0, byState: {} };
  await replay(specs, ocr, stats);

  const txnCount = await seedBankTxns();
  await assertInvariants();

  const rules = await prisma.classificationRule.findMany({
    where: { clientId: { in: SEED_CLIENT_IDS } },
    orderBy: { confirmedCount: "desc" },
  });
  const trusted = rules.filter((r) => r.confirmedCount >= 3).length;

  setOcrProvider(null);
  setQboProvider(null);

  console.log("✅ seed 完成（事件重放式，不变量已校验）");
  console.log(`   登录：${DEMO_EMAIL} / ${DEMO_PASSWORD}（另有 ${REVIEWER_EMAIL}）`);
  console.log(`   客户 ${CLIENTS.length} 个：`);
  for (const c of CLIENTS) {
    console.log(
      `     · ${c.name}（${c.industry}/${c.province}）` +
        `${c.qboRealmId ? "已连 QBO" : "未连 QBO"}` +
        `${c.autoPostEnabled ? "，绿色通道开" : ""} 收单邮箱 ${inboundEmailFor(c.id)}`,
    );
  }
  console.log(`   单据 ${specs.length} 张，分布：`);
  for (const [state, count] of Object.entries(stats.byState).sort()) console.log(`     ${state.padEnd(20)} ${count}`);
  console.log(`   其中绿色通道自动过账 ${stats.autoPosted} 张（未经人工，进抽查列表）`);
  console.log(`   供应商规则 ${rules.length} 条，其中 ${trusted} 条已达绿色通道门槛（≥3 次人工确认）`);
  console.log(`   银行流水 ${txnCount} 笔`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

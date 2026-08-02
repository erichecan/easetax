// 种子数据：一个记账公司 + 一个会计师 + 一个客户（未连 QBO）+ 科目表 + 一条规则。
// 幂等，可重复运行。跑：npx tsx prisma/seed.ts
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { inboundEmailFor } from "@/domain";

const FIRM_ID = "firm-demo";
const CLIENT_ID = "client-demo";
const DEMO_EMAIL = "demo@easetax.ca";
const DEMO_PASSWORD = "easetax-demo"; // 仅 dev 种子；上线换

// 模拟客户 QBO 科目表（id = QBO Account.Id，契约 G2）。
// 一套典型加拿大小企业费用科目——名字含类别关键词，供 vendor-seed 按类别定位。
const ACCOUNTS = [
  { id: "7", name: "Office Supplies 办公用品" },
  { id: "12", name: "Telephone & Internet 电话网络" },
  { id: "19", name: "Rent Expense 租金" },
  { id: "23", name: "Meals & Entertainment 餐饮招待" },
  { id: "31", name: "Software & Subscriptions 软件订阅" },
  { id: "40", name: "Utilities 水电杂费" },
  { id: "45", name: "Vehicle & Fuel 汽车油费" },
  { id: "50", name: "Repairs & Maintenance 维修保养" },
  { id: "55", name: "Travel 差旅交通" },
  { id: "60", name: "Insurance 保险" },
  { id: "65", name: "Shipping & Postage 运费邮寄" },
  { id: "70", name: "Bank Charges & Merchant Fees 银行手续费" },
  { id: "75", name: "Advertising & Promotion 广告推广" },
  { id: "80", name: "Professional Fees 专业服务费" },
  { id: "85", name: "Cost of Goods Sold 销货成本" },
  { id: "90", name: "Supplies & Materials 材料耗材" },
  { id: "44", name: "General Expenses 一般费用" },
];

// 银行流水种子：一半由**真实已入库单据**派生（金额/日期/供应商取自 Extraction，
// 走真实的自动匹配算法才会命中），一半是刻意无收据的日常支出 → 形成「缺收据清单」。
// 幂等：固定 id 前缀，重跑先清。匹配关系不预置（derived，契约 §4.6）。
const NO_RECEIPT_TXNS = [
  { desc: "PETRO-CANADA 04412 TORONTO", amount: 92.15, dayOffset: -6 },
  { desc: "TIM HORTONS #4021", amount: 18.4, dayOffset: -4 },
  { desc: "SQUARE *DENTAL SUPPLY CO", amount: 418.0, dayOffset: -3 },
  { desc: "STARBUCKS #1123 YONGE ST", amount: 26.75, dayOffset: -1 },
  { desc: "MONTHLY ACCOUNT FEE", amount: 10.95, dayOffset: 0 },
];

// 税码表（契约 §4.8）：真实值应从客户 QBO `SELECT * FROM TaxCode` 同步，
// 这里给一套安大略 demo 值，让规则表在没连 QBO 时也能端到端跑通。
// semanticKey 是规则输出 → 客户税码的桥，换省份只需换这张表。
const TAX_CODES = [
  { id: "4", semanticKey: "standard", name: "HST ON 13%", rate: 0.13, isGroup: false },
  { id: "M&E", semanticKey: "meals_50", name: "Meals & Entertainment 50% (group)", rate: 0.13, isGroup: true },
  { id: "5", semanticKey: "no_tax", name: "Exempt 免税 / 零税率", rate: 0, isGroup: false },
  { id: "6", semanticKey: "no_itc", name: "Non-recoverable 税额并入成本", rate: 0.13, isGroup: false },
];

async function seedTaxCodes(): Promise<number> {
  for (const t of TAX_CODES) {
    await prisma.taxCodeCache.upsert({
      where: { clientId_qboTaxCodeId: { clientId: CLIENT_ID, qboTaxCodeId: t.id } },
      update: { semanticKey: t.semanticKey, name: t.name, rate: new Prisma.Decimal(t.rate), isGroup: t.isGroup },
      create: {
        clientId: CLIENT_ID,
        qboTaxCodeId: t.id,
        semanticKey: t.semanticKey,
        name: t.name,
        rate: new Prisma.Decimal(t.rate),
        isGroup: t.isGroup,
      },
    });
  }
  return TAX_CODES.length;
}

async function seedBankTxns(firmId: string): Promise<number> {
  await prisma.bankTxn.deleteMany({ where: { firmId, id: { startsWith: "seed-btxn-" } } });

  const docs = await prisma.document.findMany({
    where: { firmId, clientId: CLIENT_ID, extraction: { isNot: null } },
    include: { extraction: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const rows = docs
    .filter((d) => d.extraction?.total != null && d.extraction.vendorName)
    .map((d, i) => {
      const e = d.extraction!;
      const paid = new Date(e.txnDate ?? d.createdAt);
      paid.setDate(paid.getDate() + 2); // 银行入账滞后
      return {
        id: `seed-btxn-doc-${i}`,
        firmId,
        clientId: CLIENT_ID,
        date: paid,
        description: `${e.vendorName!.toUpperCase()} PAYMENT`,
        amount: e.total!,
      };
    });

  const today = new Date();
  for (const [i, t] of NO_RECEIPT_TXNS.entries()) {
    const d = new Date(today);
    d.setDate(d.getDate() + t.dayOffset);
    rows.push({
      id: `seed-btxn-gap-${i}`,
      firmId,
      clientId: CLIENT_ID,
      date: d,
      description: t.desc,
      amount: new Prisma.Decimal(t.amount),
    });
  }

  if (rows.length) await prisma.bankTxn.createMany({ data: rows });
  return rows.length;
}

async function main() {
  const firm = await prisma.firm.upsert({
    where: { id: FIRM_ID },
    update: {},
    create: { id: FIRM_ID, name: "易账 Demo 记账公司" },
  });

  await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { firmId: firm.id, email: DEMO_EMAIL, passwordHash: hashPassword(DEMO_PASSWORD), role: "accountant" },
  });

  await prisma.client.upsert({
    where: { id: CLIENT_ID },
    update: { province: "ON", taxNumber: "800123456RT0001" },
    create: {
      id: CLIENT_ID,
      firmId: firm.id,
      name: "Maple Leaf Dental",
      industry: "牙科诊所",
      inboundEmail: inboundEmailFor(CLIENT_ID),
      qboRealmId: null, // 未连 QBO（一等状态）
      province: "ON", // 税码规则表输入（契约 §4.8）
      taxNumber: "800123456RT0001", // 购方 GST 号，≥$150 凭证要件
    },
  });

  for (const a of ACCOUNTS) {
    await prisma.glAccountCache.upsert({
      where: { clientId_qboAccountId: { clientId: CLIENT_ID, qboAccountId: a.id } },
      update: { name: a.name },
      create: { clientId: CLIENT_ID, qboAccountId: a.id, name: a.name, accountType: "Expense" },
    });
  }

  // 一条规则演示「规则优先」：描述含 shopify → 软件订阅
  await prisma.classificationRule.deleteMany({ where: { firmId: firm.id } });
  await prisma.classificationRule.create({
    data: {
      firmId: firm.id,
      clientId: CLIENT_ID,
      matchType: "keyword",
      matchValue: "shopify",
      glAccountId: "31",
      glAccountName: "Software & Subscriptions 软件订阅",
    },
  });

  const taxCodeCount = await seedTaxCodes();
  const txnCount = await seedBankTxns(firm.id);

  console.log("✅ seed 完成");
  console.log(`   Firm: ${firm.name} (${firm.id})`);
  console.log(`   User: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`   Client: Maple Leaf Dental (${CLIENT_ID}) 收单邮箱 ${inboundEmailFor(CLIENT_ID)}`);
  console.log(`   科目 ${ACCOUNTS.length} 个，税码 ${taxCodeCount} 个，规则 1 条，银行流水 ${txnCount} 笔`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

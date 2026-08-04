// Seed 主数据：记账公司 / 会计师 / 3 个客户 / 科目表 / 税码表 / 供应商画像。
//
// 供应商名字**刻意取自 `src/lib/providers/vendor-seed.ts` 的商户表**，
// 这样分类走的是真实的 seed 匹配（source="seed"），而不是随机 mock 值。
// 每个客户各留 1–2 个**不在**那张表里的行业专属供应商（牙科耗材/咖啡豆/混凝土），
// 它们会掉进 mock 分类器 → low confidence → 复核队列里才有真东西可复核。

export const FIRM_ID = "firm-demo";
export const DEMO_EMAIL = "demo@easetax.ca";
export const DEMO_PASSWORD = "easetax-demo"; // 仅 dev 种子；上线换
export const REVIEWER_EMAIL = "reviewer@easetax.ca"; // 第二个会计师，让审计日志里有两个操作人

/** 一套典型加拿大小企业费用科目（id = QBO Account.Id，契约 G2）。
 *  名字含类别关键词，供 vendor-seed.ts 的 CATEGORY_KEYWORDS 定位。 */
export const ACCOUNTS = [
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

export type TaxCodeSpec = {
  id: string;
  semanticKey: string;
  name: string;
  rate: number;
  isGroup: boolean;
};

/** 税码表按省份分（契约 §4.8：semanticKey 是规则输出 → 客户税码的桥，换省只换这张表）。
 *  安大略走 HST 13% 单一税；卑诗走 GST 5% + PST 7% 组合税 —— 演示"换省份只需换表"。 */
export const TAX_CODES_BY_PROVINCE: Record<string, TaxCodeSpec[]> = {
  ON: [
    { id: "4", semanticKey: "standard", name: "HST ON 13%", rate: 0.13, isGroup: false },
    { id: "M&E", semanticKey: "meals_50", name: "Meals & Entertainment 50% (group)", rate: 0.13, isGroup: true },
    { id: "5", semanticKey: "no_tax", name: "Exempt 免税 / 零税率", rate: 0, isGroup: false },
    { id: "6", semanticKey: "no_itc", name: "Non-recoverable 税额并入成本", rate: 0.13, isGroup: false },
  ],
  BC: [
    { id: "BC-GP", semanticKey: "standard", name: "GST/PST BC 12% (group)", rate: 0.12, isGroup: true },
    { id: "BC-ME", semanticKey: "meals_50", name: "Meals & Entertainment 50% BC (group)", rate: 0.12, isGroup: true },
    { id: "BC-EX", semanticKey: "no_tax", name: "Exempt 免税 / 零税率", rate: 0, isGroup: false },
    { id: "BC-NR", semanticKey: "no_itc", name: "Non-recoverable 税额并入成本", rate: 0.12, isGroup: false },
  ],
};

/** ITC 凭证完整度（契约 §4.9）—— 故意留缺口，复核队列的「凭证风险排序」才有东西可排。 */
export type ItcFlavor = "complete" | "no_supplier_tax" | "no_recipient";

export type VendorProfile = {
  name: string;
  /** 80/20：权重高的是头部供应商，单据多、规则先达门槛 */
  weight: number;
  /** 单笔税前金额区间（加元） */
  amount: [number, number];
  /** 行项目描述模板；两条 = 多行单据 */
  lines: string[];
  itc: ItcFlavor;
  settlement: "paid" | "unpaid";
  /** true = 两行归不同科目 → 学习飞轮**不**写规则（多类目会污染规则），真实存在的情况 */
  mixedAccounts?: boolean;
  /** 不在 vendor-seed 表里 → 分类掉到 mock/LLM → 低置信度 → 必须人工复核 */
  offCatalog?: boolean;
  /** 人工复核时该归的科目。机器认不出的行业专属供应商必须给 ——
   *  否则全部落到「一般费用」，演示时客户会问「我的混凝土为什么进一般费用」。 */
  reviewAccountId?: string;
};

export type ClientSpec = {
  id: string;
  name: string;
  industry: string;
  province: "ON" | "BC";
  taxNumber: string;
  contactEmail: string;
  /** null = 未连 QBO（一等状态，契约 §4.2）—— 单据会堆在 confirmed，演示这条分支 */
  qboRealmId: string | null;
  qboPaymentAccountId: string | null;
  autoPostEnabled: boolean;
  autoPostThreshold: number | null;
  vendors: VendorProfile[];
  /** 各目标状态要几张（见台账「目标分布」） */
  plan: Record<string, number>;
};

export const CLIENTS: ClientSpec[] = [
  {
    // ① 已连 QBO + 绿色通道开 —— 演示自动过账与抽查
    id: "client-demo",
    name: "Maple Leaf Dental",
    industry: "牙科诊所",
    province: "ON",
    taxNumber: "800123456RT0001",
    contactEmail: "owner@mapleleafdental.ca",
    qboRealmId: "9130347",
    qboPaymentAccountId: "35",
    autoPostEnabled: true,
    autoPostThreshold: 200,
    vendors: [
      // 头部：单据多，规则很快过 3 次门槛
      { name: "Staples Canada", weight: 8, amount: [38, 165], lines: ["Office supplies 办公耗材"], itc: "complete", settlement: "paid" },
      { name: "Bell Canada", weight: 7, amount: [92, 148], lines: ["Business internet + phone 商务宽带与电话"], itc: "complete", settlement: "unpaid" },
      { name: "Tim Hortons", weight: 6, amount: [14, 46], lines: ["Team coffee 员工咖啡"], itc: "complete", settlement: "paid" },
      // 行业专属，不在商户表 → 低置信度 → 复核队列主力
      { name: "Henry Schein Canada", weight: 6, amount: [340, 1850], lines: ["Composite restorative kit 复合树脂套装", "Disposable barriers 一次性隔离膜"], itc: "no_supplier_tax", settlement: "unpaid", offCatalog: true, reviewAccountId: "90" },
      // 长尾
      { name: "Toronto Hydro", weight: 3, amount: [180, 420], lines: ["Electricity 电费"], itc: "complete", settlement: "unpaid" },
      { name: "Purolator", weight: 2, amount: [22, 88], lines: ["Courier 快递"], itc: "complete", settlement: "paid" },
      { name: "Shopify", weight: 2, amount: [39, 79], lines: ["Online booking subscription 在线预约订阅"], itc: "complete", settlement: "paid" },
      { name: "Intact Insurance", weight: 2, amount: [420, 640], lines: ["Professional liability 执业责任险"], itc: "no_recipient", settlement: "unpaid" },
      { name: "Square", weight: 1, amount: [18, 64], lines: ["Card processing fees 刷卡手续费"], itc: "complete", settlement: "paid" },
    ],
    plan: {
      synced: 16,
      needs_review: 6,
      confirmed: 1,
      received: 1,
      ocr_processing: 1,
      ocr_failed: 1,
      rejected: 1,
      duplicate_suspected: 1,
    },
  },
  {
    // ② 已连 QBO + 绿色通道关 —— 演示全人工复核的常规客户
    id: "client-cafe",
    name: "Bloor Street Café",
    industry: "咖啡馆",
    province: "ON",
    taxNumber: "802556113RT0001",
    contactEmail: "manager@bloorstreetcafe.ca",
    qboRealmId: "9130348",
    qboPaymentAccountId: "35",
    autoPostEnabled: false,
    autoPostThreshold: null,
    vendors: [
      { name: "Moneris", weight: 8, amount: [46, 210], lines: ["Merchant processing 收单手续费"], itc: "complete", settlement: "paid" },
      { name: "Enbridge Gas", weight: 6, amount: [130, 380], lines: ["Natural gas 天然气"], itc: "complete", settlement: "unpaid" },
      // 行业专属，不在商户表
      { name: "Mother Parkers Coffee", weight: 7, amount: [280, 960], lines: ["Espresso beans 意式豆", "Filter beans 手冲豆"], itc: "no_supplier_tax", settlement: "unpaid", offCatalog: true, reviewAccountId: "85" },
      { name: "Rogers Communications", weight: 3, amount: [88, 132], lines: ["Store internet 门店宽带"], itc: "complete", settlement: "unpaid" },
      { name: "DoorDash", weight: 3, amount: [24, 96], lines: ["Delivery commission 外送佣金"], itc: "complete", settlement: "paid" },
      { name: "Canada Post", weight: 2, amount: [16, 54], lines: ["Postage 邮费"], itc: "complete", settlement: "paid" },
      // 多类目单据 → 飞轮不写规则（真实存在，且是规则表该有的克制）
      { name: "Home Depot", weight: 2, amount: [120, 480], lines: ["Repair parts 维修配件", "Cleaning supplies 清洁用品"], itc: "complete", settlement: "paid", mixedAccounts: true },
      { name: "Aviva Insurance", weight: 1, amount: [380, 520], lines: ["Commercial property 商业财产险"], itc: "no_recipient", settlement: "unpaid" },
    ],
    plan: {
      synced: 12,
      needs_review: 5,
      confirmed: 1,
      received: 1,
      classifying: 1,
      sync_failed: 1,
      rejected: 1,
    },
  },
  {
    // ③ 未连 QBO —— 单据堆在 confirmed（契约 §4.2：未连是一等状态，不是错误）
    //    同时是 BC 省 → 走另一套税码表
    id: "client-build",
    name: "Riverside Contracting",
    industry: "建筑承包",
    province: "BC",
    taxNumber: "814907233RT0001",
    contactEmail: "ap@riversidecontracting.ca",
    qboRealmId: null,
    qboPaymentAccountId: null,
    autoPostEnabled: false,
    autoPostThreshold: null,
    vendors: [
      { name: "Home Depot", weight: 9, amount: [140, 1250], lines: ["Lumber & fasteners 木材与紧固件"], itc: "complete", settlement: "paid" },
      { name: "Petro-Canada", weight: 7, amount: [78, 190], lines: ["Fleet fuel 车队加油"], itc: "complete", settlement: "paid" },
      // 行业专属，不在商户表
      { name: "Brant Ready-Mix Concrete", weight: 6, amount: [820, 3400], lines: ["Ready-mix delivery 混凝土配送"], itc: "no_supplier_tax", settlement: "unpaid", offCatalog: true, reviewAccountId: "85" },
      { name: "RONA", weight: 3, amount: [95, 640], lines: ["Site hardware 工地五金"], itc: "complete", settlement: "paid" },
      { name: "Esso", weight: 2, amount: [62, 155], lines: ["Fuel 加油"], itc: "complete", settlement: "paid" },
      { name: "Telus", weight: 2, amount: [110, 165], lines: ["Crew mobile plans 班组手机套餐"], itc: "complete", settlement: "unpaid" },
      { name: "Aviva Insurance", weight: 1, amount: [640, 890], lines: ["Contractor liability 承包商责任险"], itc: "no_recipient", settlement: "unpaid" },
    ],
    plan: {
      confirmed: 10,
      needs_review: 5,
      received: 1,
      ocr_processing: 1,
      ocr_failed: 1,
    },
  },
];

/** 刻意无收据的日常支出 → 对账页的「缺收据清单」（与真实单据派生的流水共存）。 */
export const NO_RECEIPT_TXNS: Record<string, { desc: string; amount: number; dayOffset: number }[]> = {
  "client-demo": [
    { desc: "PETRO-CANADA 04412 TORONTO", amount: 92.15, dayOffset: -6 },
    { desc: "TIM HORTONS #4021", amount: 18.4, dayOffset: -4 },
    { desc: "SQUARE *DENTAL SUPPLY CO", amount: 418.0, dayOffset: -3 },
    { desc: "STARBUCKS #1123 YONGE ST", amount: 26.75, dayOffset: -1 },
    { desc: "MONTHLY ACCOUNT FEE", amount: 10.95, dayOffset: 0 },
  ],
  "client-cafe": [
    { desc: "UBER *EATS COMMISSION", amount: 64.2, dayOffset: -8 },
    { desc: "LCBO #217 BLOOR ST", amount: 148.9, dayOffset: -5 },
    { desc: "MONTHLY ACCOUNT FEE", amount: 10.95, dayOffset: 0 },
  ],
  "client-build": [
    { desc: "ESSO CIRCLE K #8823", amount: 71.4, dayOffset: -9 },
    { desc: "CITY OF BURNABY PERMIT", amount: 245.0, dayOffset: -7 },
    { desc: "A&W #3312 KINGSWAY", amount: 32.6, dayOffset: -2 },
  ],
};

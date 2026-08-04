// 加拿大常见商户 → 科目类别 种子表（冷启动优先级，per-client 规则/Claude 之外的兜底）。
// 只覆盖「强单一类目」的头部商户；含糊的（Amazon/Costco/Walmart）故意不收，交人工/Claude。
// 映射到「类别关键词」而非具体科目 id —— 再按候选科目表(GlAccountCache/QBO)的名字匹配，
// 所以换成真实 QBO 科目表也无需改这张表。
import type { Classification, ClassifyInput, GlAccountRef } from "./classifier";

type Category =
  | "meals"
  | "office"
  | "telephone"
  | "utilities"
  | "fuel"
  | "repairs"
  | "software"
  | "travel"
  | "insurance"
  | "shipping"
  | "bank"
  | "advertising";

// 每个类别 → 用于在候选科目名里定位对应科目的关键词（中英都给，兼容双语科目名）。
const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  // ⚠️ 关键词避免过短/易碰撞的子串（如"公用"⊂"办公用品"、"fees"⊂"Professional Fees"）。
  meals: ["meals", "entertainment", "restaurant", "餐饮", "招待"],
  office: ["office supplies", "office", "办公"],
  telephone: ["telephone", "internet", "电话", "网络", "通讯"],
  utilities: ["utilities", "hydro", "water", "水电"],
  fuel: ["fuel", "vehicle", "汽车"],
  repairs: ["repairs", "maintenance", "维修", "保养"],
  software: ["software", "subscription", "saas", "软件", "订阅"],
  travel: ["travel", "airfare", "差旅", "交通"],
  insurance: ["insurance", "保险"],
  shipping: ["shipping", "delivery", "postage", "courier", "运费", "快递", "邮寄"],
  bank: ["bank charges", "merchant", "银行", "手续费"],
  advertising: ["advertising", "promotion", "marketing", "广告", "推广", "营销"],
};

// pattern：小写、与供应商名做 includes 匹配。
const VENDOR_SEED: { pattern: string; category: Category }[] = [
  // 建材 / 五金 → 维修保养
  { pattern: "home depot", category: "repairs" },
  { pattern: "rona", category: "repairs" },
  { pattern: "lowe", category: "repairs" },
  { pattern: "home hardware", category: "repairs" },
  // 加油 → 车辆/油费
  { pattern: "petro-canada", category: "fuel" },
  { pattern: "petro canada", category: "fuel" },
  { pattern: "esso", category: "fuel" },
  { pattern: "shell", category: "fuel" },
  { pattern: "ultramar", category: "fuel" },
  { pattern: "husky", category: "fuel" },
  { pattern: "pioneer", category: "fuel" },
  // 电信 → 电话网络
  { pattern: "bell", category: "telephone" },
  { pattern: "rogers", category: "telephone" },
  { pattern: "telus", category: "telephone" },
  { pattern: "fido", category: "telephone" },
  { pattern: "koodo", category: "telephone" },
  { pattern: "freedom mobile", category: "telephone" },
  { pattern: "virgin plus", category: "telephone" },
  // 水电煤 → 水电杂费
  { pattern: "hydro", category: "utilities" }, // hydro one / toronto hydro / bc hydro …
  { pattern: "enbridge", category: "utilities" },
  { pattern: "fortis", category: "utilities" },
  { pattern: "epcor", category: "utilities" },
  // 办公用品
  { pattern: "staples", category: "office" },
  { pattern: "grand & toy", category: "office" },
  { pattern: "grand and toy", category: "office" },
  // 软件 / 订阅
  { pattern: "shopify", category: "software" },
  { pattern: "google", category: "software" },
  { pattern: "microsoft", category: "software" },
  { pattern: "adobe", category: "software" },
  { pattern: "zoom", category: "software" },
  { pattern: "intuit", category: "software" },
  { pattern: "quickbooks", category: "software" },
  { pattern: "slack", category: "software" },
  { pattern: "dropbox", category: "software" },
  { pattern: "godaddy", category: "software" },
  { pattern: "mailchimp", category: "software" },
  { pattern: "aws", category: "software" },
  // 差旅 / 交通
  { pattern: "uber", category: "travel" },
  { pattern: "lyft", category: "travel" },
  { pattern: "air canada", category: "travel" },
  { pattern: "westjet", category: "travel" },
  { pattern: "via rail", category: "travel" },
  { pattern: "porter", category: "travel" },
  { pattern: "expedia", category: "travel" },
  { pattern: "airbnb", category: "travel" },
  // 餐饮
  { pattern: "tim hortons", category: "meals" },
  { pattern: "starbucks", category: "meals" },
  { pattern: "mcdonald", category: "meals" },
  { pattern: "a&w", category: "meals" },
  { pattern: "subway", category: "meals" },
  { pattern: "boston pizza", category: "meals" },
  { pattern: "pizza pizza", category: "meals" },
  { pattern: "skip the dishes", category: "meals" },
  { pattern: "doordash", category: "meals" },
  { pattern: "ubereats", category: "meals" },
  // 保险
  { pattern: "aviva", category: "insurance" },
  { pattern: "intact", category: "insurance" },
  { pattern: "sun life", category: "insurance" },
  { pattern: "manulife", category: "insurance" },
  { pattern: "co-operators", category: "insurance" },
  // 运费 / 快递
  { pattern: "canada post", category: "shipping" },
  { pattern: "ups", category: "shipping" },
  { pattern: "fedex", category: "shipping" },
  { pattern: "purolator", category: "shipping" },
  { pattern: "dhl", category: "shipping" },
  // 收单 / 支付手续费
  { pattern: "square", category: "bank" },
  { pattern: "stripe", category: "bank" },
  { pattern: "moneris", category: "bank" },
  { pattern: "paypal", category: "bank" },
];

function findAccountForCategory(category: Category, accounts: GlAccountRef[]): GlAccountRef | undefined {
  const kws = CATEGORY_KEYWORDS[category];
  return accounts.find((a) => {
    const n = a.name.toLowerCase();
    return kws.some((k) => n.includes(k));
  });
}

// 命中常见商户 → 该类别在候选科目里能找到对应科目 → 返回 medium（预设优先级，需人工确认）。
export function matchVendorSeed(input: ClassifyInput): Classification | null {
  const v = (input.vendorName ?? "").toLowerCase().trim();
  if (!v) return null;
  const hit = VENDOR_SEED.find((e) => v.includes(e.pattern));
  if (!hit) return null;
  const acct = findAccountForCategory(hit.category, input.accounts);
  if (!acct) return null;
  return {
    glAccountId: acct.qboAccountId,
    glAccountName: acct.name,
    confidence: "medium",
    reason: `常见商户预设（${hit.pattern} → ${hit.category}）`,
    source: "seed",
  };
}

// 发票生成 + 注入式 OCR provider。
//
// 为什么不用 MockOcrProvider：它按文件名哈希派生，供应商池只有 5 个、不分行业，
// 生成的数据会呈现「一个实体循环」的假象。这里改成**先设计好每张发票**，
// 再通过 ocr-factory 的 setOcrProvider() 注入替身（那个钩子就是为此准备的），
// 让 processDocument 走的仍是完整真实链路，只有识别结果的来源是设计过的。

import type { OcrExtraction, OcrInput, OcrProvider } from "@/lib/providers";
import type { ClientSpec, VendorProfile } from "./catalog";

/** mulberry32：种子化 PRNG，保证同一 seed 每次生成同一批数据（可复现，便于回归）。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 金额一律走整数分再转 decimal 字符串，避免浮点误差破坏「单据总额 == Σ 行项」不变量。 */
const cents = (n: number) => Math.round(n * 100);
const money = (c: number) => (c / 100).toFixed(2);

export type InvoiceSpec = {
  key: string; // 稳定唯一键 → 文件名 → OCR 查表键 + 文件指纹
  clientId: string;
  vendor: VendorProfile;
  /** 目标状态：决定这张单据在事件重放里走到哪一段就停 */
  target: string;
  dayOffset: number; // 相对今天的天数（负 = 过去）
  extraction: OcrExtraction;
  /** 行项目应归的科目类别数（>1 → 学习飞轮不写规则） */
  mixedAccounts: boolean;
};

function pickVendor(vendors: VendorProfile[], rng: () => number): VendorProfile {
  const total = vendors.reduce((s, v) => s + v.weight, 0);
  let r = rng() * total;
  for (const v of vendors) {
    r -= v.weight;
    if (r <= 0) return v;
  }
  return vendors[vendors.length - 1];
}

function buildExtraction(
  client: ClientSpec,
  vendor: VendorProfile,
  taxRate: number,
  txnDate: Date,
  seq: number,
  rng: () => number,
): OcrExtraction {
  const [lo, hi] = vendor.amount;
  const subTotalC = cents(lo + rng() * (hi - lo));
  const taxC = Math.round(subTotalC * taxRate);
  const totalC = subTotalC + taxC;

  // 行项目金额之和必须**精确等于**税前金额：最后一行吃掉舍入尾差。
  const n = vendor.lines.length;
  const lines = vendor.lines.map((desc, i) => {
    const amountC = i === n - 1 ? subTotalC - Math.floor(subTotalC / n) * (n - 1) : Math.floor(subTotalC / n);
    return { description: desc, amount: money(amountC) };
  });

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const due = new Date(txnDate);
  due.setDate(due.getDate() + 30);

  // 凭证要件缺口（契约 §4.9）——复核队列的风险排序靠它才有区分度。
  const supplierTaxNumber =
    vendor.itc === "no_supplier_tax" ? null : `${100000000 + ((seq * 7919) % 899999999)}RT0001`;
  const recipientName = vendor.itc === "no_recipient" ? null : client.name;
  const paymentTerms = vendor.itc === "no_recipient" ? null : vendor.settlement === "paid" ? "Paid by card" : "Net 30";

  return {
    vendorName: vendor.name,
    invoiceNo: `${vendor.name.slice(0, 3).toUpperCase()}-${String(10000 + seq).slice(-5)}`,
    txnDate: iso(txnDate),
    dueDate: vendor.settlement === "unpaid" ? iso(due) : null,
    currency: "CAD",
    subTotal: money(subTotalC),
    taxAmount: money(taxC),
    total: money(totalC),
    supplierTaxNumber,
    recipientName,
    paymentTerms,
    settlementHint: vendor.settlement,
    lines,
    // 表外供应商（行业专属耗材）识别得没那么稳 —— 演示低置信度必须人工看
    overallConfidence: vendor.offCatalog ? "low" : "high",
    fieldConfidence: vendor.offCatalog
      ? { vendorName: 0.58, invoiceNo: 0.44, total: 0.72, txnDate: 0.81 }
      : { vendorName: 0.97, invoiceNo: 0.91, total: 0.96, txnDate: 0.94 },
    suggestedCategory: null,
    raw: { provider: "seed", vendor: vendor.name, note: "seed 设计数据，非真实 OCR 输出" },
  };
}

/** 为一个客户按 plan 生成全部发票，时间铺在过去 weeks 周内，按日期升序返回。
 *  升序很重要：事件重放必须按时间顺序，confirmedCount 才会像真实使用一样逐步长起来。 */
export function buildInvoices(client: ClientSpec, taxRate: number, weeks: number, rng: () => number): InvoiceSpec[] {
  const targets: string[] = [];
  for (const [state, count] of Object.entries(client.plan)) {
    for (let i = 0; i < count; i++) targets.push(state);
  }

  const spanDays = weeks * 7;
  const specs = targets.map((target, i) => {
    // 未走完的状态（收单/识别中/待复核）集中在近期，已完成的铺在更早 —— 真实系统就是这个形状
    const fresh = target !== "synced" && target !== "confirmed";
    const dayOffset = fresh
      ? -Math.floor(rng() * 12) - 1
      : -Math.floor(12 + rng() * (spanDays - 12));

    const vendor = pickVendor(client.vendors, rng);
    const txnDate = new Date();
    txnDate.setHours(12, 0, 0, 0);
    txnDate.setDate(txnDate.getDate() + dayOffset);

    return {
      key: `${client.id}-${String(i).padStart(3, "0")}`,
      clientId: client.id,
      vendor,
      target,
      dayOffset,
      extraction: buildExtraction(client, vendor, taxRate, txnDate, i, rng),
      mixedAccounts: vendor.mixedAccounts === true,
    };
  });

  return specs.sort((a, b) => a.dayOffset - b.dayOffset);
}

/** 注入式 OCR：按文件名查表返回设计好的识别结果。
 *  标记为 fail 的文件抛错 → 走真实的 ocr_failed 分支（不是硬改状态）。 */
export class SeedOcrProvider implements OcrProvider {
  readonly name = "seed-ocr";
  private byFile = new Map<string, OcrExtraction>();
  private failing = new Set<string>();

  register(fileName: string, extraction: OcrExtraction, shouldFail: boolean): void {
    this.byFile.set(fileName, extraction);
    if (shouldFail) this.failing.add(fileName);
  }

  async extract(input: OcrInput): Promise<OcrExtraction> {
    if (this.failing.has(input.fileName)) {
      throw new Error("Seed 模拟：识别服务返回 422，文件页面损坏无法解析");
    }
    const hit = this.byFile.get(input.fileName);
    if (!hit) throw new Error(`Seed OCR 未注册的文件：${input.fileName}`);
    return hit;
  }
}

/** 每张单据一份独一无二的字节流 —— 收单去重靠 fileHash，重复字节会被当成重复单据。 */
export function fakeFileBytes(key: string, vendorName: string): Uint8Array {
  const body = `%PDF-1.4\n% easetax seed document\n% key=${key}\n% vendor=${vendorName}\n% ${"x".repeat(64)}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

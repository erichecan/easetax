// 银行流水 ↔ 单据的自动匹配（契约 §4.6）：**derived，实时算，不物化**。
// 人工确认/否决（matchStatus manual|ignored）才是 canonical，落在 BankTxn 上，优先于本文算法。
// 真实银行金额常 ≠ 发票 total（税舍入、合并付款、汇率），故用容差而非精确相等。

export type ReconTxn = {
  id: string;
  date: Date;
  description: string;
  amount: number;
  matchedDocumentId: string | null;
  matchStatus: string;
};

export type ReconDoc = {
  id: string;
  fileName: string;
  vendorName: string | null;
  total: number | null;
  txnDate: Date | null;
};

export type MatchKind = "manual" | "auto" | "ignored" | "none";

const DAY_MS = 86_400_000;
const MAX_DAYS_APART = 5; // 银行入账延迟：刷卡/预授权到账常滞后数日
const MIN_TOKEN_LEN = 3;

// 金额容差：绝对 5 分与 1% 取大——覆盖税舍入与小额手续费差。
function amountMatches(docTotal: number, txnAmount: number): boolean {
  return Math.abs(docTotal - txnAmount) <= Math.max(0.05, txnAmount * 0.01);
}

function daysApart(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / DAY_MS;
}

// 供应商名首个有效 token 出现在银行摘要里（银行摘要通常是大写商户名 + 门店号）。
function vendorInDescription(vendorName: string, description: string): boolean {
  const token = vendorName.split(/[\s.,*#-]+/).filter(Boolean)[0]?.toUpperCase();
  if (!token || token.length < MIN_TOKEN_LEN) return false;
  return description.toUpperCase().includes(token);
}

export function autoMatch(txn: ReconTxn, docs: ReconDoc[]): ReconDoc | null {
  return (
    docs.find(
      (d) =>
        d.total != null &&
        d.txnDate != null &&
        d.vendorName != null &&
        amountMatches(d.total, txn.amount) &&
        daysApart(d.txnDate, txn.date) <= MAX_DAYS_APART &&
        vendorInDescription(d.vendorName, txn.description),
    ) ?? null
  );
}

// 一对一：一张单据只能核销一笔付款。同一商户同额的多张单据（含重复件）
// 若不排他，会让每笔流水都匹配到同一张收据，把真实缺口盖住。

export type ReconResult = {
  txnId: string;
  matchKind: MatchKind;
  matchedDocId: string | null;
  matchedFileName: string | null;
};

// 逐笔求解：人工裁决优先 → 否则实时自动匹配。
export function reconcile(txns: ReconTxn[], docs: ReconDoc[]): ReconResult[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const results = new Map<string, ReconResult>();

  // 第一轮：人工裁决（canonical）先占位，自动匹配不得抢占已人工绑定的单据。
  const taken = new Set<string>();
  for (const txn of txns) {
    if (txn.matchStatus === "ignored") {
      results.set(txn.id, { txnId: txn.id, matchKind: "ignored", matchedDocId: null, matchedFileName: null });
    } else if (txn.matchStatus === "manual" && txn.matchedDocumentId) {
      taken.add(txn.matchedDocumentId);
      results.set(txn.id, {
        txnId: txn.id,
        matchKind: "manual",
        matchedDocId: txn.matchedDocumentId,
        matchedFileName: byId.get(txn.matchedDocumentId)?.fileName ?? null,
      });
    }
  }

  // 第二轮：其余流水按日期先后自动匹配，命中的单据即被占用。
  for (const txn of txns) {
    if (results.has(txn.id)) continue;
    const hit = autoMatch(
      txn,
      docs.filter((d) => !taken.has(d.id)),
    );
    if (hit) taken.add(hit.id);
    results.set(
      txn.id,
      hit
        ? { txnId: txn.id, matchKind: "auto", matchedDocId: hit.id, matchedFileName: hit.fileName }
        : { txnId: txn.id, matchKind: "none", matchedDocId: null, matchedFileName: null },
    );
  }

  return txns.map((t) => results.get(t.id)!);
}

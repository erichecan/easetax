// 追票工单（契约 §4.12）：把「缺收据」变成可执行的催票动作。
// 只存催过没有（ChaseNotice），是否已解决由 BankTxn 当前匹配状态派生。
import type { ReconRow } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });

export type ChaseDraft = {
  subject: string;
  body: string;
  txnIds: string[];
};

// 生成一封催票邮件：把缺收据的流水逐笔列出来，客户照着找票即可。
export function buildChaseDraft(clientName: string, rows: ReconRow[], period: string): ChaseDraft {
  const missing = rows.filter((r) => r.matchKind === "none");
  const lines = missing.map((r) => `  · ${r.txn.date}  ${r.txn.description}  ${money(r.txn.amount)}`);
  const total = missing.reduce((s, r) => s + r.txn.amount, 0);

  const body = [
    `${clientName} 您好，`,
    "",
    `在核对${period ? `${period}的` : ""}银行流水时，以下 ${missing.length} 笔支出还没有对应的收据/发票：`,
    "",
    ...lines,
    "",
    `合计 ${money(total)}。`,
    "",
    "麻烦把这些票据拍照或转发到您的专属收单邮箱，我们收到后会自动入账。",
    "没有票据的支出无法作为费用抵扣，也拿不回进项税（ITC），所以尽量补齐。",
    "",
    "谢谢！",
  ].join("\n");

  return {
    subject: `【易账】${clientName} — ${missing.length} 笔支出待补收据`,
    body,
    txnIds: missing.map((r) => r.txn.id),
  };
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getClient, getItcReport } from "@/lib/queries";
import { ITC_REQUIREMENT_LABELS, type ItcRequirement } from "@/domain";

const money = (n: number) => n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });

const TIER_LABEL: Record<string, string> = {
  under_30: "< $30",
  under_150: "$30–150",
  over_150: "≥ $150",
};

export default async function ItcReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { from, to } = await searchParams;
  const client = await getClient(session.firmId, id);
  if (!client) notFound();

  const { rows, unrecoverableTax, period } = await getItcReport(session.firmId, id, { from, to });
  const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <Link href={`/clients/${id}`} className="text-sm text-muted transition-colors hover:text-ink-900">
        ← {client.name} · 流程工作台
      </Link>

      <header className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">不可抵扣清单</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            这些单据的凭证不满足 CRA 抵扣要件，<strong className="text-ink-900">费用照记，但进项税抵不了</strong>。
            月末拿这份清单向客户索要完整发票，补齐后金额会自动从这里消失。
          </p>
        </div>
        {rows.length > 0 && (
          <a
            href={`/api/clients/${id}/itc-report${qs ? `?${qs}` : ""}`}
            className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:text-ink-900"
          >
            导出 CSV
          </a>
        )}
      </header>

      {/* 期间筛选走 URL 参数，服务端筛，刷新即生效 */}
      <form className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4">
        <label className="block">
          <span className="text-xs text-faint">起（账单日）</span>
          <input
            type="date"
            name="from"
            defaultValue={from ?? ""}
            className="mt-1 block rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
          />
        </label>
        <label className="block">
          <span className="text-xs text-faint">止</span>
          <input
            type="date"
            name="to"
            defaultValue={to ?? ""}
            className="mt-1 block rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
          />
        </label>
        <button className="rounded-lg bg-ink-700 px-3 py-2 text-sm font-semibold text-white hover:bg-ink-800">
          筛选
        </button>
        {(from || to) && (
          <Link href={`/clients/${id}/itc-report`} className="pb-2 text-xs text-muted hover:text-ink-900">
            清除
          </Link>
        )}
      </form>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-conf-low/30 bg-conf-low-bg/40 p-5">
          <div className="text-[11px] uppercase tracking-wider text-conf-low">不可抵扣进项税</div>
          <div className="tnum mt-1 font-display text-2xl font-bold text-conf-low">{money(unrecoverableTax)}</div>
          <div className="mt-0.5 text-xs text-muted">{period} · 涉及 {rows.length} 张单据</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5">
          <div className="text-[11px] uppercase tracking-wider text-faint">口径</div>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            只统计<strong className="text-ink-900">税额</strong>，不是票面总额 —— 凭证不全影响的是进项税抵扣，
            费用本身照常入账。已录入 QBO 的单据仍会列出，因为抵扣资格与是否入账无关。
          </p>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-4 py-3 font-semibold">账单日</th>
              <th className="px-4 py-3 font-semibold">供应商</th>
              <th className="px-4 py-3 text-right font-semibold">票面总额</th>
              <th className="px-4 py-3 text-right font-semibold">不可抵税额</th>
              <th className="px-4 py-3 font-semibold">缺什么</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper">
                <td className="tnum whitespace-nowrap px-4 py-2.5 text-muted">{r.txnDate || "—"}</td>
                <td className="px-4 py-2.5">
                  <div className="text-ink-900">{r.vendor}</div>
                  <div className="text-[11px] text-faint">
                    {r.fileName}
                    {r.tier && ` · ${TIER_LABEL[r.tier]}`}
                  </div>
                </td>
                <td className="tnum px-4 py-2.5 text-right text-ink-900">{money(r.total)}</td>
                <td className="tnum px-4 py-2.5 text-right font-medium text-conf-low">{money(r.taxAmount)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {r.missing.map((m) => (
                      <span key={m} className="rounded bg-conf-low-bg px-1.5 py-0.5 text-[11px] text-conf-low">
                        {ITC_REQUIREMENT_LABELS[m as ItcRequirement] ?? m}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Link
                    href={`/documents/${r.id}/review`}
                    className="whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold text-ink-700 hover:bg-ink-700/10"
                  >
                    去补件 →
                  </Link>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-conf-high">
                  ✓ 该期间没有凭证缺件的单据，进项税全部可抵
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

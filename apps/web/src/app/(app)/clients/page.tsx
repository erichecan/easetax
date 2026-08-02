import Link from "next/link";
import { requireSession } from "@/lib/session";
import { getClientsForFirm } from "@/lib/queries";
import { NewClientDialog } from "@/components/new-client-dialog";

export default async function ClientsPage() {
  const session = await requireSession();
  const clients = await getClientsForFirm(session.firmId);
  const totalReview = clients.reduce((s, c) => s + c.stats.review, 0);
  const totalInbox = clients.reduce((s, c) => s + c.stats.inbox, 0);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">全部客户</h1>
          <p className="mt-1 text-sm text-muted">
            共 {clients.length} 家客户 · 待复核 {totalReview} 张 · 新到 {totalInbox} 张
          </p>
        </div>
        <NewClientDialog />
      </header>

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {clients.map((c) => (
          <Link
            key={c.id}
            href={`/clients/${c.id}`}
            className="rise group rounded-xl border border-line bg-surface p-5 transition-all hover:border-line-strong hover:shadow-[0_2px_16px_-4px_rgba(31,77,63,0.12)]"
          >
            <div className="flex items-start justify-between">
              <div className="grid size-11 place-items-center rounded-lg bg-ink-700/8 font-display text-lg font-bold text-ink-700">
                {c.name.slice(0, 1)}
              </div>
              {c.qboConnected ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-conf-high">
                  <span className="size-1.5 rounded-full bg-conf-high" /> QBO 已连接
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-faint">
                  <span className="size-1.5 rounded-full bg-line-strong" /> 未连接
                </span>
              )}
            </div>

            <h2 className="mt-4 font-medium text-ink-900">{c.name}</h2>
            <p className="text-xs text-faint">{c.industry}</p>

            {/* 口径与工作台的流程轨道一致：机器在跑的 / 等你动手的 / 已完成的 */}
            <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
              <Stat label="①–③ 处理中" value={c.stats.inbox} tone="text-muted" />
              <Stat label="④ 待复核" value={c.stats.review} tone={c.stats.review > 0 ? "text-gold-700" : "text-faint"} />
              <Stat label="⑤ 已录入" value={c.stats.synced} tone="text-conf-high" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <div className={`tnum font-display text-xl font-bold ${tone}`}>{value}</div>
      <div className="text-[11px] text-faint">{label}</div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Client } from "@/lib/types";

export function Sidebar({
  clients,
  firmName,
  activeClientId,
}: {
  clients: Client[];
  firmName: string;
  activeClientId?: string | null;
}) {
  const path = usePathname();
  const router = useRouter();
  // 客户页从 URL 取；复核页 URL 里没有 clientId，由服务端反查后传进来。
  const activeClient = path.match(/\/clients\/([^/]+)/)?.[1] ?? activeClientId ?? undefined;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid size-9 place-items-center rounded-lg bg-ink-700 font-display text-lg font-bold text-white">
          易
        </div>
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold text-ink-900">{firmName}</div>
          <div className="text-[11px] tracking-wide text-faint">AP 工作台 · Easetax</div>
        </div>
      </div>

      <Link
        href="/clients"
        className={`mx-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          path === "/clients"
            ? "bg-ink-700/10 text-ink-700"
            : "text-muted hover:bg-paper hover:text-ink-900"
        }`}
      >
        <span className="text-base">◧</span> 全部客户
      </Link>

      <div className="px-5 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-wider text-faint">
        客户
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {clients.map((c) => {
          const active = activeClient === c.id;
          const pending = c.stats.inbox + c.stats.review;
          return (
            <div key={c.id}>
              <Link
                href={`/clients/${c.id}`}
                className={`group flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? "bg-ink-700/10 text-ink-900" : "text-muted hover:bg-paper hover:text-ink-900"
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      c.qboConnected ? "bg-conf-high" : "bg-line-strong"
                    }`}
                  />
                  <span className="truncate">{c.name}</span>
                </span>
                {pending > 0 && (
                  <span className="tnum shrink-0 rounded-full bg-gold-50 px-1.5 text-[11px] font-semibold text-gold-700">
                    {pending}
                  </span>
                )}
              </Link>

              {/* 展开的客户按「主链 → 护栏 → 配置」排，与流程文档同序 */}
              {active && (
                <div className="mb-1 ml-[18px] space-y-px border-l border-line pl-3">
                  <SubLink href={`/clients/${c.id}`} label="流程工作台" current={path === `/clients/${c.id}`} />
                  <SubLink
                    href={`/clients/${c.id}/reconciliation`}
                    label="银行对账 · 追票"
                    current={path.endsWith("/reconciliation")}
                  />
                  <SubLink
                    href={`/clients/${c.id}/rules`}
                    label="分类规则"
                    current={path.endsWith("/rules")}
                  />
                  <SubLink
                    href={`/clients/${c.id}/audit`}
                    label="审计日志"
                    current={path.endsWith("/audit")}
                  />
                  <SubLink
                    href={`/clients/${c.id}/settings`}
                    label="客户设置"
                    current={path.endsWith("/settings")}
                  />
                </div>
              )}
            </div>
          );
        })}
        {clients.length === 0 && (
          <div className="px-3 py-2 text-xs text-faint">暂无客户</div>
        )}
      </nav>

      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-full bg-ink-700/10 text-sm font-semibold text-ink-700">
              会
            </div>
            <div className="leading-tight">
              <div className="text-sm font-medium text-ink-900">会计师</div>
              <div className="text-[11px] text-faint">Accountant</div>
            </div>
          </div>
          <button
            onClick={logout}
            className="rounded-md px-2 py-1 text-[11px] text-faint transition-colors hover:bg-paper hover:text-ink-900"
          >
            登出
          </button>
        </div>
      </div>
    </aside>
  );
}

function SubLink({ href, label, current }: { href: string; label: string; current: boolean }) {
  return (
    <Link
      href={href}
      className={`block rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
        current ? "font-medium text-ink-700" : "text-muted hover:text-ink-900"
      }`}
    >
      {label}
    </Link>
  );
}

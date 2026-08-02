"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MIN_RULE_CONFIRMATIONS } from "@/domain";
import type { GlAccount, RuleRow } from "@/lib/types";

// 规则管理。规则优先于 AI（业务流程设计 §2.3），所以一条错规则的破坏力比 AI 猜错大得多 ——
// 必须能看见每条规则被人工确认过几次，以及它是否已经达到绿色通道的信任门槛。
export function RulesManager({
  clientId,
  rules,
  accounts,
}: {
  clientId: string;
  rules: RuleRow[];
  accounts: GlAccount[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ matchType: "keyword", matchValue: "", glAccountId: "" });

  async function call(method: string, body?: unknown, query = "") {
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/rules${query}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "操作失败");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("网络错误");
      return false;
    }
  }

  async function create() {
    if (!form.matchValue.trim() || !form.glAccountId) return;
    setBusy("create");
    if (await call("POST", form)) {
      setForm({ matchType: "keyword", matchValue: "", glAccountId: "" });
      setCreating(false);
    }
    setBusy(null);
  }

  async function changeAccount(id: string, glAccountId: string) {
    setBusy(id);
    await call("PATCH", { id, glAccountId });
    setBusy(null);
  }

  async function remove(r: RuleRow) {
    if (!window.confirm(`删除规则？\n\n${r.matchValue} → ${r.glAccountName}\n\n之后该供应商/关键词的单据会重新走 AI 分类。`)) return;
    setBusy(r.id);
    await call("DELETE", undefined, `?ruleId=${encodeURIComponent(r.id)}`);
    setBusy(null);
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-ink-900">
          分类规则 <span className="text-sm font-normal text-faint">{rules.length} 条</span>
        </h2>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-ink-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-ink-800"
          >
            + 新建规则
          </button>
        )}
      </div>

      {error && <div className="mt-3 rounded-lg bg-conf-low-bg px-3 py-2 text-sm text-conf-low">{error}</div>}

      {creating && (
        <div className="mt-3 rounded-xl border border-line bg-surface p-4">
          <div className="grid gap-2 sm:grid-cols-[110px_1fr_1fr]">
            <select
              value={form.matchType}
              onChange={(e) => setForm({ ...form, matchType: e.target.value })}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            >
              <option value="keyword">关键词</option>
              <option value="vendor">供应商</option>
            </select>
            <input
              autoFocus
              value={form.matchValue}
              onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
              placeholder={form.matchType === "vendor" ? "供应商名（完全匹配）" : "关键词（出现在描述里即命中）"}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            />
            <select
              value={form.glAccountId}
              onChange={(e) => setForm({ ...form, glAccountId: e.target.value })}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            >
              <option value="">— 选择科目 —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={create}
              disabled={busy === "create" || !form.matchValue.trim() || !form.glAccountId}
              className="rounded-md bg-ink-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              {busy === "create" ? "创建中…" : "创建"}
            </button>
            <button onClick={() => setCreating(false)} className="px-2 text-xs text-muted hover:text-ink-900">
              取消
            </button>
            <span className="text-[11px] text-faint">
              手工建的规则确认次数从 0 起算，要真实复核确认 {MIN_RULE_CONFIRMATIONS} 次才够绿色通道门槛
            </span>
          </div>
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-4 py-3 font-semibold">类型</th>
              <th className="px-4 py-3 font-semibold">匹配值</th>
              <th className="px-4 py-3 font-semibold">记到科目</th>
              <th className="px-4 py-3 font-semibold">人工确认</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const trusted = r.confirmedCount >= MIN_RULE_CONFIRMATIONS;
              return (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper">
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-paper px-2 py-0.5 text-[11px] text-muted">
                      {r.matchType === "vendor" ? "供应商" : "关键词"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-ink-900">{r.matchValue}</td>
                  <td className="px-4 py-2.5">
                    <select
                      value={r.glAccountId}
                      disabled={busy === r.id}
                      onChange={(e) => changeAccount(r.id, e.target.value)}
                      className="w-full max-w-[240px] rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-900 disabled:opacity-50"
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                      {!accounts.some((a) => a.id === r.glAccountId) && (
                        <option value={r.glAccountId}>{r.glAccountName}（已不在科目表）</option>
                      )}
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      title={
                        trusted
                          ? "已达绿色通道门槛，命中此规则的单据可能自动过账"
                          : `还需 ${MIN_RULE_CONFIRMATIONS - r.confirmedCount} 次人工确认才够绿色通道门槛`
                      }
                      className={`tnum rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        trusted ? "bg-conf-high-bg text-conf-high" : "bg-paper text-muted"
                      }`}
                    >
                      {r.confirmedCount} 次{trusted ? " · 已达门槛" : ""}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => remove(r)}
                      disabled={busy === r.id}
                      className="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-conf-low disabled:opacity-50"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
            {rules.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-faint">
                  还没有规则。复核确认时若整单归同一科目，系统会自动学成供应商规则。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

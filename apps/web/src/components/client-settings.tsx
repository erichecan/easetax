"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PROVINCES, PROVINCE_NAMES, AUTO_POST_GATE_LABELS, DEFAULT_AUTO_POST_THRESHOLD } from "@/domain";
import type { Client, GlAccount, TaxCodeRef } from "@/lib/types";
import { TaxCodeMapper } from "./tax-code-mapper";

export function ClientSettings({
  client,
  accounts,
  taxCodes,
  qboJustConnected,
}: {
  client: Client;
  accounts: GlAccount[];
  taxCodes: TaxCodeRef[];
  qboJustConnected?: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    province: client.province ?? "",
    taxNumber: client.taxNumber ?? "",
    qboPaymentAccountId: client.qboPaymentAccountId ?? "",
    autoPostEnabled: client.autoPostEnabled,
    autoPostThreshold: client.autoPostThreshold?.toString() ?? "",
  });
  const [copied, setCopied] = useState(false);

  async function save(patch: Partial<typeof form>) {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "保存失败");
        return;
      }
      setNote("已保存");
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(client.inboundEmail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动选中复制");
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <h1 className="font-display text-2xl font-bold text-ink-900">{client.name} · 客户设置</h1>
      <p className="mt-1 text-sm text-muted">单据来源、记账连接、税务与自动过账规则</p>

      {(note || error) && (
        <div
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            error ? "bg-conf-low-bg text-conf-low" : "bg-conf-high-bg text-conf-high"
          }`}
        >
          {error ?? note}
        </div>
      )}
      {qboJustConnected && !error && (
        <div className="mt-4 rounded-lg bg-conf-high-bg px-3 py-2 text-sm text-conf-high">
          QuickBooks 已连接，科目表与税码表已同步。请在下方为税码指认用途后再启用自动过账。
        </div>
      )}

      <section className="mt-6 rounded-xl border border-line bg-surface p-6">
        <h2 className="font-medium text-ink-900">专属收单邮箱</h2>
        <p className="mt-1 text-sm text-muted">
          把这个地址给客户，让供应商直接把发票发到这里 — 邮件到达即自动进入队列。
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-paper p-1 pl-4">
          <span className="flex-1 truncate font-mono text-sm text-ink-700">{client.inboundEmail}</span>
          <button
            onClick={copyEmail}
            className="rounded-md bg-ink-700 px-3 py-2 text-xs font-semibold text-white hover:bg-ink-800"
          >
            {copied ? "已复制 ✓" : "复制"}
          </button>
        </div>
        <div className="mt-3 text-xs text-faint">支持 PDF、图片（扫描件 / 手机拍照）、HEIC。单文件上限 20MB。</div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-medium text-ink-900">QuickBooks Online</h2>
            <p className="mt-1 text-sm text-muted">
              连接后，确认的单据可一键录入客户账套：未付建 Bill，已付建 Purchase，原件作为附件挂上。
            </p>
          </div>
          {client.qboConnected ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-conf-high-bg px-3 py-1 text-xs font-medium text-conf-high">
              <span className="size-1.5 rounded-full bg-conf-high" /> 已连接
            </span>
          ) : (
            <a
              href={`/api/clients/${client.id}/qbo/connect`}
              className="shrink-0 rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white hover:bg-ink-800"
            >
              连接 QuickBooks
            </a>
          )}
        </div>
        {client.qboConnected && (
          <div className="mt-4 grid gap-4 border-t border-line pt-4 text-sm sm:grid-cols-2">
            <div>
              <div className="text-xs text-faint">Realm ID</div>
              <div className="font-mono text-ink-900">{client.qboRealmId}</div>
            </div>
            <div>
              <div className="text-xs text-faint">授权状态</div>
              <div className="text-ink-900">有效 · refresh token 加密存储、自动轮换</div>
            </div>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-6">
        <h2 className="font-medium text-ink-900">税务设置</h2>
        <p className="mt-1 text-sm text-muted">
          省份决定税码规则表怎么走（HST / GST+PST / QST）；购方 GST 号是 $150 以上票据的 CRA 抵扣要件。
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-faint">省份 / 地区</span>
            <select
              value={form.province}
              onChange={(e) => {
                setForm({ ...form, province: e.target.value });
                save({ province: e.target.value });
              }}
              className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            >
              <option value="">— 未设置 —</option>
              {PROVINCES.map((p) => (
                <option key={p} value={p}>
                  {PROVINCE_NAMES[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-faint">客户 GST/HST 登记号</span>
            <input
              value={form.taxNumber}
              onChange={(e) => setForm({ ...form, taxNumber: e.target.value })}
              onBlur={() => save({ taxNumber: form.taxNumber })}
              placeholder="123456789RT0001"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-sm text-ink-900"
            />
          </label>
        </div>
      </section>

      <TaxCodeMapper clientId={client.id} taxCodes={taxCodes} />

      <section className="mt-4 rounded-xl border border-line bg-surface p-6">
        <h2 className="font-medium text-ink-900">已付单据的付款账户</h2>
        <p className="mt-1 text-sm text-muted">
          已付的收据在 QBO 里记成 Purchase，必须指定冲哪个银行 / 信用卡账户，否则 QBO 拒收。
        </p>
        <select
          value={form.qboPaymentAccountId}
          onChange={(e) => {
            setForm({ ...form, qboPaymentAccountId: e.target.value });
            save({ qboPaymentAccountId: e.target.value });
          }}
          className="mt-4 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
        >
          <option value="">— 未设置（已付单据将无法录入）—</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </select>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-medium text-ink-900">绿色通道（自动过账）</h2>
            <p className="mt-1 text-sm text-muted">
              同时满足下面六条的单据，不经人工复核直接录入 QBO。任一不满足即进复核队列。
            </p>
          </div>
          <button
            onClick={() => {
              const next = !form.autoPostEnabled;
              setForm({ ...form, autoPostEnabled: next });
              save({ autoPostEnabled: next });
            }}
            disabled={saving}
            className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              form.autoPostEnabled ? "bg-ink-700 text-white" : "border border-line text-muted hover:text-ink-900"
            }`}
          >
            {form.autoPostEnabled ? "已开启" : "已关闭"}
          </button>
        </div>

        <ol className="mt-4 space-y-1.5 text-sm text-muted">
          {/* 「已开启」是前提不是条件，由上面的开关表达，这里只列契约 §4.10 的六条与门 */}
          {Object.entries(AUTO_POST_GATE_LABELS)
            .filter(([k]) => k !== "enabled")
            .map(([k, label], i) => (
              <li key={k} className="flex gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-paper text-[10px] font-bold text-ink-700">
                  {i + 1}
                </span>
                {label}
              </li>
            ))}
        </ol>

        <label className="mt-4 block border-t border-line pt-4">
          <span className="text-xs text-faint">自动过账金额上限（CAD）</span>
          <input
            value={form.autoPostThreshold}
            onChange={(e) => setForm({ ...form, autoPostThreshold: e.target.value })}
            onBlur={() => save({ autoPostThreshold: form.autoPostThreshold })}
            placeholder={String(DEFAULT_AUTO_POST_THRESHOLD)}
            inputMode="decimal"
            className="mt-1 w-40 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
          />
          <span className="ml-2 text-xs text-faint">留空用默认 {DEFAULT_AUTO_POST_THRESHOLD}</span>
        </label>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-6">
        <h2 className="font-medium text-ink-900">去重</h2>
        <p className="mt-1 text-sm text-muted">
          收单时按文件指纹去重；录入 QBO 前再按「供应商 + 发票号」在 QBO 侧查一次，命中即标记为重复、不重复入账。
        </p>
      </section>
    </div>
  );
}

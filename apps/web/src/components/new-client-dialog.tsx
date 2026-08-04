"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PROVINCES, PROVINCE_NAMES } from "@/domain";

// 建客户。省份在这里就要问 —— 它决定税码规则怎么走（契约 §4.8），
// 建完就有单据进来的话，没设省份等于税码规则从第一张单起就跑不对。
export function NewClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", industry: "", province: "", taxNumber: "" });

  async function submit() {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "创建失败");
        return;
      }
      setOpen(false);
      setForm({ name: "", industry: "", province: "", taxNumber: "" });
      router.push(`/clients/${j.clientId}`);
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink-800"
      >
        + 新增客户
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/40 p-4 pt-24" onClick={() => setOpen(false)}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-xl"
      >
        <h2 className="font-display text-lg font-bold text-ink-900">新增客户</h2>
        <p className="mt-1 text-sm text-muted">收单邮箱会自动生成，建完即可开始收票。</p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs text-faint">客户名称 *</span>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Maple Leaf Dental"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            />
          </label>
          <label className="block">
            <span className="text-xs text-faint">行业</span>
            <input
              value={form.industry}
              onChange={(e) => setForm({ ...form, industry: e.target.value })}
              placeholder="牙科诊所"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            />
          </label>
          <label className="block">
            <span className="text-xs text-faint">省份 / 地区（决定税码规则）</span>
            <select
              value={form.province}
              onChange={(e) => setForm({ ...form, province: e.target.value })}
              className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
            >
              <option value="">— 稍后在设置里填 —</option>
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
              placeholder="123456789RT0001"
              className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-sm text-ink-900"
            />
          </label>
        </div>

        {error && <div className="mt-3 rounded-lg bg-conf-low-bg px-3 py-2 text-xs text-conf-low">{error}</div>}

        <div className="mt-5 flex gap-2">
          <button
            onClick={submit}
            disabled={saving || !form.name.trim()}
            className="rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? "创建中…" : "创建并进入工作台"}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:text-ink-900"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

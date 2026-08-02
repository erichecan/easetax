"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TAX_TREATMENTS, TAX_TREATMENT_LABELS, type TaxTreatment } from "@/domain";
import type { TaxCodeRef } from "@/lib/types";

// 税码用途指认（契约 §4.8 的桥）。规则表算出的是「标准可抵扣 / 餐饮50% / 不可抵扣 / 无税」，
// 落到具体客户要变成他 QBO 里的 TaxCode.Id —— 这一步系统不猜（G10），必须人工指认一次。
// 没指认 = 规则表算得再对也落不到单据上，所以未指认时必须警示，而不是静默。
const REQUIRED: TaxTreatment[] = ["standard", "meals_50", "no_itc", "no_tax"];

export function TaxCodeMapper({ clientId, taxCodes }: { clientId: string; taxCodes: TaxCodeRef[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(taxCodes.map((t) => [t.id, t.treatment ?? ""])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const assigned = new Set(Object.values(draft).filter(Boolean));
  const missing = REQUIRED.filter((r) => !assigned.has(r));
  const dirty = taxCodes.some((t) => (t.treatment ?? "") !== (draft[t.id] ?? ""));

  async function save() {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/tax-codes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: taxCodes.map((t) => ({ qboTaxCodeId: t.id, semanticKey: draft[t.id] || null })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "保存失败");
        return;
      }
      setNote(`已指认 ${j.assigned} 项用途`);
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-line bg-surface p-6">
      <h2 className="font-medium text-ink-900">税码用途指认</h2>
      <p className="mt-1 text-sm text-muted">
        税码规则表算出的是「用途」，落到这个客户要变成他 QBO 里的具体税码。
        <strong className="text-ink-900">这一步系统不替你猜</strong>，指认一次即长期生效。
      </p>

      {taxCodes.length === 0 ? (
        <div className="mt-4 rounded-lg bg-conf-med-bg px-3 py-2 text-sm text-conf-med">
          还没有税码。连接 QuickBooks 后会自动同步该客户的税码表，再回来指认用途。
        </div>
      ) : (
        <>
          {missing.length > 0 && (
            <div className="mt-4 rounded-lg bg-conf-low-bg px-3 py-2 text-sm text-conf-low">
              <strong>税码规则当前无法生效</strong>：还有 {missing.map((m) => TAX_TREATMENT_LABELS[m]).join("、")}{" "}
              没有对应税码。规则算出这些用途时会落空，相应行的税码留空、全部转人工。
            </div>
          )}

          <div className="mt-4 space-y-2">
            {taxCodes.map((t) => (
              <div key={t.id} className="grid items-center gap-2 sm:grid-cols-[1fr_220px]">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink-900">{t.name}</div>
                  <div className="font-mono text-[11px] text-faint">QBO TaxCode.Id = {t.id}</div>
                </div>
                <select
                  value={draft[t.id] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [t.id]: e.target.value })}
                  className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
                >
                  <option value="">— 不用于自动分类 —</option>
                  {TAX_TREATMENTS.map((tr) => (
                    <option key={tr} value={tr}>
                      {TAX_TREATMENT_LABELS[tr]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink-800 disabled:opacity-40"
            >
              {saving ? "保存中…" : dirty ? "保存指认" : "已保存"}
            </button>
            {error && <span className="text-xs text-conf-low">{error}</span>}
            {note && <span className="text-xs text-conf-high">{note}</span>}
          </div>
        </>
      )}
    </section>
  );
}

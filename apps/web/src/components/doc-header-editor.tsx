"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ITC_REQUIREMENT_LABELS, type ItcCheck, type ItcRequirement } from "@/domain";
import type { DocumentRec } from "@/lib/types";

// 抬头字段人工订正。OCR 必然会错，缺了这块复核台就只是个只读查看器。
// 缺件字段（CRA 凭证要件）高亮，让「问客户要 GST 号 → 填进来 → 风险消除」形成闭环。
const FIELDS = [
  { key: "vendorName", label: "供应商", type: "text", req: "vendorName" },
  { key: "invoiceNo", label: "发票号", type: "text", req: null },
  { key: "txnDate", label: "账单日", type: "date", req: "txnDate" },
  { key: "dueDate", label: "到期日", type: "date", req: null },
  { key: "supplierTaxNumber", label: "供应商 GST/HST 号", type: "text", req: "supplierTaxNumber" },
  { key: "recipientName", label: "购方名称", type: "text", req: "recipientName" },
  { key: "paymentTerms", label: "付款条款", type: "text", req: "paymentTerms" },
  { key: "subTotal", label: "小计", type: "money", req: null },
  { key: "taxAmount", label: "税额", type: "money", req: "taxAmount" },
  { key: "total", label: "总额", type: "money", req: "total" },
] as const;

type Values = Record<string, string>;

export function DocHeaderEditor({ doc, readOnly }: { doc: DocumentRec; readOnly: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({
    vendorName: doc.vendor === "—" ? "" : doc.vendor,
    invoiceNo: doc.invoiceNo === "—" ? "" : doc.invoiceNo,
    txnDate: doc.txnDate,
    dueDate: doc.dueDate,
    supplierTaxNumber: doc.supplierTaxNumber ?? "",
    recipientName: doc.recipientName ?? "",
    paymentTerms: doc.paymentTerms ?? "",
    subTotal: String(doc.subTotal || ""),
    taxAmount: String(doc.tax || ""),
    total: String(doc.total || ""),
  });

  const missing = new Set<ItcRequirement>(doc.itc.missing);

  async function save(key: string) {
    if (readOnly) return;
    setSaving(key);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/extraction`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: values[key] === "" ? null : values[key] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "保存失败");
        return;
      }
      router.refresh(); // 凭证等级与税码规则都由这些字段派生，刷新即重算
    } catch {
      setError("网络错误");
    } finally {
      setSaving(null);
    }
  }

  const missingCount = doc.itc.missing.length;

  return (
    <div className="mb-3 rounded-lg border border-line bg-surface">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
          单据抬头{readOnly ? "（已录入，只读）" : "（识别有误可直接改）"}
        </span>
        <span className="flex items-center gap-2 text-[11px]">
          {missingCount > 0 && !readOnly && (
            <span className="rounded-full bg-conf-low-bg px-2 py-0.5 font-medium text-conf-low">
              {missingCount} 项缺件待补
            </span>
          )}
          <span className="text-muted">{open ? "收起" : "展开"}</span>
        </span>
      </button>

      {open && (
        <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const isMissing = f.req != null && missing.has(f.req as ItcRequirement);
            return (
              <label key={f.key} className="block">
                <span className={`text-[11px] ${isMissing ? "font-medium text-conf-low" : "text-faint"}`}>
                  {f.label}
                  {isMissing && ` · CRA 要件缺失`}
                </span>
                <input
                  value={values[f.key]}
                  disabled={readOnly}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  onBlur={() => save(f.key)}
                  type={f.type === "date" ? "date" : "text"}
                  inputMode={f.type === "money" ? "decimal" : undefined}
                  placeholder={f.type === "money" ? "0.00" : f.req ? `${ITC_REQUIREMENT_LABELS[f.req as ItcRequirement]}` : ""}
                  className={`mt-0.5 w-full rounded-md border bg-surface px-2 py-1 text-sm text-ink-900 transition-colors focus:border-ink-600 disabled:bg-paper disabled:text-muted ${
                    isMissing ? "border-conf-low/50" : "border-line"
                  } ${f.type === "money" ? "tnum" : ""} ${saving === f.key ? "opacity-50" : ""}`}
                />
              </label>
            );
          })}
          {error && (
            <div className="rounded-lg bg-conf-low-bg px-2 py-1 text-[11px] text-conf-low sm:col-span-2">{error}</div>
          )}
          {!readOnly && (
            <p className="text-[11px] text-faint sm:col-span-2">
              离开输入框即保存。改完抵扣凭证等级与税码会自动重算。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Client, DocumentRec, GlAccount, LineItem, Confidence, TaxCodeRef, Settlement } from "@/lib/types";
import { STAGES, STAGE_META, stageOf } from "@/domain";
import { ItcBadge, itcMissingText } from "./itc-badge";
import { DocHeaderEditor } from "./doc-header-editor";
import { STAGE_TONE } from "./pipeline-rail";

const money = (n: number) =>
  n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });

const CONF_META: Record<Confidence, { label: string; dot: string; text: string; bg: string }> = {
  high: { label: "高", dot: "bg-conf-high", text: "text-conf-high", bg: "bg-conf-high-bg" },
  medium: { label: "中", dot: "bg-conf-med", text: "text-conf-med", bg: "bg-conf-med-bg" },
  low: { label: "低", dot: "bg-conf-low", text: "text-conf-low", bg: "bg-conf-low-bg" },
};

const confRank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function ReviewWorkbench({
  doc,
  client,
  accounts,
  taxCodes,
  ocrText,
}: {
  doc: DocumentRec;
  client: Client;
  accounts: GlAccount[];
  taxCodes: TaxCodeRef[];
  ocrText?: string | null;
}) {
  const taxCodeName = (id: string | null) =>
    id ? (taxCodes.find((t) => t.id === id)?.name ?? id) : null;
  const [lines, setLines] = useState<LineItem[]>(() =>
    [...doc.lines].sort((a, b) => confRank[a.confidence] - confRank[b.confidence]),
  );

  const setAccount = (lineId: string, accId: string) => {
    const acc = accounts.find((a) => a.id === accId);
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? {
              ...l,
              glAccountId: acc?.id ?? null,
              glAccountName: acc?.name ?? null,
              confidence: acc ? "high" : l.confidence,
            }
          : l,
      ),
    );
  };

  const setTaxCode = (lineId: string, taxCode: string) => {
    setLines((prev) => prev.map((l) => (l.id === lineId ? { ...l, taxCode } : l)));
  };

  const [newLine, setNewLine] = useState<{ description: string; amount: string } | null>(null);
  const [lineBusy, setLineBusy] = useState(false);

  async function addLine() {
    if (!newLine?.description.trim() || lineBusy) return;
    setLineBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: newLine.description, amount: newLine.amount || 0 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "加行失败");
        return;
      }
      setNewLine(null);
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setLineBusy(false);
    }
  }

  async function deleteLine(lineId: string, description: string) {
    if (lineBusy) return;
    if (!window.confirm(`删除这一行？\n\n${description}`)) return;
    setLineBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/lines?lineId=${encodeURIComponent(lineId)}`, {
        method: "DELETE",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "删除失败");
        return;
      }
      setLines((prev) => prev.filter((l) => l.id !== lineId));
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setLineBusy(false);
    }
  }

  const assignedTotal = useMemo(
    () => lines.reduce((s, l) => s + l.amount, 0),
    [lines],
  );

  // 行合计应等于票面不含税小计。对不上说明 OCR 漏行/多切行/金额抽错——
  // 这是最容易被放过、也最容易导致入账金额错的地方，必须显式报出来。
  const expectedSubTotal = doc.subTotal > 0 ? doc.subTotal : doc.total - doc.tax;
  const lineGap = expectedSubTotal > 0 ? assignedTotal - expectedSubTotal : 0;
  const hasGap = Math.abs(lineGap) >= 0.01;
  // QBO 要求每行都有有效税码，缺科目或缺税码都不能录入（契约 §4.8）。
  const allAssigned = lines.length > 0 && lines.every((l) => l.glAccountId && l.taxCode);

  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origMode, setOrigMode] = useState<"file" | "raw" | "summary">("file");
  const [copied, setCopied] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [settlement, setSettlement] = useState<Settlement>(doc.settlement ?? "unpaid");
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  // 已付 → QBO Purchase（直接冲银行/信用卡）；未付 → Bill（挂应付账款）。契约 G9。
  const qboEntity = settlement === "paid" ? "Purchase 支出" : "Bill 应付账单";
  const canSync = doc.status === "confirmed" || doc.status === "sync_failed";
  const currentStage = stageOf(doc.status);

  async function changeSettlement(next: Settlement) {
    if (next === settlement || doc.status === "synced") return;
    const prev = settlement;
    setSettlement(next); // 乐观更新：切换要跟手，失败再回滚
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/settlement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settlement: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "付款状态保存失败");
        setSettlement(prev);
      }
    } catch {
      setError("网络错误");
      setSettlement(prev);
    }
  }

  async function syncToQbo() {
    if (!canSync || syncing) return;
    setSyncing(true);
    setError(null);
    setSyncNote(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/sync-qbo`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? `录入失败 (${res.status})`);
        return;
      }
      setSyncNote(
        j.duplicate
          ? `QBO 里已存在同号单据（${j.entity} #${j.qboId}），未重复创建`
          : `已录入 QBO：${j.entity} #${j.qboId}${j.attached ? "，原件已挂附件" : "，附件未挂上"}`,
      );
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setSyncing(false);
    }
  }

  const canReprocess = doc.status === "needs_review" || doc.status === "ocr_failed";
  // 契约 §4.1 允许退回的来源状态
  const canReject = ["received", "needs_review", "duplicate_suspected", "ocr_failed"].includes(doc.status);
  const [rejecting, setRejecting] = useState(false);

  async function reject() {
    if (!canReject || rejecting) return;
    const reason = window.prompt("退回原因（会记入审计，事后要答得上）：\n例如：重复件 / 私人消费 / 不是发票");
    if (reason === null) return;
    if (!reason.trim()) {
      setError("退回必须填写原因");
      return;
    }
    setRejecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "退回失败");
        return;
      }
      router.push(`/clients/${client.id}`);
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setRejecting(false);
    }
  }

  async function reprocess() {
    if (!canReprocess || reprocessing) return;
    if (!window.confirm("重新识别会丢弃当前识别结果与分类，重跑一遍 OCR + 分类。继续？")) return;
    setReprocessing(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/reprocess`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? `重跑失败 (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setReprocessing(false);
    }
  }

  async function copyOcr() {
    const text = ocrText ?? "";
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // 兜底：临时 textarea + execCommand（旧浏览器/非安全上下文）
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setError(null);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setError("复制失败，请手动选中复制");
    }
  }

  async function confirm() {
    if (!allAssigned || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignments: lines.map((l) => ({ lineId: l.id, glAccountId: l.glAccountId, taxCode: l.taxCode || null })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? `确认失败 (${res.status})`);
        return;
      }
      router.push(`/clients/${client.id}/documents`);
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* 流程定位条：这张单在五段里的位置，和工作台的轨道同一套语言 */}
      <div className="flex items-center gap-1.5 border-b border-line bg-paper px-6 py-1.5 text-[11px]">
        {STAGES.map((s) => {
          const meta = STAGE_META[s];
          const here = s === currentStage;
          const passed = currentStage != null && meta.index < STAGE_META[currentStage].index;
          return (
            <span key={s} className="flex items-center gap-1.5">
              {meta.index > 1 && <span className="text-line-strong">→</span>}
              <span
                className={`rounded-full px-2 py-0.5 ${
                  here
                    ? `font-semibold ${STAGE_TONE[s].chip}`
                    : passed
                      ? "text-conf-high" // 走过的段 = 已完成，绿色（与管道底部「已录入」同义）
                      : "text-faint"
                }`}
              >
                {meta.index} {meta.label}
              </span>
            </span>
          );
        })}
      </div>

      <header className="flex items-center justify-between border-b border-line bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <Link
            href={`/clients/${client.id}`}
            className="rounded-md px-2 py-1 text-sm text-muted transition-colors hover:bg-paper hover:text-ink-900"
          >
            ← 工作台
          </Link>
          <div className="h-4 w-px bg-line" />
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink-900">{doc.vendor}</span>
              <ItcBadge itc={doc.itc} showTier />
            </div>
            <div className="text-[11px] text-faint">
              {client.name} · {doc.invoiceNo} · {doc.txnDate}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-conf-low">{error}</span>}
          {canReject && (
            <button
              onClick={reject}
              disabled={rejecting}
              title="不该入账的单据（重复件 / 私人消费 / 不是发票）"
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-conf-low/40 hover:text-conf-low disabled:opacity-40"
            >
              {rejecting ? "退回中…" : "退回"}
            </button>
          )}
          <button
            onClick={reprocess}
            disabled={!canReprocess || reprocessing}
            title={canReprocess ? "丢弃当前识别结果，重跑 OCR + 分类" : "当前状态不可重跑"}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {reprocessing ? "重新识别中…" : "重新识别"}
          </button>
          <button
            onClick={confirm}
            disabled={!allAssigned || saving}
            className="rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "确认中…" : allAssigned ? "确认分类" : "尚有未分类行"}
          </button>
        </div>
      </header>

      {doc.itc.status === "incomplete" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-conf-low/25 bg-conf-low-bg px-6 py-2.5 text-xs text-conf-low">
          <span className="font-semibold">⚠ 这笔进项税抵不了</span>
          <span>
            按 CRA 规定，{doc.itc.tier === "over_150" ? "$150 以上" : "$30 以上"}的票据还缺：
            <strong className="font-semibold">{itcMissingText(doc.itc)}</strong>
          </span>
          <span className="text-conf-low/70">费用照记，但这笔 ITC 不可抵扣 —— 需要向客户索要完整发票。</span>
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-px overflow-hidden bg-line lg:grid-cols-[1fr_1.4fr_1fr]">
        {/* 左：原件预览 */}
        <section className="overflow-y-auto bg-paper p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">原件</span>
            <div className="flex gap-1 rounded-md border border-line bg-surface p-0.5">
              <button
                onClick={() => setOrigMode("file")}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  origMode === "file" ? "bg-ink-700 text-white" : "text-muted hover:text-ink-900"
                }`}
              >
                原件
              </button>
              <button
                onClick={() => setOrigMode("raw")}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  origMode === "raw" ? "bg-ink-700 text-white" : "text-muted hover:text-ink-900"
                }`}
              >
                识别原文
              </button>
              <button
                onClick={() => setOrigMode("summary")}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  origMode === "summary" ? "bg-ink-700 text-white" : "text-muted hover:text-ink-900"
                }`}
              >
                摘要
              </button>
            </div>
          </div>
          {origMode === "file" && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="truncate text-[11px] text-faint">📎 {doc.fileName}</span>
                <a
                  href={`/api/documents/${doc.id}/file?download=1`}
                  className="shrink-0 rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:text-ink-900"
                >
                  下载原件
                </a>
              </div>
              {doc.fileKind === "pdf" ? (
                <iframe
                  src={`/api/documents/${doc.id}/file`}
                  title={`原件 ${doc.fileName}`}
                  className="h-[calc(100vh-13rem)] w-full rounded-lg border border-line bg-surface"
                />
              ) : (
                <div className="max-h-[calc(100vh-13rem)] overflow-auto rounded-lg border border-line bg-surface p-2">
                  {/* 原件是任意尺寸的用户上传件，用原生 img 直出，不走 next/image 优化 */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/documents/${doc.id}/file`}
                    alt={`原件 ${doc.fileName}`}
                    className="mx-auto w-full max-w-full"
                  />
                </div>
              )}
            </>
          )}
          {origMode === "raw" && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] text-faint">Veryfi 识别原文（全文）</span>
                <button
                  onClick={copyOcr}
                  disabled={!ocrText}
                  className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted transition-colors hover:text-ink-900 disabled:opacity-40"
                >
                  {copied ? "已复制 ✓" : "复制原文"}
                </button>
              </div>
              <pre
                className="max-h-[calc(100vh-13rem)] overflow-auto whitespace-pre rounded-lg border border-line bg-surface p-4 font-mono text-[11px] leading-relaxed text-ink-900"
                style={{ tabSize: 4 }}
              >
                {ocrText ?? "（无识别原文）"}
              </pre>
            </>
          )}
          {origMode === "summary" && (
          <div className="rounded-lg border border-line bg-surface p-5 shadow-[0_1px_8px_-4px_rgba(31,77,63,0.12)]">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="font-display text-lg font-bold text-ink-900">
                {doc.vendor}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  doc.fileKind === "pdf"
                    ? "bg-conf-low-bg text-conf-low"
                    : "bg-conf-high-bg text-conf-high"
                }`}
              >
                {doc.fileKind === "pdf" ? "PDF" : "IMG"}
              </span>
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row k="发票号" v={doc.invoiceNo} mono />
              <Row k="账单日" v={doc.txnDate} mono />
              <Row k="到期日" v={doc.dueDate} mono />
            </dl>
            <div className="mt-4 border-t border-line pt-3">
              {doc.lines.map((l) => (
                <div key={l.id} className="flex justify-between py-1 text-sm">
                  <span className="text-muted">{l.description}</span>
                  <span className="tnum text-ink-900">{money(l.amount)}</span>
                </div>
              ))}
            </div>
            <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              <Row k="小计" v={money(doc.subTotal)} />
              <Row k={doc.taxLabel} v={money(doc.tax)} />
              <div className="flex justify-between pt-1 font-semibold text-ink-900">
                <span>合计</span>
                <span className="tnum">{money(doc.total)}</span>
              </div>
            </dl>
            <div className="mt-4 truncate text-[11px] text-faint">
              📎 {doc.fileName}
            </div>
          </div>
          )}
          {doc.note && (
            <div className="mt-3 rounded-lg bg-conf-low-bg px-3 py-2 text-xs text-conf-low">
              ⚠ {doc.note}
            </div>
          )}
        </section>

        {/* 中：识别 + 分类 */}
        <section className="overflow-y-auto bg-surface p-5">
          <DocHeaderEditor doc={doc} readOnly={doc.status === "synced"} />
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
              识别结果 · 分类
            </span>
            <span className="text-[11px] text-faint">
              低置信度行已置顶
            </span>
          </div>
          <div className="space-y-2.5">
            {lines.map((l) => {
              const c = CONF_META[l.confidence];
              return (
                <div
                  key={l.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    l.confidence === "low" && !l.glAccountId
                      ? "border-conf-low/40 bg-conf-low-bg/40"
                      : "border-line bg-surface"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink-900">
                        {l.description}
                      </div>
                      <div className="tnum mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        <span>{money(l.amount)}</span>
                        {l.taxCode ? (
                          <span className="text-faint">税码 {taxCodeName(l.taxCode)}</span>
                        ) : (
                          <span
                            title="税码由确定性规则表产出（省份 × 科目 × 供应商登记状态）。规则未命中时留空，需人工选择——不允许 AI 猜。"
                            className="rounded bg-conf-low-bg px-1.5 py-0.5 font-medium text-conf-low"
                          >
                            税码待人工确定
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.bg} ${c.text}`}
                      >
                        <span className={`size-1.5 rounded-full ${c.dot}`} /> {c.label}
                      </span>
                      {doc.status !== "synced" && (
                        <button
                          onClick={() => deleteLine(l.id, l.description)}
                          disabled={lineBusy}
                          title="删除这一行"
                          className="rounded px-1 text-sm text-faint transition-colors hover:bg-conf-low-bg hover:text-conf-low disabled:opacity-40"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="mt-2.5 grid gap-2 sm:grid-cols-[1.4fr_1fr]">
                    <select
                      value={l.glAccountId ?? ""}
                      onChange={(e) => setAccount(l.id, e.target.value)}
                      className={`w-full rounded-md border bg-surface px-2.5 py-1.5 text-sm text-ink-900 transition-colors focus:border-ink-600 ${
                        l.glAccountId ? "border-line" : "border-conf-low/50"
                      }`}
                    >
                      <option value="">— 选择 GL 科目 —</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={l.taxCode}
                      onChange={(e) => setTaxCode(l.id, e.target.value)}
                      className={`w-full rounded-md border bg-surface px-2.5 py-1.5 text-sm text-ink-900 transition-colors focus:border-ink-600 ${
                        l.taxCode ? "border-line" : "border-conf-low/50"
                      }`}
                    >
                      <option value="">— 选择税码 —</option>
                      {taxCodes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
            {lines.length === 0 && (
              <div className="rounded-lg border border-dashed border-line py-10 text-center text-sm text-faint">
                该单据尚未产生行项目（OCR 未完成或全部被删）
              </div>
            )}
          </div>

          {/* 行合计对不上票面：最容易被放过、也最容易让入账金额错的地方 */}
          {hasGap && (
            <div className="mt-3 rounded-lg bg-conf-med-bg px-3 py-2 text-xs text-conf-med">
              行合计 {money(assignedTotal)} 与票面小计 {money(expectedSubTotal)} 差 {money(Math.abs(lineGap))}
              {lineGap < 0 ? "（少了，可能漏行）" : "（多了，可能重复切行）"} —— 加行 / 删行 / 改抬头金额来对平。
            </div>
          )}

          {doc.status !== "synced" && (
            <div className="mt-3">
              {newLine ? (
                <div className="rounded-lg border border-line bg-paper p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                    <input
                      autoFocus
                      value={newLine.description}
                      onChange={(e) => setNewLine({ ...newLine, description: e.target.value })}
                      placeholder="行描述（如：A4 复印纸 5 包）"
                      className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
                    />
                    <input
                      value={newLine.amount}
                      onChange={(e) => setNewLine({ ...newLine, amount: e.target.value })}
                      placeholder="金额"
                      inputMode="decimal"
                      className="tnum rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-900"
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={addLine}
                      disabled={lineBusy || !newLine.description.trim()}
                      className="rounded-md bg-ink-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      {lineBusy ? "添加中…" : "添加"}
                    </button>
                    <button
                      onClick={() => setNewLine(null)}
                      className="rounded-md px-3 py-1.5 text-xs font-medium text-muted hover:text-ink-900"
                    >
                      取消
                    </button>
                    <span className="self-center text-[11px] text-faint">科目与税码添加后再选</span>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setNewLine({ description: "", amount: "" })}
                  className="w-full rounded-lg border border-dashed border-line py-2 text-xs font-medium text-muted transition-colors hover:border-line-strong hover:text-ink-900"
                >
                  + 加一行（OCR 漏抽时手工补）
                </button>
              )}
            </div>
          )}
        </section>

        {/* 右：录入 QBO 预览 */}
        <section className="overflow-y-auto bg-paper p-5">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-faint">
            将写入 QBO 的 {qboEntity}
          </div>

          {/* 付款状态决定记 Purchase 还是 Bill（契约 G9），错了会虚增应付账款 */}
          <div className="mb-3 rounded-lg border border-line bg-surface p-3">
            <div className="mb-2 text-[11px] font-medium text-muted">这张单是否已付款？</div>
            <div className="flex gap-1 rounded-md border border-line p-0.5">
              {(["unpaid", "paid"] as Settlement[]).map((v) => (
                <button
                  key={v}
                  onClick={() => changeSettlement(v)}
                  disabled={doc.status === "synced"}
                  className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    settlement === v ? "bg-ink-700 text-white" : "text-muted hover:text-ink-900"
                  }`}
                >
                  {v === "unpaid" ? "未付（有账期）" : "已付（刷卡/现金）"}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-faint">
              {settlement === "unpaid"
                ? "→ 记 Bill 挂应付账款，付款后再记 Bill Payment"
                : "→ 记 Purchase 直接冲客户的银行 / 信用卡账户"}
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <div className="text-[11px] text-faint">Vendor</div>
                <div className="font-medium text-ink-900">{doc.vendor}</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-faint">DocNumber</div>
                <div className="tnum font-mono text-sm text-ink-900">
                  {doc.invoiceNo}
                </div>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {lines.map((l) => (
                <div key={l.id} className="text-sm">
                  <div className="flex justify-between">
                    <span
                      className={
                        l.glAccountName ? "text-ink-900" : "text-conf-low"
                      }
                    >
                      {l.glAccountName ?? "未分类"}
                    </span>
                    <span className="tnum text-ink-900">{money(l.amount)}</span>
                  </div>
                  <div className="truncate text-[11px] text-faint">
                    {l.description}
                  </div>
                </div>
              ))}
            </div>
            <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              <Row k="行项目合计" v={money(assignedTotal)} />
              <Row k={doc.taxLabel} v={money(doc.tax)} />
              <div className="flex justify-between pt-1 font-semibold text-ink-900">
                <span>Bill 总额</span>
                <span className="tnum">{money(assignedTotal + doc.tax)}</span>
              </div>
            </dl>
          </div>
          <div
            className={`mt-3 rounded-lg px-3 py-2 text-xs ${
              allAssigned
                ? "bg-conf-high-bg text-conf-high"
                : "bg-conf-med-bg text-conf-med"
            }`}
          >
            {allAssigned
              ? `✓ 全部行已带科目与税码，原件将作为 Attachable 附件挂到 ${qboEntity}。`
              : "还有行缺 GL 科目或税码，QBO 会拒收，录入按钮锁定。"}
          </div>

          {/* 录入 QBO：确认后才可点；未连 QBO 时后端返回 409，停在 confirmed（契约 §4.2） */}
          {canSync && (
            <button
              onClick={syncToQbo}
              disabled={syncing}
              className="mt-3 w-full rounded-lg bg-ink-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {syncing ? "录入中…" : doc.status === "sync_failed" ? "重试录入 QBO" : `录入 QBO（建 ${qboEntity}）`}
            </button>
          )}
          {doc.status === "synced" && (
            <div className="mt-3 rounded-lg bg-conf-high-bg px-3 py-2 text-xs text-conf-high">
              ✓ 已录入 QBO，本地转为只读快照 —— 之后的修改请到 QBO 里做。
            </div>
          )}
          {syncNote && (
            <div className="mt-2 rounded-lg bg-paper px-3 py-2 text-xs text-muted">{syncNote}</div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-faint">{k}</span>
      <span className={`text-ink-900 ${mono ? "font-mono text-xs" : "tnum"}`}>
        {v}
      </span>
    </div>
  );
}

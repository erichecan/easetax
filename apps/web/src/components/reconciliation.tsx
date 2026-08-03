"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Client, ReconCandidate, ReconRow } from "@/lib/types";

const money = (n: number) =>
  n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });

export function Reconciliation({
  client,
  rows,
  period,
  candidates,
}: {
  client: Client;
  rows: ReconRow[];
  period: string;
  candidates: ReconCandidate[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    parsed: number;
    imported: number;
    duplicates: number;
    detected: { date: string; description: string; amount: string };
    errors: { line: number; reason: string }[];
    errorCount: number;
  } | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  async function importCsv(file: File) {
    if (busy) return;
    setBusy("import");
    setError(null);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/clients/${client.id}/bank-txns`, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "导入失败");
        return;
      }
      setImportResult(j);
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setBusy(null);
      if (csvRef.current) csvRef.current.value = "";
    }
  }
  const [draft, setDraft] = useState<{
    subject: string;
    body: string;
    recipient: string;
    delivered: boolean;
    sendError: string | null;
  } | null>(null);

  // 人工裁决（契约 §4.6）：自动匹配一定有错判漏判，会计师要能改。
  async function setMatch(txnId: string, matchStatus: string, matchedDocumentId?: string) {
    if (busy) return;
    setBusy(txnId);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${client.id}/bank-txns/${txnId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchStatus, matchedDocumentId: matchedDocumentId ?? null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "操作失败");
        return;
      }
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setBusy(null);
    }
  }

  // 追票：生成催票内容并落记录。没有配邮件通道时只出草稿，由会计师自己发（不假装已发送）。
  async function chase(txnIds: string[], key: string) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${client.id}/chase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txnIds }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "追票失败");
        return;
      }
      setDraft({
        subject: j.subject,
        body: j.body,
        recipient: j.recipient,
        delivered: j.delivered,
        sendError: j.sendError ?? null,
      });
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setBusy(null);
    }
  }

  // ignored = 会计师已判定「无需收据」，不进缺口清单。
  const missing = rows.filter((r) => r.matchKind === "none");
  const matched = rows.filter((r) => r.matchedDocId);
  const totalSpend = rows.reduce((s, r) => s + r.txn.amount, 0);
  const missingSpend = missing.reduce((s, r) => s + r.txn.amount, 0);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href={`/clients/${client.id}/documents`}
            className="text-sm text-muted transition-colors hover:text-ink-900"
          >
            ← {client.name} · 单据队列
          </Link>
          <h1 className="mt-2 font-display text-2xl font-bold text-ink-900">
            银行对账{period && ` · ${period}`}
          </h1>
          <p className="mt-1 text-sm text-muted">
            把银行流水逐笔和已收单据对照，找出没有收据支撑的支出。
          </p>
        </div>
        {rows.length > 0 && (
          <button
            onClick={() => csvRef.current?.click()}
            disabled={busy !== null}
            className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:text-ink-900 disabled:opacity-50"
          >
            {busy === "import" ? "导入中…" : "导入对账单 CSV"}
          </button>
        )}
      </header>

      <input
        ref={csvRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importCsv(f);
        }}
      />

      {/* 导入结果：明确报出识别到哪几列、导入多少、跳过多少重复、多少行有问题 */}
      {importResult && (
        <div className="mt-4 rounded-xl border border-line bg-surface p-4 text-sm">
          <div className="font-medium text-ink-900">
            解析 {importResult.parsed} 笔支出 · 新导入 {importResult.imported} 笔
            {importResult.duplicates > 0 && ` · 跳过重复 ${importResult.duplicates} 笔`}
          </div>
          <div className="mt-1 text-xs text-faint">
            识别到的列：日期「{importResult.detected.date}」· 摘要「{importResult.detected.description}」· 金额「
            {importResult.detected.amount}」
          </div>
          {importResult.errorCount > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-conf-med">
                {importResult.errorCount} 行未能解析（已跳过，其余照常导入）
              </summary>
              <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted">
                {importResult.errors.map((e) => (
                  <li key={e.line}>
                    第 {e.line} 行：{e.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            onClick={() => setImportResult(null)}
            className="mt-2 text-xs text-muted hover:text-ink-900"
          >
            知道了
          </button>
        </div>
      )}

      {rows.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-line bg-surface px-6 py-16 text-center">
          <div className="font-medium text-ink-900">该客户还没有银行流水</div>
          <p className="mt-1.5 text-sm text-muted">
            导入银行对账单后，这里会逐笔和已收单据比对，列出缺收据的支出。
          </p>
          <button
            onClick={() => csvRef.current?.click()}
            disabled={busy !== null}
            className="mt-4 rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white hover:bg-ink-800 disabled:opacity-50"
          >
            {busy === "import" ? "导入中…" : "导入对账单 CSV"}
          </button>
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={() => setDraft(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-line bg-surface p-6 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold text-ink-900">催票内容已生成</h3>
                <p className="mt-1 text-sm text-muted">
                  {draft.delivered ? (
                    <>已发送至 <span className="font-mono">{draft.recipient}</span>，并记入追票历史。</>
                  ) : draft.sendError ? (
                    <>
                      邮件通道已接，但这封<strong>没发出去</strong>：
                      <span className="text-conf-low">{draft.sendError}</span>
                      。内容已记入追票历史，可复制后自行发送，或稍后重试。
                    </>
                  ) : (
                    <>
                      当前未接邮件通道，<strong>没有真的发送</strong>。内容已记入追票历史，请复制后自行发给客户。
                    </>
                  )}
                </p>
              </div>
              <button onClick={() => setDraft(null)} className="shrink-0 rounded-md px-2 py-1 text-sm text-muted hover:text-ink-900">
                关闭
              </button>
            </div>
            <div className="mt-4 rounded-lg border border-line bg-paper p-3">
              <div className="text-[11px] text-faint">主题</div>
              <div className="text-sm font-medium text-ink-900">{draft.subject}</div>
            </div>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-paper p-3 text-xs leading-relaxed text-ink-900">
              {draft.body}
            </pre>
            <button
              onClick={() => navigator.clipboard?.writeText(`${draft.subject}\n\n${draft.body}`)}
              className="mt-3 rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white hover:bg-ink-800"
            >
              复制全文
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Tile label="银行支出" value={`${rows.length} 笔`} sub={money(totalSpend)} tone="text-ink-900" />
        <Tile label="已匹配收据" value={`${matched.length} 笔`} sub="有收据支撑" tone="text-conf-high" />
        <Tile
          label="缺收据"
          value={`${missing.length} 笔`}
          sub={money(missingSpend)}
          tone="text-conf-low"
          highlight
        />
      </div>

      {/* 缺收据清单 —— 核心产出 */}
      <section className="mt-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-ink-900">缺收据清单</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-faint">这些银行支出找不到对应收据，需向客户追票</span>
            {missing.length > 0 && (
              <button
                onClick={() => chase(missing.map((r) => r.txn.id), "all")}
                disabled={busy !== null}
                className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-ink-800 disabled:opacity-50"
              >
                {busy === "all" ? "生成中…" : `一次催全部（${missing.length} 笔）`}
              </button>
            )}
          </div>
        </div>
        {error && <div className="mt-2 rounded-lg bg-conf-low-bg px-3 py-2 text-xs text-conf-low">{error}</div>}
        <div className="mt-3 overflow-hidden rounded-xl border border-conf-low/30 bg-surface">
          {missing.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-conf-high">
              ✓ 本月每一笔银行支出都有收据支撑，无缺口。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-4 py-3 font-semibold">日期</th>
                  <th className="px-4 py-3 font-semibold">银行摘要</th>
                  <th className="px-4 py-3 text-right font-semibold">金额</th>
                  <th className="px-4 py-3 text-right font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((r) => (
                  <tr key={r.txn.id} className="border-b border-line last:border-0">
                    <td className="tnum px-4 py-3 text-muted">{r.txn.date}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-ink-900">{r.txn.description}</span>
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-conf-low-bg px-2 py-0.5 text-[10px] font-semibold text-conf-low">
                        缺收据
                      </span>
                      {r.chaseCount > 0 && (
                        <span className="ml-2 text-[11px] text-faint">
                          已催 {r.chaseCount} 次 · 最近 {r.lastChasedAt}
                        </span>
                      )}
                    </td>
                    <td className="tnum px-4 py-3 text-right font-medium text-ink-900">{money(r.txn.amount)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {/* 自动匹配漏了的，人工指一张（契约 §4.6：人工裁决是 canonical） */}
                        <select
                          value=""
                          disabled={busy !== null}
                          onChange={(e) => e.target.value && setMatch(r.txn.id, "manual", e.target.value)}
                          className="max-w-[150px] rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink-900 disabled:opacity-50"
                        >
                          <option value="">关联单据…</option>
                          {candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.vendor} · {money(c.total)} · {c.txnDate}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => setMatch(r.txn.id, "ignored")}
                          disabled={busy !== null}
                          title="这笔支出本就不需要收据（如银行手续费、利息）"
                          className="rounded-md border border-line px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-ink-900 disabled:opacity-50"
                        >
                          无需收据
                        </button>
                        <button
                          onClick={() => chase([r.txn.id], r.txn.id)}
                          disabled={busy !== null}
                          className="rounded-md border border-line px-2.5 py-1 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-700/10 disabled:opacity-50"
                        >
                          {busy === r.txn.id ? "处理中…" : r.chaseCount > 0 ? "再催" : "催票"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* 全部流水 */}
      <section className="mt-7">
        <h2 className="font-display text-lg font-bold text-ink-900">全部银行流水</h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="px-4 py-3 font-semibold">日期</th>
                <th className="px-4 py-3 font-semibold">银行摘要</th>
                <th className="px-4 py-3 text-right font-semibold">金额</th>
                <th className="px-4 py-3 font-semibold">对账状态</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.txn.id}
                  className="border-b border-line last:border-0 transition-colors hover:bg-paper"
                >
                  <td className="tnum px-4 py-3 text-muted">{r.txn.date}</td>
                  <td className="px-4 py-3 font-mono text-ink-900">{r.txn.description}</td>
                  <td className="tnum px-4 py-3 text-right font-medium text-ink-900">
                    {money(r.txn.amount)}
                  </td>
                  <td className="px-4 py-3">
                    {r.matchedDocId ? (
                      <Link
                        href={`/documents/${r.matchedDocId}/review`}
                        className="inline-flex items-center gap-1.5 text-conf-high transition-colors hover:underline"
                      >
                        <span className="size-1.5 rounded-full bg-conf-high" />
                        {r.matchKind === "manual" ? "已确认" : "自动匹配"} · {r.matchedFileName}
                      </Link>
                    ) : r.matchKind === "ignored" ? (
                      <span className="inline-flex items-center gap-1.5 text-faint">
                        <span className="size-1.5 rounded-full bg-faint" />
                        已标记无需收据
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-conf-low">
                        <span className="size-1.5 rounded-full bg-conf-low" />
                        缺收据
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {/* 人工裁决过的才可撤销：auto 是实时算的，撤销它没有意义 */}
                    {(r.matchKind === "manual" || r.matchKind === "ignored") && (
                      <button
                        onClick={() => setMatch(r.txn.id, "unmatched")}
                        disabled={busy !== null}
                        className="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-conf-low disabled:opacity-50"
                      >
                        撤销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-surface p-5 ${
        highlight ? "border-conf-low/40" : "border-line"
      }`}
    >
      <div className="text-[11px] uppercase tracking-wider text-faint">{label}</div>
      <div className={`tnum mt-1 font-display text-2xl font-bold ${tone}`}>{value}</div>
      <div className="mt-0.5 text-xs text-faint">{sub}</div>
    </div>
  );
}

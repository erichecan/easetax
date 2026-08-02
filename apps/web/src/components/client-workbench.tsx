"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STAGE_META, isDone, isException, stageOf, type PipelineSummary, type Stage } from "@/domain";
import type { Client, DocumentRec, DocStatus, Confidence } from "@/lib/types";
import { ItcBadge } from "./itc-badge";
import { PipelineRail } from "./pipeline-rail";

const STATUS_META: Record<DocStatus, { label: string; cls: string }> = {
  received: { label: "待识别", cls: "bg-paper text-muted" },
  ocr_processing: { label: "识别中", cls: "bg-gold-50 text-gold-700" },
  ocr_done: { label: "待分类", cls: "bg-gold-50 text-gold-700" },
  classifying: { label: "分类中", cls: "bg-gold-50 text-gold-700" },
  needs_review: { label: "待复核", cls: "bg-gold-50 text-gold-700" },
  confirmed: { label: "待录入", cls: "bg-gold-50 text-gold-700" },
  syncing_qbo: { label: "录入中", cls: "bg-gold-50 text-gold-700" },
  synced: { label: "已录入", cls: "bg-conf-high-bg text-conf-high" },
  duplicate_suspected: { label: "疑似重复", cls: "bg-conf-low-bg text-conf-low" },
  ocr_failed: { label: "识别失败", cls: "bg-conf-low-bg text-conf-low" },
  sync_failed: { label: "录入失败", cls: "bg-conf-low-bg text-conf-low" },
  rejected: { label: "已退回", cls: "bg-conf-low-bg text-conf-low" },
};

const CONF_DOT: Record<Confidence, string> = {
  high: "bg-conf-high",
  medium: "bg-conf-med",
  low: "bg-conf-low",
};

const money = (n: number) => n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });

// 上传时的进度提示用流程语言，和管道上的段名一致。
const INTAKE_STEPS = ["① 收单 · 存原件、按指纹去重", "② 识别 · OCR 抽字段与行项目", "③ 定科目税码 · 规则与 AI"];

type Filter = Stage | "exception" | "done" | null;

export function ClientWorkbench({
  client,
  docs,
  pipeline,
  missingReceipts,
}: {
  client: Client;
  docs: DocumentRec[];
  pipeline: PipelineSummary;
  missingReceipts: { count: number; amount: number };
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [justUploadedId, setJustUploadedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<{ confirmed: number; failed: { fileName: string; reason: string }[]; verb?: string } | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 批量录入：串行请求，QBO 限流约 500/min，并发只会更快撞 429
  async function batchSync() {
    if (!selected.size || batchBusy) return;
    setBatchBusy(true);
    setNotice(null);
    setBatchResult(null);
    try {
      const res = await fetch("/api/documents/batch-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: [...selected] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(`✗ ${j.error ?? "批量录入失败"}`);
        return;
      }
      setBatchResult({ confirmed: j.synced, failed: j.failed ?? [], verb: "录入" });
      setSelected(new Set());
      router.refresh();
    } catch {
      setNotice("✗ 网络错误");
    } finally {
      setBatchBusy(false);
    }
  }

  // 批量确认只对「已经齐全」的生效，缺件的逐条报错 —— 批量不该替人做判断
  async function batchConfirm() {
    if (!selected.size || batchBusy) return;
    setBatchBusy(true);
    setNotice(null);
    setBatchResult(null);
    try {
      const res = await fetch("/api/documents/batch-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: [...selected] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(`✗ ${j.error ?? "批量确认失败"}`);
        return;
      }
      setBatchResult({ confirmed: j.confirmed, failed: j.failed ?? [], verb: "确认" });
      setSelected(new Set());
      router.refresh();
    } catch {
      setNotice("✗ 网络错误");
    } finally {
      setBatchBusy(false);
    }
  }

  // 凭证缺件：只统计还能改的单据（已录入的改不了，提示没意义）
  const itcRisk = useMemo(
    () => docs.filter((d) => d.itc.status === "incomplete" && !isDone(d.status)),
    [docs],
  );

  const rows = useMemo(() => {
    if (!filter) return docs;
    if (filter === "exception") return docs.filter((d) => isException(d.status));
    if (filter === "done") return docs.filter((d) => isDone(d.status));
    return docs.filter((d) => stageOf(d.status) === filter);
  }, [docs, filter]);

  async function uploadFile(file: File) {
    if (busy) return;
    setBusy(true);
    setFileName(file.name);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("clientId", client.id);
      const res = await fetch("/api/documents/upload", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(`✗ ${j.error ?? "上传失败"}`);
        return;
      }
      setJustUploadedId(j.documentId ?? null);
      if (j.duplicate) {
        setNotice("⚠ 该文件疑似重复，未重复入账");
        setFilter("exception");
      } else if (j.autoPosted) {
        setNotice("✓ 符合绿色通道六条，已自动确认并录入 QBO");
        setFilter(j.status === "synced" ? "done" : "post");
      } else {
        setNotice(
          j.status === "needs_review"
            ? "✓ 已走到第 ④ 步，等你复核"
            : j.status === "ocr_failed"
              ? "✗ 识别失败，见「异常待处理」"
              : `✓ 已处理（${j.status}）`,
        );
        setFilter(j.status === "needs_review" ? "review" : "exception");
      }
      router.refresh();
    } catch {
      setNotice("✗ 网络错误");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const noticeCls = notice?.startsWith("✓")
    ? "bg-conf-high-bg text-conf-high"
    : notice?.startsWith("⚠")
      ? "bg-conf-med-bg text-conf-med"
      : "bg-conf-low-bg text-conf-low";

  const filterLabel =
    filter === "exception"
      ? "异常待处理"
      : filter === "done"
        ? "已录入 QBO"
        : filter
          ? `第 ${STAGE_META[filter].index} 步 · ${STAGE_META[filter].label}`
          : null;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold text-ink-900">{client.name}</h1>
            {client.qboConnected ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-conf-high-bg px-2.5 py-0.5 text-[11px] font-medium text-conf-high">
                <span className="size-1.5 rounded-full bg-conf-high" /> QBO 已连接
              </span>
            ) : (
              <Link
                href={`/clients/${client.id}/settings`}
                className="inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-0.5 text-[11px] font-medium text-faint hover:text-ink-900"
              >
                <span className="size-1.5 rounded-full bg-line-strong" /> 未连 QBO · 去连接
              </Link>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            {client.industry} · 收单邮箱 <span className="font-mono text-ink-700">{client.inboundEmail}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink-800 disabled:opacity-50"
          >
            上传单据
          </button>
          <Link
            href={`/clients/${client.id}/settings`}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:text-ink-900"
          >
            设置
          </Link>
        </div>
      </header>

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.heic"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadFile(f);
        }}
      />

      {/* 五段流程轨道：整个界面的骨架，点任一段即筛选到该段 */}
      <div className="mt-6">
        <PipelineRail summary={pipeline} active={filter} onSelect={setFilter} />
      </div>

      {busy && (
        <div className="mt-3 rounded-xl border border-line bg-surface p-4">
          <div className="mb-2.5 flex items-center gap-2 text-sm font-medium text-ink-900">
            <span className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-ink-700" />
            正在处理 {fileName}…
          </div>
          <ol className="space-y-1.5">
            {INTAKE_STEPS.map((s) => (
              <li key={s} className="text-[13px] text-muted">
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}
      {notice && !busy && <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${noticeCls}`}>{notice}</div>}

      {/* 两条护栏：主链之外但必须有人管的事 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <GuardRail
          tone={missingReceipts.count > 0 ? "warn" : "ok"}
          title={missingReceipts.count > 0 ? `缺收据 ${missingReceipts.count} 笔` : "银行流水都有收据"}
          detail={
            missingReceipts.count > 0
              ? `${money(missingReceipts.amount)} 的支出没有票据支撑，拿不回进项税`
              : "本期每一笔银行支出都能对上单据"
          }
          actionLabel={missingReceipts.count > 0 ? "去对账追票" : "查看对账"}
          href={`/clients/${client.id}/reconciliation`}
        />
        <GuardRail
          tone={itcRisk.length > 0 ? "risk" : "ok"}
          title={itcRisk.length > 0 ? `凭证缺件 ${itcRisk.length} 张` : "抵扣凭证齐全"}
          detail={
            itcRisk.length > 0
              ? "按 CRA 规定，这些票的进项税抵不了，需要向客户要完整发票"
              : "现有单据都满足 CRA 抵扣凭证要件"
          }
          actionLabel={itcRisk.length > 0 ? "看不可抵扣清单" : "查看清单"}
          href={`/clients/${client.id}/itc-report`}
        />
      </div>

      <div className="mt-7 flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold text-ink-900">
          {filterLabel ?? "全部单据"}
          <span className="tnum ml-2 text-sm font-normal text-faint">{rows.length}</span>
        </h2>
        {filter && (
          <button onClick={() => setFilter(null)} className="text-xs text-muted hover:text-ink-900">
            显示全部
          </button>
        )}
      </div>

      {/* 批量确认：勾选后出现，不占常驻空间 */}
      {selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-ink-700/20 bg-ink-700/5 px-4 py-2.5">
          <span className="text-sm font-medium text-ink-900">已选 {selected.size} 张</span>
          <button
            onClick={batchConfirm}
            disabled={batchBusy}
            className="rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {batchBusy ? "确认中…" : "批量确认"}
          </button>
          <button
            onClick={batchSync}
            disabled={batchBusy}
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-700/10 disabled:opacity-40"
          >
            {batchBusy ? "录入中…" : "批量录入 QBO"}
          </button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-muted hover:text-ink-900">
            取消选择
          </button>
          <span className="text-[11px] text-faint">只确认科目与税码齐全的，缺件的会逐条报出原因</span>
        </div>
      )}

      {batchResult && (
        <div className="mt-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm">
          <span className="font-medium text-conf-high">已{batchResult.verb ?? "确认"} {batchResult.confirmed} 张</span>
          {batchResult.failed.length > 0 && (
            <>
              <span className="ml-2 text-conf-med">{batchResult.failed.length} 张未能{batchResult.verb ?? "确认"}：</span>
              <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
                {batchResult.failed.map((f, i) => (
                  <li key={i}>
                    {f.fileName} —— {f.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button onClick={() => setBatchResult(null)} className="mt-1.5 block text-xs text-muted hover:text-ink-900">
            知道了
          </button>
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="w-9 px-4 py-3" />
              <th className="px-4 py-3 font-semibold">单据</th>
              <th className="px-4 py-3 font-semibold">供应商</th>
              <th className="px-4 py-3 text-right font-semibold">金额</th>
              <th className="px-4 py-3 font-semibold">抵扣凭证</th>
              <th className="px-4 py-3 font-semibold">所在步骤</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const meta = STATUS_META[d.status];
              const stage = stageOf(d.status);
              const isNew = d.id === justUploadedId;
              return (
                <tr
                  key={d.id}
                  className={`border-b border-line transition-colors last:border-0 hover:bg-paper ${
                    isNew ? "rise bg-gold-50/40" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    {/* 只有待复核的能批量确认，其余不给勾选框免得误导 */}
                    {(d.status === "needs_review" || d.status === "confirmed" || d.status === "sync_failed") && (
                      <input
                        type="checkbox"
                        checked={selected.has(d.id)}
                        onChange={() => toggle(d.id)}
                        aria-label={`选择 ${d.fileName}`}
                        className="size-4 accent-ink-700"
                      />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`grid size-8 shrink-0 place-items-center rounded-md text-[11px] font-semibold ${
                          d.fileKind === "pdf" ? "bg-conf-low-bg text-conf-low" : "bg-conf-high-bg text-conf-high"
                        }`}
                      >
                        {d.fileKind === "pdf" ? "PDF" : "IMG"}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-ink-900">
                          {d.fileName}
                          {isNew && (
                            <span className="ml-2 rounded bg-gold-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                              新
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-faint">
                          {d.source === "email" ? "邮件" : "上传"} · {d.receivedAt}
                          {d.autoPosted && (
                            <span
                              title="符合绿色通道六条准入，未经人工复核自动录入。建议定期抽查。"
                              className="ml-1.5 rounded bg-ink-700/10 px-1.5 py-0.5 font-medium text-ink-700"
                            >
                              自动过账
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink-900">
                    {d.vendor}
                    <div className="text-[11px] text-faint">{d.invoiceNo}</div>
                  </td>
                  <td className="tnum px-4 py-3 text-right font-medium text-ink-900">{money(d.total)}</td>
                  <td className="px-4 py-3">
                    <ItcBadge itc={d.itc} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      {stage && <span className="tnum text-[11px] font-semibold text-faint">{STAGE_META[stage].index}</span>}
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${meta.cls}`}
                      >
                        <span className={`size-1.5 rounded-full ${CONF_DOT[d.confidence]}`} />
                        {meta.label}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(d.status === "needs_review" ||
                      d.status === "confirmed" ||
                      d.status === "sync_failed" ||
                      d.status === "synced") && (
                      <Link
                        href={`/documents/${d.id}/review`}
                        className="rounded-md px-2.5 py-1 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-700/10"
                      >
                        {d.status === "needs_review"
                          ? "复核 →"
                          : d.status === "synced"
                            ? "查看 →"
                            : "录入 QBO →"}
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-faint">
                  {filter ? "这一步没有单据 —— 说明这里不堵" : "还没有单据，上传一张试试"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 护栏卡片：是可点击的交互容器，所以用卡片是合理的（不是为了分组而套框）。
function GuardRail({
  tone,
  title,
  detail,
  actionLabel,
  href,
  onClick,
}: {
  tone: "ok" | "warn" | "risk";
  title: string;
  detail: string;
  actionLabel: string;
  href?: string;
  onClick?: () => void;
}) {
  const cls =
    tone === "risk"
      ? "border-conf-low/30 bg-conf-low-bg/40"
      : tone === "warn"
        ? "border-gold-100 bg-gold-50/60"
        : "border-line bg-surface";
  const titleCls = tone === "risk" ? "text-conf-low" : tone === "warn" ? "text-gold-700" : "text-ink-900";

  const inner = (
    <>
      <div className={`text-sm font-semibold ${titleCls}`}>{title}</div>
      <p className="mt-1 text-xs leading-snug text-muted">{detail}</p>
      <span className="mt-2 inline-block text-xs font-semibold text-ink-700">{actionLabel} →</span>
    </>
  );

  const shared = `block rounded-xl border p-4 text-left transition-colors hover:border-line-strong ${cls}`;
  return href ? (
    <Link href={href} className={shared}>
      {inner}
    </Link>
  ) : (
    <button onClick={onClick} className={shared}>
      {inner}
    </button>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getClient, getClientAudit } from "@/lib/queries";
import { labelActor, labelAudit, summarizeDetail, type AuditKind } from "@/lib/audit-labels";

const KIND_STYLE: Record<AuditKind, string> = {
  flow: "bg-paper text-muted",
  human: "bg-ink-700/10 text-ink-700",
  system: "bg-gold-50 text-gold-700",
  external: "bg-conf-high-bg text-conf-high",
  exception: "bg-conf-low-bg text-conf-low",
};

const PAGE_SIZE = 100;

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ doc?: string; page?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { doc, page } = await searchParams;
  const client = await getClient(session.firmId, id);
  if (!client) notFound();

  const pageNum = Math.max(1, Number(page) || 1);
  const { entries, total } = await getClientAudit(session.firmId, id, {
    documentId: doc,
    limit: PAGE_SIZE,
    offset: (pageNum - 1) * PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <Link href={`/clients/${id}`} className="text-sm text-muted transition-colors hover:text-ink-900">
        ← {client.name} · 流程工作台
      </Link>
      <h1 className="mt-2 font-display text-2xl font-bold text-ink-900">审计日志</h1>
      <p className="mt-1 text-sm text-muted">
        每一次状态跃迁、人工订正、自动过账都有记录。共 {total} 条
        {doc && (
          <>
            {" "}
            · 已筛选到单张单据{" "}
            <Link href={`/clients/${id}/audit`} className="text-ink-700 underline">
              查看全部
            </Link>
          </>
        )}
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-4 py-3 font-semibold">时间</th>
              <th className="px-4 py-3 font-semibold">操作者</th>
              <th className="px-4 py-3 font-semibold">动作</th>
              <th className="px-4 py-3 font-semibold">单据</th>
              <th className="px-4 py-3 font-semibold">详情</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const label = labelAudit(e.action);
              const actor = labelActor(e.userId);
              const detail = summarizeDetail(e.action, e.detail);
              return (
                <tr key={e.id} className="border-b border-line last:border-0 align-top hover:bg-paper">
                  <td className="tnum whitespace-nowrap px-4 py-2.5 text-[11px] text-faint">
                    {e.createdAt.slice(0, 10)}
                    <br />
                    {e.createdAt.slice(11, 19)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <span
                      className={`text-xs ${actor.isHuman ? "font-medium text-ink-900" : "text-faint"}`}
                    >
                      {actor.text}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${KIND_STYLE[label.kind]}`}>
                      {label.text}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {e.documentId ? (
                      <Link
                        href={`/clients/${id}/audit?doc=${e.documentId}`}
                        className="text-ink-700 transition-colors hover:underline"
                        title="只看这张单据的审计"
                      >
                        {e.fileName ?? e.documentId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-faint">客户级</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-muted">
                    <span className="line-clamp-2 break-all">{detail}</span>
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-faint">
                  暂无审计记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-faint">
            第 {pageNum} / {pages} 页
          </span>
          <div className="flex gap-2">
            {pageNum > 1 && (
              <Link
                href={`/clients/${id}/audit?page=${pageNum - 1}${doc ? `&doc=${doc}` : ""}`}
                className="rounded-lg border border-line px-3 py-1.5 text-muted hover:text-ink-900"
              >
                上一页
              </Link>
            )}
            {pageNum < pages && (
              <Link
                href={`/clients/${id}/audit?page=${pageNum + 1}${doc ? `&doc=${doc}` : ""}`}
                className="rounded-lg border border-line px-3 py-1.5 text-muted hover:text-ink-900"
              >
                下一页
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

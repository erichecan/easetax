import { getSession } from "@/lib/session";
import { getClient, getItcReport } from "@/lib/queries";
import { ITC_REQUIREMENT_LABELS, type ItcRequirement } from "@/domain";

// 不可抵扣清单导出 CSV：会计师要拿去发给客户或存档，界面上看不够。
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const client = await getClient(s.firmId, id);
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const url = new URL(req.url);
  const { rows, unrecoverableTax, period } = await getItcReport(s.firmId, id, {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });

  const header = ["日期", "供应商", "文件", "票面总额", "不可抵税额", "金额档", "缺失要件"];
  const lines = [
    header.join(","),
    ...rows.map((r) =>
      [
        r.txnDate,
        r.vendor,
        r.fileName,
        r.total.toFixed(2),
        r.taxAmount.toFixed(2),
        r.tier ?? "",
        r.missing.map((m) => ITC_REQUIREMENT_LABELS[m as ItcRequirement] ?? m).join(" / "),
      ]
        .map(csvCell)
        .join(","),
    ),
    ["", "", "合计", "", unrecoverableTax.toFixed(2), "", ""].join(","),
  ];

  // BOM：Excel 打开中文 CSV 不加 BOM 会乱码
  const body = "﻿" + lines.join("\r\n");
  const fileName = `不可抵扣清单-${client.name}-${period.replace(/[~\s]/g, "")}.csv`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}

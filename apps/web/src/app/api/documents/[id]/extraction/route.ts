import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

// 人工订正 OCR 抬头字段。OCR 必然会错，没有这条路复核台就不成立。
// 契约 G5：synced 后 QBO 是权威，本地不可再改。
// 凭证等级（§4.9）与税码规则（§4.8）都由这些字段派生，改完下次读取即重算，无需物化。

const TEXT_FIELDS = ["vendorName", "invoiceNo", "supplierTaxNumber", "recipientName", "paymentTerms"] as const;
const DATE_FIELDS = ["txnDate", "dueDate"] as const;
const MONEY_FIELDS = ["subTotal", "taxAmount", "total"] as const;

type Body = Partial<Record<(typeof TEXT_FIELDS)[number] | (typeof DATE_FIELDS)[number] | (typeof MONEY_FIELDS)[number], string | number | null>>;

function parseMoney(v: unknown): Prisma.Decimal | null | undefined {
  if (v === null || v === "") return null;
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined; // 非法值：跳过而不是写脏数据
  return new Prisma.Decimal(n.toFixed(2));
}

function parseDate(v: unknown): Date | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const doc = await prisma.document.findFirst({
    where: { id, firmId: s.firmId },
    include: { extraction: true },
  });
  if (!doc) return Response.json({ error: "单据不存在" }, { status: 404 });
  if (doc.status === "synced") {
    return Response.json({ error: "已录入 QBO 的单据不可修改，请到 QBO 里改" }, { status: 409 });
  }
  if (!doc.extraction) {
    return Response.json({ error: "该单据尚未产生识别结果，无法编辑" }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const data: Prisma.ExtractionUpdateInput = {};
  const rejected: string[] = [];

  for (const f of TEXT_FIELDS) {
    if (f in body) {
      const v = body[f];
      data[f] = v == null || v === "" ? null : String(v).trim();
    }
  }
  for (const f of DATE_FIELDS) {
    if (f in body) {
      const d = parseDate(body[f]);
      if (d === undefined) rejected.push(f);
      else data[f] = d;
    }
  }
  for (const f of MONEY_FIELDS) {
    if (f in body) {
      const m = parseMoney(body[f]);
      if (m === undefined) rejected.push(f);
      else data[f] = m;
    }
  }

  if (rejected.length) {
    return Response.json({ error: `字段格式非法：${rejected.join("、")}` }, { status: 400 });
  }
  if (!Object.keys(data).length) {
    return Response.json({ error: "没有要更新的字段" }, { status: 400 });
  }

  const before = Object.fromEntries(
    Object.keys(data).map((k) => [k, (doc.extraction as unknown as Record<string, unknown>)[k] ?? null]),
  );

  await prisma.extraction.update({ where: { documentId: id }, data });
  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      documentId: id,
      action: "extraction:manual_edit",
      // 留下改前改后，日后追责/复盘要看得见人工改过什么
      detail: { fields: Object.keys(data), before: JSON.parse(JSON.stringify(before)) } as Prisma.InputJsonValue,
    },
  });

  return Response.json({ ok: true, updated: Object.keys(data) });
}

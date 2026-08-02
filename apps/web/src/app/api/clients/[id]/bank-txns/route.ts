import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { parseBankCsv, txnFingerprint } from "@/lib/bank-csv";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

// 导入银行对账单 CSV。对账追票是收单的主引擎（业务流程设计 §2.1），
// 没有导入这条路，缺收据清单就只能靠 seed 造数据。
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const client = await prisma.client.findFirst({ where: { id, firmId: s.firmId } });
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "缺少 CSV 文件" }, { status: 400 });
  if (file.size > MAX_CSV_BYTES) {
    return Response.json({ error: `文件超过 ${MAX_CSV_BYTES / 1024 / 1024}MB 上限` }, { status: 400 });
  }

  const parsed = parseBankCsv(await file.text());
  if (!parsed.rows.length) {
    return Response.json(
      { error: parsed.errors[0]?.reason ?? "没有解析出任何支出流水", errors: parsed.errors.slice(0, 10) },
      { status: 400 },
    );
  }

  // 去重：同客户下 日期+摘要+金额 相同视为已导入过。对账单常有重叠期间，
  // 重复导入不该产生重复流水，否则缺收据清单会凭空翻倍。
  const existing = await prisma.bankTxn.findMany({
    where: { firmId: s.firmId, clientId: id },
    select: { date: true, description: true, amount: true },
  });
  const seen = new Set(
    existing.map((e) =>
      txnFingerprint(id, { date: e.date, description: e.description, amount: Number(e.amount) }),
    ),
  );

  const fresh = parsed.rows.filter((r) => {
    const fp = txnFingerprint(id, r);
    if (seen.has(fp)) return false;
    seen.add(fp); // 同一文件内部重复也只入一条
    return true;
  });

  if (fresh.length) {
    await prisma.bankTxn.createMany({
      data: fresh.map((r) => ({
        firmId: s.firmId,
        clientId: id,
        date: r.date,
        description: r.description,
        amount: new Prisma.Decimal(r.amount.toFixed(2)),
      })),
    });
  }

  await prisma.auditLog.create({
    data: {
      firmId: s.firmId,
      userId: s.userId,
      action: "bank_txns:import",
      detail: {
        clientId: id,
        fileName: file.name,
        parsed: parsed.rows.length,
        imported: fresh.length,
        duplicates: parsed.rows.length - fresh.length,
        rowErrors: parsed.errors.length,
        detectedColumns: parsed.detected,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return Response.json({
    ok: true,
    parsed: parsed.rows.length,
    imported: fresh.length,
    duplicates: parsed.rows.length - fresh.length,
    detected: parsed.detected,
    errors: parsed.errors.slice(0, 20),
    errorCount: parsed.errors.length,
  });
}

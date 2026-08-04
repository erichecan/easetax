import { getSession } from "@/lib/session";
import { confirmDocument, type LineAssignment } from "@/lib/pipeline/confirm";

// 确认复核：持久化每行 GL 科目 + 学习飞轮（回写供应商规则）+ 状态 → confirmed。
// 业务逻辑在 lib/pipeline/confirm.ts —— seed 与批量确认共用同一份飞轮语义。
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { assignments?: LineAssignment[] };

  const r = await confirmDocument({
    documentId: id,
    firmId: s.firmId,
    userId: s.userId,
    assignments: body.assignments,
  });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.httpStatus });

  return Response.json({ ok: true, ruleWritten: r.ruleWritten });
}

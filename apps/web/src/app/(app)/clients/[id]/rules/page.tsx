import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getClient, getClientAccounts, getClientRules } from "@/lib/queries";
import { RulesManager } from "@/components/rules-manager";

export default async function RulesPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const client = await getClient(session.firmId, id);
  if (!client) notFound();

  const [rules, accounts] = await Promise.all([getClientRules(session.firmId, id), getClientAccounts(id)]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <Link href={`/clients/${id}`} className="text-sm text-muted transition-colors hover:text-ink-900">
        ← {client.name} · 流程工作台
      </Link>
      <h1 className="mt-2 font-display text-2xl font-bold text-ink-900">分类规则</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        规则的优先级高于 AI —— 命中规则就不再问 AI。所以一条错规则会持续影响后续所有单据，
        这里可以随时改或删。复核确认时整单归同一科目，系统会自动把它学成供应商规则。
      </p>

      <RulesManager clientId={id} rules={rules} accounts={accounts} />
    </div>
  );
}

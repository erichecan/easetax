import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getClient, getReconciliation } from "@/lib/queries";
import { Reconciliation } from "@/components/reconciliation";

export default async function ReconciliationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const client = await getClient(session.firmId, id);
  if (!client) notFound();
  const { rows, period, candidates } = await getReconciliation(session.firmId, id);

  return <Reconciliation client={client} rows={rows} period={period} candidates={candidates} />;
}

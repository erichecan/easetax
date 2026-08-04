import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getClient, getClientWorkbench } from "@/lib/queries";
import { ClientWorkbench } from "@/components/client-workbench";

// 客户工作台：按业务流程五段编排的落地页（docs/20260802-业务流程设计.md §2.2）。
export default async function ClientWorkbenchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const client = await getClient(session.firmId, id);
  if (!client) notFound();

  const { docs, pipeline, missingReceipts } = await getClientWorkbench(session.firmId, id);

  return (
    <ClientWorkbench client={client} docs={docs} pipeline={pipeline} missingReceipts={missingReceipts} />
  );
}

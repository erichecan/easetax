import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getClient, getClientAccounts } from "@/lib/queries";
import { ClientSettings } from "@/components/client-settings";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ qbo?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { qbo } = await searchParams;
  const client = await getClient(session.firmId, id);
  if (!client) notFound();
  const accounts = await getClientAccounts(id);

  return <ClientSettings client={client} accounts={accounts} qboJustConnected={qbo === "connected"} />;
}

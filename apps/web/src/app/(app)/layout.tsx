import { headers } from "next/headers";
import { Sidebar } from "@/components/sidebar";
import { requireSession } from "@/lib/session";
import { getClientsForFirm, getClientIdOfDocument, getFirm } from "@/lib/queries";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const [clients, firm, h] = await Promise.all([
    getClientsForFirm(session.firmId),
    getFirm(session.firmId),
    headers(),
  ]);

  // 复核页的路由里没有 clientId，靠单据反查，否则侧边栏在复核时会「失去位置」。
  const pathname = h.get("x-pathname") ?? "";
  const docId = pathname.match(/^\/documents\/([^/]+)\/review/)?.[1];
  const activeClientId = docId ? await getClientIdOfDocument(session.firmId, docId) : null;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar clients={clients} firmName={firm?.name ?? "易账"} activeClientId={activeClientId} />
      <main className="flex-1 overflow-y-auto bg-paper">{children}</main>
    </div>
  );
}

import { redirect } from "next/navigation";

// 单据队列已并入按流程编排的客户工作台；保留此路由，旧链接不 404。
export default async function DocumentsRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/clients/${id}`);
}

// 会话：JWT 存 httpOnly cookie（SSR 友好）。服务端组件/路由用 getSession 读。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyToken, type AuthPayload } from "@/lib/auth";

export const SESSION_COOKIE = "easetax_session";

export async function getSession(): Promise<AuthPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}

// 页面用：无会话跳登录。
export async function requireSession(): Promise<AuthPayload> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

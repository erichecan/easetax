// Next 16：middleware 已改名为 proxy。此处做「乐观」认证守卫（仅校验 JWT，不查库）。
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const SESSION_COOKIE = "easetax_session";
// 公开 API（无需登录）：登录、邮件入站 webhook（自带签名校验）
const PUBLIC_API = ["/api/auth/login", "/api/inbound/email"];

async function isValid(token?: string): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const authed = await isValid(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/") {
    return NextResponse.redirect(new URL(authed ? "/clients" : "/login", req.url));
  }

  if (pathname === "/login") {
    return authed ? NextResponse.redirect(new URL("/clients", req.url)) : NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    if (PUBLIC_API.some((p) => pathname.startsWith(p))) return NextResponse.next();
    return authed ? NextResponse.next() : NextResponse.json({ error: "未授权访问" }, { status: 401 });
  }

  // 其余为受保护页面
  if (!authed) return NextResponse.redirect(new URL("/login", req.url));
  // 把路径透给 server layout：侧边栏要据此判断当前在哪个客户下
  // （复核页 /documents/:id/review 的 URL 里没有 clientId）。
  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 排除静态资源与带扩展名的文件
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};

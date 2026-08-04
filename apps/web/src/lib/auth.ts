import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "@/domain";

export type AuthPayload = { userId: string; firmId: string; role: UserRole };

function secretKey(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET 未配置");
  return new TextEncoder().encode(s);
}

export async function signToken(payload: AuthPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function verifyToken(token: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, secretKey());
  return payload as AuthPayload;
}

// API 路由第一行调用；无/错 token 抛出 Response(401)（契约 G8 / CLAUDE.md §十）。
export async function requireAuth(request: Request): Promise<AuthPayload> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new Response(JSON.stringify({ error: "未授权访问" }), { status: 401 });
  }
  try {
    return await verifyToken(header.slice(7));
  } catch {
    throw new Response(JSON.stringify({ error: "Token 无效或已过期" }), { status: 401 });
  }
}

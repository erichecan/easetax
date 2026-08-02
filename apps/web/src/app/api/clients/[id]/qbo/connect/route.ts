import { SignJWT } from "jose";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { intuitCredsFromEnv } from "@/lib/providers/qbo-intuit";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const SCOPE = "com.intuit.quickbooks.accounting";

// 发起 QBO OAuth：302 到 Intuit 授权页。
// state 是签名 JWT（含 clientId + firmId + 5 分钟过期），回调时校验，防 CSRF 与跨租户串号。
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const { id } = await params;
  const client = await prisma.client.findFirst({ where: { id, firmId: s.firmId } });
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const creds = intuitCredsFromEnv();
  if (!creds) {
    return Response.json({ error: "服务端未配置 Intuit 凭据（QBO_CLIENT_ID/SECRET）" }, { status: 503 });
  }

  const redirectUri = process.env.QBO_REDIRECT_URI ?? new URL(`/api/clients/${id}/qbo/callback`, req.url).toString();
  const state = await new SignJWT({ clientId: id, firmId: s.firmId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return Response.redirect(url.toString(), 302);
}

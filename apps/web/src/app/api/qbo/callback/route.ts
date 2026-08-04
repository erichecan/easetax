import { jwtVerify } from "jose";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { intuitCredsFromEnv } from "@/lib/providers/qbo-intuit";
import { getQboProvider } from "@/lib/providers";
import { qboRedirectUri } from "@/lib/qbo-redirect";

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// OAuth 回调：校验 state → 用 code 换 token → 加密存 refreshToken + realmId
// → 顺带把该客户的科目表与税码表同步进本地 cache（契约 §4.5/§4.8）。
//
// ⚠️ 这个路径**必须是固定的、不带 clientId**：Intuit 要求 redirect_uri 与开发者门户里
// 登记的 URI 精确匹配，而登记是一次性的——每客户一个回调路径就得登记 N 条，做不到。
// 客户身份改从签名 state 里取（state 本来就带 clientId + firmId，且已防 CSRF/跨租户）。
export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return Response.json({ error: "未授权访问" }, { status: 401 });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = url.searchParams.get("state");
  if (!code || !realmId || !state) {
    return Response.json({ error: "回调缺少 code / realmId / state" }, { status: 400 });
  }

  // state 校验：必须是我们签发的、未过期的，且租户对得上（防 CSRF / 跨 firm 串号）
  let id: string;
  try {
    const { payload } = await jwtVerify(state, new TextEncoder().encode(process.env.JWT_SECRET));
    if (payload.firmId !== s.firmId || typeof payload.clientId !== "string") {
      return Response.json({ error: "state 与当前登录身份不匹配" }, { status: 400 });
    }
    id = payload.clientId;
  } catch {
    return Response.json({ error: "state 校验失败或已过期" }, { status: 400 });
  }

  const client = await prisma.client.findFirst({ where: { id, firmId: s.firmId } });
  if (!client) return Response.json({ error: "客户不存在" }, { status: 404 });

  const creds = intuitCredsFromEnv();
  if (!creds) return Response.json({ error: "服务端未配置 Intuit 凭据" }, { status: 503 });

  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    // 换 token 时的 redirect_uri 必须与授权时那次逐字一致，所以两处共用 qboRedirectUri()
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: qboRedirectUri(req) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return Response.json({ error: `换取 token 失败: ${text.slice(0, 200)}` }, { status: 502 });
  }
  const tokens = (await res.json()) as { refresh_token: string };

  await prisma.client.update({
    where: { id },
    data: { qboRealmId: realmId, qboRefreshToken: encryptSecret(tokens.refresh_token) },
  });
  await prisma.auditLog.create({
    data: { firmId: s.firmId, userId: s.userId, action: "qbo:connected", detail: { clientId: id, realmId } },
  });

  // 连接成功即同步科目/税码 —— 分类与税码规则都依赖这两张表（准确率地基）。
  const synced = await syncCatalogs(id, realmId, tokens.refresh_token).catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }));

  const back = new URL(`/clients/${id}/settings`, req.url);
  back.searchParams.set("qbo", "connected");
  if ("error" in synced) back.searchParams.set("catalog", "failed");
  return Response.redirect(back.toString(), 302);
}

async function syncCatalogs(clientId: string, realmId: string, refreshToken: string) {
  const qbo = getQboProvider();
  const ctx = await qbo.connect({ realmId, refreshToken });
  const [accounts, taxCodes] = await Promise.all([qbo.listAccounts(ctx), qbo.listTaxCodes(ctx)]);

  for (const a of accounts) {
    await prisma.glAccountCache.upsert({
      where: { clientId_qboAccountId: { clientId, qboAccountId: a.qboAccountId } },
      update: { name: a.name, accountType: a.accountType, accountSubType: a.accountSubType, syncedAt: new Date() },
      create: {
        clientId,
        qboAccountId: a.qboAccountId,
        name: a.name,
        accountType: a.accountType,
        accountSubType: a.accountSubType,
      },
    });
  }
  // 税码只同步 id/名字；semanticKey（规则表的桥）由人工在设置里指认，不猜（契约 G10）。
  for (const t of taxCodes) {
    await prisma.taxCodeCache.upsert({
      where: { clientId_qboTaxCodeId: { clientId, qboTaxCodeId: t.qboTaxCodeId } },
      update: { name: t.name, isGroup: t.isGroup, syncedAt: new Date() },
      create: { clientId, qboTaxCodeId: t.qboTaxCodeId, name: t.name, isGroup: t.isGroup },
    });
  }
  return { accounts: accounts.length, taxCodes: taxCodes.length };
}

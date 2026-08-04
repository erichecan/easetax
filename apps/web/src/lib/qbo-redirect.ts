// OAuth redirect_uri 的唯一来源：授权（connect）与换 token（callback）两处必须逐字一致，
// 否则 Intuit 直接拒。路径固定不带 clientId —— Intuit 要求 redirect_uri 与开发者门户里
// 登记的 URI 精确匹配，而登记是一次性的，每客户一条路径根本登记不过来。
// 客户身份改走签名 state（见 src/app/api/qbo/callback/route.ts）。
export function qboRedirectUri(req: Request): string {
  return process.env.QBO_REDIRECT_URI?.trim() || new URL("/api/qbo/callback", req.url).toString();
}

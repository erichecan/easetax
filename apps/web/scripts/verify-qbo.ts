// 直连 Intuit 沙箱跑通整条录入链，用的是 app 自己的 provider（不是平行实现）——
// 这个脚本过了，就等于 app 的 QBO 路径过了。
//
// 跑：npm run verify:qbo
// 需要 .env 里有 QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REFRESH_TOKEN / QBO_REALM_ID
// （前两个从 Intuit 开发者门户 Keys & OAuth 拿，后两个从 OAuth 2.0 Playground 拿，
//   见 docs/20260709-qbo-开发者账号与沙箱指引.md）
import { IntuitQboProvider, intuitCredsFromEnv } from "@/lib/providers/qbo-intuit";
import type { QboAccessContext } from "@/lib/providers/qbo";

// 沙箱里留下的痕迹带固定前缀，方便事后辨认/清理
const VENDOR = "Easetax 链路验证供应商";
const DOC_NUMBER = `EASETAX-VERIFY-${new Date().toISOString().slice(0, 10)}`;

// 最小合法 PDF（不到 300 字节），用来验证附件通道，不引外部文件
const TINY_PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9U" +
    "eXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50" +
    "IDIgMCBSL01lZGlhQm94WzAgMCA5OSA5OV0+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4K",
  "base64",
);

let step = 0;
function ok(msg: string) {
  console.log(`  ✅ [${++step}] ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ❌ [${step + 1}] ${msg}`);
  process.exit(1);
}

async function main() {
  const creds = intuitCredsFromEnv();
  if (!creds) fail("缺 QBO_CLIENT_ID / QBO_CLIENT_SECRET，先按 docs/20260709-qbo-开发者账号与沙箱指引.md 填 .env");
  const refreshToken = process.env.QBO_REFRESH_TOKEN?.trim();
  const realmId = process.env.QBO_REALM_ID?.trim();
  if (!refreshToken || !realmId) fail("缺 QBO_REFRESH_TOKEN / QBO_REALM_ID（用 OAuth 2.0 Playground 拿）");

  if (creds.environment !== "sandbox") {
    fail(`QBO_ENVIRONMENT=${creds.environment}——这个脚本会真的建 Bill，拒绝对生产账套运行`);
  }

  console.log(`\nQBO 链路验证 · 环境=${creds.environment} · realmId=${realmId}\n`);
  const qbo = new IntuitQboProvider(creds);

  // 1. 刷 token
  let ctx: QboAccessContext;
  try {
    ctx = await qbo.connect({ realmId, refreshToken });
  } catch (e) {
    fail(`刷新 access token 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  ok(`access token 到手（${ctx.accessToken.slice(0, 12)}…）`);

  // 2. 科目表
  const accounts = await qbo.listAccounts(ctx).catch((e) => fail(`列科目失败：${e.message}`));
  if (!accounts.length) fail("沙箱一个 Expense 科目都没有，链路无法继续");
  ok(`Expense 科目 ${accounts.length} 个，例：${accounts.slice(0, 3).map((a) => `${a.name}(${a.qboAccountId})`).join(" / ")}`);

  // 3. 税码表
  const taxCodes = await qbo.listTaxCodes(ctx).catch((e) => fail(`列税码失败：${e.message}`));
  ok(`税码 ${taxCodes.length} 个：${taxCodes.map((t) => `${t.name}(${t.qboTaxCodeId}${t.isGroup ? ",组" : ""})`).join(" / ") || "（空——美国沙箱通常没有销售税码）"}`);

  // 4. 供应商（查不到才建）
  const vendor = await qbo.findOrCreateVendor(ctx, VENDOR).catch((e) => fail(`查/建供应商失败：${e.message}`));
  ok(`供应商 ${vendor.name} → Id=${vendor.id}`);

  // 5. 建 Bill。科目取第一个 Expense；税码取第一个非组税码，沙箱没有就留空
  const account = accounts[0];
  const taxCode = taxCodes.find((t) => !t.isGroup);
  if (!taxCode) {
    console.log("  ⚠️  沙箱无可用税码 —— 本次以空税码建单，加拿大税逻辑（契约 G6）仍未实测");
  }
  const line = {
    description: "链路验证行",
    amount: "42.00",
    glAccountId: account.qboAccountId,
    taxCodeId: taxCode?.qboTaxCodeId ?? "",
  };
  const posted = await qbo
    .post(ctx, {
      entity: "Bill",
      vendorName: VENDOR,
      docNumber: DOC_NUMBER,
      txnDate: new Date().toISOString().slice(0, 10),
      dueDate: null,
      currency: null,
      lines: [line],
    })
    .catch((e) => fail(`建 Bill 失败：${e.message}`));
  ok(`${posted.entity} Id=${posted.id} DocNumber=${posted.docNumber} duplicate=${posted.duplicate}`);

  // 6. 挂附件
  await qbo
    .attach(ctx, "Bill", posted.id, {
      fileName: `${DOC_NUMBER}.pdf`,
      mimeType: "application/pdf",
      bytes: new Uint8Array(TINY_PDF),
    })
    .catch((e) => fail(`挂附件失败：${e.message}`));
  ok("原件已作为 Attachable 挂到该 Bill");

  // 7. 同 docNumber 再建一次 —— 必须命中去重，不能产生第二张单
  const again = await qbo
    .post(ctx, {
      entity: "Bill",
      vendorName: VENDOR,
      docNumber: DOC_NUMBER,
      txnDate: null,
      dueDate: null,
      currency: null,
      lines: [line],
    })
    .catch((e) => fail(`重复录入探测失败：${e.message}`));
  if (!again.duplicate || again.id !== posted.id) {
    fail(`去重失效：期望命中 Id=${posted.id}，实际 duplicate=${again.duplicate} Id=${again.id}`);
  }
  ok(`重复录入被拦下，命中原单 Id=${again.id}（没有产生第二张）`);

  console.log("\n全部通过。可在沙箱里核对：");
  console.log(`  Bill Id=${posted.id} · DocNumber=${DOC_NUMBER} · 供应商=${VENDOR}`);

  // refresh token 每次刷新都轮换，不回填的话下次跑这个脚本就是 400 invalid_grant
  if (ctx.rotatedRefreshToken) {
    console.log("\n⚠️  refresh token 已轮换，把 .env 里的 QBO_REFRESH_TOKEN 换成：");
    console.log(`  ${ctx.rotatedRefreshToken}`);
  }
}

main().catch((e) => {
  console.error("\n未预期的失败：", e);
  process.exit(1);
});

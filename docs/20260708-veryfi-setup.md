# Veryfi OCR 接入指引

> 日期：2026-07-08
> 目的：拿到 Veryfi 凭据 → 填进 `.env` → 我们的 `getOcrProvider()` 自动从 mock 切到真实 Veryfi。
> 事实来源：Veryfi 官方文档（2026-07-08 核实），逐条标注。
>
> ✅ **2026-07-08 已用你配置的 key 实测通过**：鉴权正常（纯 apikey，无需 HMAC）、字段映射用真实响应逐条核对无误。§4 脚本保留供日后排查，**当前无需再手动跑**。

---

## 0. 你只需要做三件事

1. 注册 Veryfi、拿 4 个凭据（§2）
2. 填进 `apps/web/.env`（§3）
3. 跑一次验证脚本，把输出发我（§4）——我据此确认字段映射、去掉代码里的「待实测确认」标注

代码侧已就绪：`VERYFI_*` 三个变量一填，[ocr-factory.ts](../apps/web/src/lib/providers/ocr-factory.ts) 自动选用 [VeryfiOcrProvider](../apps/web/src/lib/providers/ocr-veryfi.ts)，**上层不用改任何东西**。

---

## 1. 套餐与费用（官方核实）

| 项 | 事实 |
|----|------|
| 免费额度 | **100 份/月，永久免费**，含全部文档类型 + 开发 SDK。开发阶段够用 |
| 付费起步 | Starter：**$500/月最低消费**（约 <5k 份/月）。收据 $0.08 / 发票 $0.16 / 银行流水 $0.25 每份 |
| 试用 | 14 天免费试用（付费功能），无需信用卡。**但免费 100 份/月本身不需要试用** |
| 文件限制 | 单文件 ≤ 20MB、≥ 250 字节；单次最多 15 页；限流 60 请求/秒 |

> 结论：**先注册免费额度即可，别开付费**。上线放量前再评估 Starter。

---

## 2. 注册并获取凭据

1. 打开 <https://www.veryfi.com/> → **Sign Up**（或直接 <https://app.veryfi.com/>），用邮箱注册。
2. 登录后进入 **Settings → Keys**：<https://app.veryfi.com/api/settings/keys/>
3. 复制这 **4 个值**（同一页面）：

| 凭据 | 用途 | 填到 .env |
|------|------|-----------|
| `CLIENT_ID` | 客户端标识（`CLIENT-ID` 头） | `VERYFI_CLIENT_ID` |
| `Username` | 鉴权用户名 | `VERYFI_USERNAME` |
| `API KEY` | 鉴权密钥 | `VERYFI_API_KEY` |
| `Client Secret` | HMAC 签名用（可能需要，见 §5） | `VERYFI_CLIENT_SECRET` |

> 鉴权格式（官方核实）：`CLIENT-ID: <client_id>` + `AUTHORIZATION: apikey <username>:<api_key>`。

---

## 3. 填进环境变量

编辑 `apps/web/.env`（已被 gitignore，勿提交）：

```bash
VERYFI_CLIENT_ID="你的 client_id"
VERYFI_USERNAME="你的 username"
VERYFI_API_KEY="你的 api_key"
VERYFI_CLIENT_SECRET="你的 client_secret"   # 先填上，HMAC 若需要就用得上
```

模板见 [.env.example](../apps/web/.env.example)。

---

## 4. 验证脚本（拿一张真实发票跑通，把输出发我）

把下面存成 `apps/web/verify-veryfi.mjs`，准备一张发票 PDF/图片，运行：

```bash
cd apps/web
node --env-file=.env verify-veryfi.mjs ./你的发票.pdf
```

```js
// verify-veryfi.mjs —— 纯 apikey 鉴权跑一次真实 OCR，打印映射字段 + 原始 JSON。
import { readFile } from "node:fs/promises";

const { VERYFI_CLIENT_ID, VERYFI_USERNAME, VERYFI_API_KEY } = process.env;
const path = process.argv[2];
if (!path) { console.error("用法: node --env-file=.env verify-veryfi.mjs <发票文件>"); process.exit(1); }
if (!VERYFI_CLIENT_ID || !VERYFI_USERNAME || !VERYFI_API_KEY) { console.error("缺 VERYFI_* 环境变量"); process.exit(1); }

const bytes = await readFile(path);
const res = await fetch("https://api.veryfi.com/api/v8/partner/documents/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Client-Id": VERYFI_CLIENT_ID,
    Authorization: `apikey ${VERYFI_USERNAME}:${VERYFI_API_KEY}`,
  },
  body: JSON.stringify({ file_name: path.split("/").pop(), file_data: bytes.toString("base64") }),
});

console.log("HTTP", res.status);
const json = await res.json();
if (!res.ok) { console.error("失败：", JSON.stringify(json).slice(0, 500)); process.exit(1); }

// 我们关心的映射字段（对照 ocr-veryfi.ts 的「待实测确认」）
console.log("\n=== 映射字段 ===");
console.log("vendor.name   :", json.vendor?.name);
console.log("invoice_number:", json.invoice_number);
console.log("date          :", json.date);
console.log("due_date      :", json.due_date);
console.log("currency_code :", json.currency_code);
console.log("subtotal/tax/total:", json.subtotal, json.tax, json.total);
console.log("line_items[0] :", JSON.stringify(json.line_items?.[0]));
console.log("score         :", json.score);
console.log("\n=== 原始 JSON 顶层字段 ===");
console.log(Object.keys(json).sort().join(", "));
```

**跑完把这些发我**：
- `HTTP` 状态码
- 「映射字段」整段
- 「原始 JSON 顶层字段」列表

我据此核对/修正 [ocr-veryfi.ts](../apps/web/src/lib/providers/ocr-veryfi.ts) 的字段路径与置信度来源，去掉「待实测确认」。**跑完删掉 `verify-veryfi.mjs`**（临时脚本不入库）。

---

## 5. 已知坑与合规

| 项 | 说明 |
|----|------|
| **HMAC 签名** | 官方文档称 POST 还需 `X-Veryfi-Request-Signature`(HMAC-SHA256) + `X-Veryfi-Request-Timestamp`。很多账号纯 apikey 即可。§4 脚本用纯 apikey：**若返回 401/签名相关错误**，把错误发我，我用 `VERYFI_CLIENT_SECRET` 补签名逻辑 |
| **数据出境（PIPEDA）** | Veryfi 是美国公司，发票会上传其云端处理。官方声称 PIPEDA 合规，但**真实客户数据接入前**需确认其数据驻留 / 签 DPA——这与「Neon 暂用美国区」是同一条待办：demo/sandbox 阶段可用，真实客户数据前收口 |
| **额度** | 免费 100 份/月，超了会失败或计费。开发别批量刷 |
| **文件限制** | ≤20MB、≥250 字节、≤15 页（与我们 M1 校验一致） |

---

## 6. 接入后会发生什么

填好 `.env` 重启 dev server 后：
- `getOcrProvider()` 检测到 `VERYFI_*` 齐全 → 用真实 Veryfi（否则继续 mock，控制台会打印 `使用 mock OCR provider`）。
- 真正把 OCR 结果落库（Extraction 表）还需 Prisma migrate（等 Neon `DATABASE_URL`）。**在那之前，Veryfi 可先用 §4 脚本独立验证**，两件事不互相阻塞。

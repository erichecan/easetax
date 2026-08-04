# DEV-PLAN — Easetax 易账 AP 工作台 MVP

> 日期：2026-07-08
> 规模判定：**大改（BIG）**——引入 DB schema、鉴权体系、外部集成，涉及远超 5 个文件。按 CLAUDE.md §十三 附架构/质量/性能评估。
> 生成后**停下等确认**（见文末 §9），未确认不写代码。

---

## 1. 读取的产品文档

| 文档 | 作用 |
|------|------|
| [20260707-ap-workbench-mvp-requirements.md](docs/20260707-ap-workbench-mvp-requirements.md) | MVP 范围锚（决策） |
| [20260707-ap-workbench-prd.md](docs/20260707-ap-workbench-prd.md) | PRD：模块/状态机/路由 |
| [20260707-qbo-api-录入链验证.md](docs/20260707-qbo-api-录入链验证.md) | QBO 录入链技术验证 |
| [20260622-product-plan.md](docs/20260622-product-plan.md) / [20260702-plan-supplement.md](docs/20260702-plan-supplement.md) | 大规划背景（非 MVP 范围） |
| **[20260708-data-ownership-contract.md](docs/20260708-data-ownership-contract.md)** | **数据契约（SSOT，优先于 PRD）——本计划的建模依据** |

**范围（本计划只覆盖）**：MVP 核心链 **收单 → OCR → 分类 → 复核 → 录入 QBO**（单客户跑通，schema 预留多租户）。明确不做：审批/付款/多客户界面/T2 报税/人才基地/Xero/归档回传/加拿大税逻辑（先跑不含税骨架）。

---

## 2. 技术栈（现状 + 提议）

| 层 | 现状 | 提议 |
|----|------|------|
| 框架 | Next **16.2.10** App Router（单 app `apps/web`） | 沿用；**API Routes + Server Actions**，不另起独立后端服务（匹配现有单服务 Cloud Run 部署） |
| 语言 | TypeScript | 沿用，禁 `any` |
| UI | Tailwind v4（无 shadcn） | 沿用现有组件风格；按需引 shadcn |
| ORM/DB | **无** | **Prisma + PostgreSQL**（待确认托管方式，§9） |
| 鉴权 | **无** | JWT（jose）+ `middleware.ts` 统一保护 `/api/*` + 行级 `firmId` 隔离 |
| 存储 | **无** | 对象存储放原件（待确认区域，§9 与 PIPEDA 相关） |
| 领域模型单源 | demo `src/lib/types.ts` 已漂移 | `apps/web/src/domain/`（唯一枚举）+ Prisma 生成类型；`types.ts` 改 re-export |

> ⚠️ **Next 16 提醒**：`apps/web/AGENTS.md` 声明本版 Next 有 breaking changes，写任何 Next 代码前先读 `node_modules/next/dist/docs/`，不照训练记忆硬写。

---

## 3. 数据库 schema

**以 [数据契约 §3](docs/20260708-data-ownership-contract.md) 的 Prisma 模型为唯一来源**，不在此重复。落地要点：
- 每张业务表带 `firmId`；`Document` 拆 `Extraction`；金额全 `Decimal`；`GlAccountCache` 用 QBO `Account.Id`。
- 唯一 `DocStatus` 枚举（契约 §4.1），删 demo 别名。
- 首个 migration：`init_ap_core`（Firm/User/Client/Document/Extraction/LineItem/ClassificationRule/GlAccountCache/BankTxn/AuditLog）。

---

## 4. 开发顺序（模块拆解，按依赖排列）

> 铁律：走契约 §6 Strangler——先立唯一模型/枚举，UI 与集成都依赖它，而不是各写各的。
> **外部密钥门控**：P2/P3/P5 需外部账号密钥（Veryfi/Claude/Intuit）。全部走 **Provider 接口抽象**，密钥未到位时用 mock provider 跑通闭环，到位即切真实实现——P0/P1/P4 不被外部依赖阻塞。

| 阶段 | 模块 | 产出 | 外部依赖 |
|------|------|------|---------|
| **P0** 基座 | 工作区/Prisma/Postgres、`src/domain` 唯一枚举、`lib/db`、JWT + middleware + firm 隔离、AuditLog + 状态机跃迁函数（非法转移抛错） | 可登录、schema 落地、空壳受保护 API | 无 |
| **P1** 收单 M1 | Client CRUD、手动上传（对象存储）、`fileHash` 去重、专属邮箱入站 webhook（签名校验）、Document 落 `received` | 单据进队列 | 邮件入站服务（可后置） |
| **P2** OCR M2 | `OcrProvider` 接口 + Veryfi 实现（mock 兜底）、Extraction 落库、失败重试 3 次 + 退避、`ocr_failed` | OCR 结构化结果 | 🔑 Veryfi key |
| **P3** 分类 M3 | `ClassificationRule` 规则优先 + `Classifier` 接口 + Claude 实现（mock 兜底）、confidence 分级、doc 级 confidence 派生（契约 §4.7）、修正回写规则 | 每行带建议科目 + 置信度 | 🔑 Claude key |
| **P4** 复核工作台 M4 | 三栏 UI（左原件/中 OCR+分类内联编辑/右 Bill 预览-派生）、低置信度置顶高亮、异常提示、确认/退回、审计留痕 | 会计师可复核确认 | 无（读 P2/P3 结果） |
| **P5** 录入 QBO M5 | QBO OAuth 连接（refresh token 加密存）、查/建 Vendor、建 Bill、挂 Attachable、系统指纹 + QBO 二次去重、`qboBillId` 回填、`synced` 后只读（契约 G5） | 一键录入 QBO sandbox | 🔑 Intuit sandbox 凭据 |
| **P6** 护栏/验收 | 不变量入 CI（接 `validating-data-integrity`）：`Σ LineItem.amount(+税)==Extraction.total`、`stats==count(status)`；E2E 真实 API 驱动（接 `testing-end-to-end-experience`）；对照 PRD §9 七条验收 | 绿灯 + 报告 | 无 |

---

## 5. 页面 / API 路由清单

**页面**（PRD §6）：`/login`、`/clients`、`/clients/:id/connect`（QBO OAuth）、`/clients/:id/documents`（队列）、`/documents/:id/review`（三栏）、`/clients/:id/settings`（收单邮箱）。

**API**（PRD §7，⛔ 写操作全 `requireAuth` + firm 隔离）：
`POST /api/auth/login`(公开) ｜ `GET/POST /api/clients` ｜ `GET /api/clients/:id/qbo/connect`→302 ｜ `GET /api/clients/:id/qbo/callback`(state 校验) ｜ `POST /api/documents/upload` ｜ `POST /api/inbound/email`(🔑 webhook 签名，非 JWT) ｜ `GET /api/documents?clientId=&status=` ｜ `GET /api/documents/:id` ｜ `POST /api/documents/:id/reprocess` ｜ `PATCH /api/documents/:id/lines` ｜ `POST /api/documents/:id/confirm` ｜ `POST /api/documents/:id/sync-qbo` ｜ `POST /api/rules`。

---

## 6. 架构 / 质量 / 性能评估（BIG 改必答）

**架构**
- 边界清晰：单 Next app 内 `domain`(纯模型) → `lib/db`(Prisma) → `lib/providers`(外部集成接口) → API Routes → 页面。外部集成一律接口抽象，可 mock、可替换（Veryfi→其他 OCR、QBO→Xero 无需动上层）。
- 单点故障：DB、外部 API。缓解——外部调用重试+退避+状态落库（失败可重放），QBO 429 尊重 `Retry-After`。
- **异步处理 vs `min-instances=0`（成本）**：Cloud Run 缩容到 0 不能常驻 worker。MVP 决策——OCR/分类用**触发式处理**（上传落 `received` 后由 `/api/documents/:id/reprocess` 或 Cloud Tasks 触发），不建常驻队列，保住 min=0 零费用。低流量可接受，放量再上 Cloud Tasks/Pub-Sub。

**质量（DRY / 边界）**
- 复用 SSOT：所有枚举/类型来自 `domain`，**替换** demo `types.ts` 而非再复制一份（否则又是一处漂移）。
- Provider 抽象避免 OCR/分类逻辑散落。
- 边界：未连 QBO（一等状态，契约 §4.2）、OCR 空结果、重复文件、税额与总额不符、refresh token 过期轮换——逐一显式处理，不用 `any` 绕。

**性能**
- 队列分页；复核页避免 N+1（一次 join 拉 Document+Extraction+LineItem）。
- OCR/分类不阻塞上传响应。
- QBO 限流约 500/min/公司，加退避。

---

## 7. 风险点

| 风险 | 级别 | 应对 |
|------|------|------|
| **PIPEDA 数据驻留**：文档要求客户税务数据存加拿大区，现部署在美国 `us-central1` | 高 | §9 待你裁定：迁 ca 区 / 或 MVP 仅 sandbox 演示数据(不涉真实客户)暂留 us |
| ~~GCP 项目歧义~~（已确认） | — | GCP 项目 = `supply-491510`（用户 2026-07-09 确认，唯一正确） |
| 外部密钥未配置（Veryfi/Claude/Intuit） | 中 | Provider 抽象 + mock 兜底，密钥到位再切真实；不阻塞 P0/P1/P4 |
| QBO 生产审查 2–4 周 | 中 | 全程 sandbox 开发，并行提交审查 |
| Veryfi $500/月最低消费 | 低 | 开发用 100 份/月免费额度 |
| 加拿大税码（TxnTaxDetail/TaxCodeRef 按公司变） | 中 | MVP 跑不含税骨架，加拿大税作紧接的第一个增量 |
| Next 16 breaking changes | 中 | 写码前读 `node_modules/next/dist/docs/`（AGENTS.md 要求） |
| QBO refresh token 明文风险 | 高 | 加密存储，密钥仅服务端 |

---

## 8. 验收（对照 PRD §9 七条）

建客户+QBO授权 → 邮件/上传单据进队列 → 自动 OCR+分类、低置信置顶红 → 三栏改科目右栏实时更新+确认 → 一键录入 QBO sandbox 见 Bill+附件+DocNumber → 重复单标"疑似重复"不重复写 → 无/错 token 写接口 401、跨 firm 403/404。

---

## 9. 已确认决策（2026-07-08 拍板）

| 项 | 定论 |
|----|------|
| 数据库 | **Neon**（Postgres，连接串 `?sslmode=require`） |
| 部署 / 数据驻留 | 部署 GCP + **迁加拿大区**（如 `northamerica-northeast1`）满足 PIPEDA |
| 外部密钥 | **仅 Veryfi 真跑**（100 份/月免费额度）；**QBO、Claude 先 mock provider**，密钥到位再切 |
| 功能范围 | **就按 MVP 核心链**（收单→OCR→分类→复核→录入 QBO，单客户，schema 预留多租户）；砍审批/付款/多客户界面/报税 |

**GCP Project ID 已确认**：`supply-491510`（用户 2026-07-09 确认，唯一正确）。部署前仍需把 workflow 的 `REGION` 从 `us-central1` 改为加拿大区（PIPEDA）。

**需要用户提供的凭据（到对应阶段时索取）**：
- P0 前：Neon `DATABASE_URL`、`JWT_SECRET`（否则无法 `prisma migrate` 与登录联调）
- P2：Veryfi API 凭据
- P5：可继续用 mock；真跑再要 Intuit sandbox 凭据

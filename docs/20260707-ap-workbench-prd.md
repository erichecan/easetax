# AP 工作台 MVP — 产品需求文档（PRD）

> 日期：2026-07-07
> 范围锚：[20260707-ap-workbench-mvp-requirements.md](20260707-ap-workbench-mvp-requirements.md)（决策）+ [20260707-qbo-api-录入链验证.md](20260707-qbo-api-录入链验证.md)（录入链）
> 本 PRD 只覆盖 MVP 核心链：**收单 → OCR → 分类 → 复核 → 录入 QBO**（单客户跑通，数据模型预留多租户）。

---

## 一、概述与角色

**产品**：给会计师/记账公司的多客户 AP 工作台。会计师把客户发来的发票/收据，经 AI 识别 + 自动分类 + 人工复核，一键录入客户的 QuickBooks Online。

| 角色 | MVP 权限 |
|------|---------|
| 会计师（Accountant） | 登录、管客户、看单据队列、复核、录入 QBO、改分类规则 |
| 客户企业（Client） | MVP **不登录**，只是「一个 realmId + 一个收单邮箱」的数据实体 |
| 管理员（Admin） | 会计师的超集；MVP 可与 Accountant 合并，仅预留 role 字段 |

> 多租户：顶层是 **Firm（记账公司）**。MVP 界面只服务单个 Firm 下的单客户流程，但**所有查询强制带 `firmId` 做行级隔离**，schema 一步到位。

## 二、核心端到端流程

```
① 客户把发票 email 到 client 专属邮箱 / 会计师手动上传
      → 生成 Document(received)
② 后台调 Veryfi OCR → Extraction(供应商/日期/金额/税/行项目 + 置信度)
      → Document(ocr_done)
③ AI 分类：每个行项目映射 GL 科目（规则库命中 → 直接；否则 Claude）
      → 每行带 confidence: high/medium/low → Document(needs_review)
④ 会计师在复核工作台逐条确认/修正（低置信度必看）
      → Document(confirmed)；修正回写规则库
⑤ 一键录入：查/建 Vendor → 建 Bill → 挂原件附件 → 去重校验
      → Document(synced) + 存 qboBillId
```
异常旁支：`ocr_failed` / `duplicate_suspected` / `sync_failed` / `rejected`。

## 三、功能模块

### M1 收单入口
- **专属转发邮箱**：每个 Client 分配 `client-{id}@inbound.<域名>`；收到邮件 → 附件落库为 Document，来源 `email`。（技术：邮件入站服务如 SES/Postmark inbound webhook，需签名校验）
- **手动上传**：会计师在客户下拖拽上传 PDF/JPG/PNG/HEIC，来源 `upload`，支持批量。
- 校验：类型白名单、单文件 ≤ 20MB；重复文件（同 hash）提示。
- 字段：`id, clientId, firmId, source(email|upload), fileName, mimeType, storageKey, fileHash, status, createdAt`。

### M2 OCR 识别（Veryfi）
- 上传完成 → 异步调 Veryfi，落 `Extraction`。
- 提取：供应商名、发票号、账单日、到期日、货币、小计、税额(GST/HST)、总额、行项目[{描述,数量,单价,金额}]、整体与字段级置信度。
- 阈值低于设定 → 标 `low`，进人工。OCR 调用失败重试 3 次仍败 → `ocr_failed`。
- 字段：`id, documentId, rawJson, vendorName, invoiceNo, txnDate, dueDate, currency, subTotal, taxAmount, total, confidence`。

### M3 AI 分类（GL 科目映射）
- 输入：每个行项目（描述 + 金额 + 供应商）。
- 规则优先：命中 `ClassificationRule`（供应商/关键词 → 科目）直接给结果，`high`。
- 未命中：调 Claude，输入客户科目表（来自 QBO `SELECT * FROM Account`）+ 交易上下文 → 返回建议科目 + 理由 + 置信度。
- 分级：`high` 自动通过（仍可复核）/ `medium` AI 建议待确认 / `low` 必须人工。
- 学习：会计师修正 → upsert 一条 `ClassificationRule`，下次同类命中。

### M4 复核工作台（核心界面）
- **三栏**：左=原件预览（PDF/图片）｜中=OCR 结果 + 每行分类（可内联编辑金额/科目/税码）｜右=将写入 QBO 的 Bill 预览。
- 逐行显示：来源片段、识别值、建议科目、置信度色标；低置信度高亮置顶。
- 异常提示：金额超该供应商历史均值 3×、缺发票号、税额与总额不符。
- 操作：改任意字段（右栏实时更新）→「确认」→ 状态 `confirmed`；或「退回」`rejected`。
- 全部审计留痕（谁、何时、改了什么）。

### M5 录入 QuickBooks Online
- 前置：该 Client 已完成 QBO OAuth 连接（存 realmId + refresh token）。
- 步骤（见验证文档第 2 节）：查/建 Vendor → POST Bill（行=AccountBasedExpenseLineDetail）→ upload Attachable 挂原件 → 记 `qboBillId`。
- 去重：写入前系统指纹（供应商+发票号+金额+日期）+ QBO `SELECT Bill WHERE DocNumber` 二次校验；命中 → `duplicate_suspected` 交人工。
- 失败 → `sync_failed`，存错误信息，可重试。成功 → `synced`。

## 四、数据模型（Prisma 草案）

```prisma
model Firm     { id String @id @default(cuid()) name String users User[] clients Client[] }
model User     { id String @id @default(cuid()) firmId String email String @unique passwordHash String role String @default("accountant") }
model Client   { id String @id @default(cuid()) firmId String name String qboRealmId String? qboRefreshToken String? inboundEmail String @unique documents Document[] }
model Document { id String @id @default(cuid()) firmId String clientId String source String fileName String mimeType String storageKey String fileHash String status String @default("received") extraction Extraction? lines LineItem[] qboBillId String? createdAt DateTime @default(now()) }
model Extraction { id String @id @default(cuid()) documentId String @unique rawJson Json vendorName String? invoiceNo String? txnDate DateTime? dueDate DateTime? currency String? subTotal Decimal? taxAmount Decimal? total Decimal? confidence Float? }
model LineItem { id String @id @default(cuid()) documentId String description String amount Decimal glAccountId String? glAccountName String? taxCode String? confidence String @default("low") }  // high|medium|low
model ClassificationRule { id String @id @default(cuid()) firmId String clientId String? matchType String matchValue String glAccountId String glAccountName String createdAt DateTime @default(now()) }
model AuditLog { id String @id @default(cuid()) firmId String userId String documentId String? action String detail Json createdAt DateTime @default(now()) }
```
> ⚠️ 每张业务表都带 `firmId`；所有 db 查询强制 `where firmId = <当前用户firm>`，防跨租户越权。

## 五、单据状态机

```
received → ocr_processing → ocr_done → classifying → needs_review
  → (复核) confirmed → syncing_qbo → synced
旁支: ocr_failed | duplicate_suspected | sync_failed | rejected
```
每次跃迁写 AuditLog。

## 六、页面 / 路由清单

| 页面 | 路由 | 说明 |
|------|------|------|
| 登录 | `/login` | JWT |
| 客户列表 | `/clients` | 增客户、连 QBO |
| QBO 连接 | `/clients/:id/connect` | OAuth 授权跳转 |
| 单据队列 | `/clients/:id/documents` | 按状态筛选，看到「已上传 X / 待复核 Y / 已录入 Z」|
| 复核工作台 | `/documents/:id/review` | 三栏核心界面 |
| 收单邮箱设置 | `/clients/:id/settings` | 显示专属邮箱 |

## 七、API 路由清单（⛔ 写操作全鉴权 requireAuth + firm 隔离）

| 方法 | 路由 | 鉴权 |
|------|------|------|
| POST | `/api/auth/login` | 公开 |
| GET/POST | `/api/clients` | ✅ |
| GET | `/api/clients/:id/qbo/connect` → 302 到 Intuit | ✅ |
| GET | `/api/qbo/callback` | ✅（含 state 校验；路径固定不带 :id，Intuit 要求 redirect_uri 精确匹配登记值）|
| POST | `/api/documents/upload` | ✅ |
| POST | `/api/inbound/email` | 🔑 入站签名校验（非 JWT，webhook）|
| GET | `/api/documents?clientId=&status=` | ✅ |
| GET | `/api/documents/:id` | ✅ |
| POST | `/api/documents/:id/reprocess` | ✅ |
| PATCH | `/api/documents/:id/lines` | ✅ |
| POST | `/api/documents/:id/confirm` | ✅ |
| POST | `/api/documents/:id/sync-qbo` | ✅ |
| POST | `/api/rules` | ✅ |

## 八、非功能需求

- **合规**：客户数据 + 附件存加拿大区（AWS ca-central-1 / S3），满足 PIPEDA。
- **安全**：JWT；所有写操作 `requireAuth`；**每个查询带 firmId 做行级租户隔离**；Veryfi/QBO/Claude 密钥仅服务端；QBO refresh token 加密存储。
- **可靠**：OCR / QBO 调用失败重试 3 次 + 退避；QBO 429 尊重 Retry-After。
- **性能**：单据队列分页；OCR/分类异步（队列），不阻塞上传响应；避免复核页 N+1。

## 九、验收标准（对照 MVP）

1. 会计师能建客户并完成该客户 QBO sandbox 授权。
2. 邮件转发一张发票 / 手动上传一张收据 → 队列出现该单据。
3. 系统自动完成 OCR + 分类，低置信度行被标红置顶。
4. 会计师在三栏工作台改一个科目 → 右栏 Bill 预览实时更新 → 确认。
5. 一键录入后，在 QBO sandbox 能看到对应 Bill，且原件作为附件挂上、DocNumber 正确。
6. 同一张发票再传一次 → 被标「疑似重复」，不重复写入。
7. 无 token / 错 token 访问任一写接口 → 401；访问别的 firm 的单据 → 403/404。

## 十、明确不做 / 下一增量

- 本 PRD 不含：审批流、付款指令、多客户界面权限、T2 报税打通、人才基地工单、Xero、SharePoint 归档、多语种优化、加拿大税逻辑（先跑不含税骨架）。
- **紧接的第一个增量**：加拿大 GST/HST 税码（见验证文档第 3 节）→ 然后多客户工作台 → 审批+付款指令。

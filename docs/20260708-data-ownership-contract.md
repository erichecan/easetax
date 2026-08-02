# Easetax 易账 — 领域模型 + 数据所有权契约（SSOT）

> 日期：2026-07-08
> 状态：**实施前契约（必读、优先级高于任何单个模块）**
> 范围：AP 工作台 MVP 核心链（收单 → OCR → 分类 → 复核 → 录入 QBO），数据模型一步到位预留多租户 / 记账 / 报税。
> 关系：本文件是 [ap-workbench-prd.md](20260707-ap-workbench-prd.md) 的**数据契约层**。PRD 描述"做什么"，本文件裁定"每个事实归谁、存还是算、谁是权威"。**冲突以本文件为准。**

---

## 0. 这份文件是干什么的（怎么用）

"一个功能一个功能堆"出来的系统，最贵的债不是 bug，而是**数据所有权混乱**：同一业务事实被存进多个地方，各处自洽却彼此矛盾。程序不报错、DB 不报错，但列表对不上、状态机没法调试、端到端跑不通。

本项目**在只有 demo、还没写后端的阶段就已经在漂**（见 §5 证据）。本契约的作用是把"所有权"钉死在写模块之前，让任何模块都**无法自造字段 / 状态 / id 体系**。

**使用规则（写进团队约定）：**
1. 任何模块、任何 PR 新增或修改一个业务字段/状态/枚举前，**先改本契约**，再改代码。
2. 每个字段必须落到且只落到 §3 四分类中的一类。
3. Reviewer 对照本契约审：有没有第二个 canonical？cache 有没有回填？能算的有没有被存？

---

## 1. 核心原则

对每个业务事实机械回答四问：**谁写它？谁读它？它是存的还是算的？谁是权威？**
凡是答案出现"多个写入点 / 多处都声称权威"，就是病灶。

**四分类：**
- **canonical（权威）** — 该事实唯一真相来源。✅
- **derived / 快照** — 从别处算出，或下单时冻结（须标注：派生自谁、何时冻结、是否刷新）。
- **cache（冗余副本）** — 另一 canonical 的拷贝，有不同步风险。⚠️ 病灶高发。
- **dead（死字段）** — 无人读或无人写。🗑️

**病灶判据：** (a) 同一事实多个 canonical 互不回写；(b) cache 无回填机制（写少读多是强信号）。

---

## 2. 全局裁定（先立规矩，后面所有表都服从）

| # | 事项 | 裁定 | 理由 |
|---|------|------|------|
| G1 | **金额类型** | 全链 `Decimal`（Prisma `Decimal` / DB `numeric`）。禁止 JS `number` 参与金额运算。前端展示层才转字符串。 | 财务产品，float 舍入不可接受。demo 的 `number` + `Math.round(*100)/100` 不得进真实代码。 |
| G2 | **GL 科目 id** | canonical = **QBO `Account.Id`**（远程不透明 Id，如 "7"）。**不自造 "6000" 科目代码体系。** | 建 Bill 时 `AccountRef.value` 就是 QBO Id；自造 id 会在录入时撞阻抗失配。 |
| G3 | **单据状态枚举** | 全系统唯一一套 `DocStatus`（见 §4.1），前端只读、不得自定义子集。 | demo 已存在第二套状态词汇（§5.1），必须收口。 |
| G4 | **能算的绝不存** | `Client` 统计数、对账匹配、`Document.confidence` 汇总一律**派生**（查询/计算）。若为性能要物化，必须声明重算触发点，且视为 cache。 | demo 的 `Client.stats` 已经和真实单据对不上（§5.3）。 |
| G5 | **QBO 为跨系统权威** | 一旦单据 `synced`，该账单的权威转移到 **QBO Bill**；本地 `Document` 转只读快照，靠 `qboBillId` 回查。 | 会计师会在 QBO 里改账，本地副本不能再声称权威。 |
| G6 | **税额权威** | 我方计算的税/总额 = **预览估算（derived，非权威）**；QBO 落账后以 QBO 税额为准。 | 两边都算会因舍入不一致，预览 total ≠ QBO total。 |
| G7 | **共享类型单一来源** | `DocStatus / Confidence / 税码 / 科目 id` 只允许从 `packages/domain`（或 Prisma 生成类型）导入。`apps/web/src/lib/types.ts` 改为 re-export，不得平行定义。 | 前端已在用自己的枚举，这是漏洞入口。 |
| G8 | **每查询强制带 `firmId`** | 所有业务表带 `firmId`，所有查询 `where firmId = 当前用户firm`（行级租户隔离）。 | 沿用 PRD 要求，防跨租户越权。 |
| G9 | **QBO 对象形态由付款状态决定**（2026-08-02 追加） | **已付**（收据/刷卡/现金）→ QBO **Purchase/Expense**，直接冲银行或信用卡；**未付**（有账期的发票）→ QBO **Bill** 挂 AP。付款状态 canonical 落 `Document.settlement`，OCR 给初值、会计师可改。 | 一律记 Bill 会凭空虚增应付账款、银行对不上；这是竞品 Dext "Publish to" 的核心分叉。见 [业务流程设计 §2.5](20260802-业务流程设计.md)。 |
| G10 | **税码不由 AI 裁定**（2026-08-02 追加） | `LineItem.taxCode` 只能来自**确定性税码规则表**（§4.8）。AI 只负责**抽取**（税额、供应商 GST/HST 号、省份）与**科目建议**，不产出税码。规则表未命中 → 留空 + 强制人工，**不允许猜**。 | 科目记错可改可学，税码记错是税务风险（ITC 多抵/漏抵）；且加拿大税规则本身是确定的，没有推断的必要。 |

---

## 3. Canonical 领域模型（唯一模型来源）

> 这份 Prisma schema 是**唯一模型来源**：先落成真 schema，demo 反过来依赖它。相比 PRD 草案做了 6 处修正（标 ✎）。

```prisma
// ---- 租户 / 主体 ----
model Firm    { id String @id @default(cuid()) name String
                users User[] clients Client[] }

model User    { id String @id @default(cuid()) firmId String
                email String @unique passwordHash String
                role String @default("accountant") }   // accountant|admin

model Client  { id String @id @default(cuid()) firmId String name String industry String?
                qboRealmId String?              // 空 = 未连 QBO（一等状态，见 §4.2）
                qboRefreshToken String?         // 加密存储
                inboundEmail String @unique     // ✎ 存储值，派生规则钉死见 §4.3；不再"随手拼"
                documents Document[] }

// ---- 单据主链 ----
model Document {
  id String @id @default(cuid())
  firmId String  clientId String
  source String                    // email|upload
  fileName String  mimeType String // ✎ 用 mimeType，删除 demo 的 fileKind
  storageKey String  fileHash String
  status String @default("received")   // DocStatus 枚举，§4.1
  qboBillId String?                     // 录入成功后回填；synced 后靠它回查（G5）
  createdAt DateTime @default(now())
  extraction Extraction?   lines LineItem[]
  @@unique([firmId, fileHash])          // ✎ 收单去重（同 firm 同文件）
}

model Extraction {                       // ✎ 与 Document 分表：OCR 事实独立
  id String @id @default(cuid())  documentId String @unique
  rawJson Json
  vendorName String?  invoiceNo String?
  txnDate DateTime?  dueDate DateTime?  currency String?
  subTotal Decimal?  taxAmount Decimal?  total Decimal?   // ✎ Decimal；taxAmount 不叫 tax
  fieldConfidence Json?               // 各字段级置信度（OCR 原始）
}

model LineItem {
  id String @id @default(cuid())  documentId String
  description String  amount Decimal          // ✎ Decimal
  glAccountId String?                          // = QBO Account.Id（G2），非本地代码
  glAccountName String?                        // derived 快照：下单时冻结的 QBO 科目名（§4.4）
  taxCode String?                              // = QBO TaxCode.Id（按公司），非 "免税" 显示串
  confidence String @default("low")            // Confidence 枚举
}

// ---- 分类规则 / 学习 ----
model ClassificationRule {
  id String @id @default(cuid())  firmId String  clientId String?
  matchType String  matchValue String          // vendor|keyword → 值
  glAccountId String                            // = QBO Account.Id
  glAccountName String                          // derived 快照
  createdAt DateTime @default(now())
}

// ---- 科目缓存（QBO 为权威，本地为同步副本）----
model GlAccountCache {                  // ✎ 明确命名为 Cache，不叫 GlAccount
  id String @id @default(cuid())  clientId String
  qboAccountId String                   // canonical id（G2）
  name String  accountType String  accountSubType String?
  gifiCode String?                      // ✎ GIFI 挂在科目上（§4.5），报税期派生，不另起规则表
  syncedAt DateTime @default(now())     // cache 回填时点（G4）
  @@unique([clientId, qboAccountId])
}

// ---- 银行流水 / 对账 ----
model BankTxn {                         // ✎ 对账"人工关联"要有落地处
  id String @id @default(cuid())  firmId String  clientId String
  date DateTime  description String  amount Decimal
  matchedDocumentId String?            // canonical：人工/自动确认的关联（§4.6）
  matchStatus String @default("unmatched")  // unmatched|auto|manual|ignored
}

// ---- 审计 ----
model AuditLog {
  id String @id @default(cuid())  firmId String  userId String
  documentId String?  action String  detail Json  createdAt DateTime @default(now())
}
```

---

## 4. 关键裁定细则

### 4.1 唯一的单据状态机 `DocStatus`

```
received → ocr_processing → ocr_done → classifying → needs_review
   → confirmed → syncing_qbo → synced
旁支（终态/待处理）: ocr_failed | duplicate_suspected | sync_failed | rejected
```

- 这是**唯一**合法枚举。删除 demo 的 `processing / syncing / duplicate / failed` 四个别名。
- 每次跃迁写 `AuditLog`。**非法转移抛错**（如 `received → synced` 不允许）。
- `duplicate_suspected` / `sync_failed` 可人工/重试回到主链；`ocr_failed`、`rejected` 为待人工终态。
- **重跑（reprocess）边：`needs_review → ocr_processing`**（2026-08-02 追加）。用途：OCR/分类能力升级后，存量单据不重传即可重跑。重跑**销毁并重建** `Extraction` + `LineItem`（它们的权威是最近一次识别，非累积），因此：
  - `confirmed` 及之后**不可**重跑（人工分类结果已是权威，要重跑先退回 `needs_review`）；`synced` 后 QBO 权威（G5），永不重跑。
  - `ocr_failed → ocr_processing` 早已允许（失败重试），语义相同，走同一条代码路径。

### 4.2 "客户未连 QBO" 是一等状态

`Client.qboRealmId == null` 时：单据可走到 `confirmed`，但 `syncing_qbo` 前置校验失败 → 停在 `confirmed`，UI 提示"先连 QBO"。**不允许**在未连状态下产生 `synced`。

### 4.3 `inboundEmail` 派生规则钉死

格式：`client-{clientId}@inbound.easetax.ca`，**clientId 原样，保留连字符**。
（demo 里 id=`c-01` 却生成 `client-c01@`，少连字符——此类"随手拼"禁止。）
存储值以本规则一次生成后固定；改 id 不改 email（email 是对外地址，稳定性优先）。

### 4.4 `glAccountName` / `taxCode` 的定位

- `LineItem.glAccountName`、`ClassificationRule.glAccountName` = **derived 快照**：录入当时冻结的 QBO 科目名，用于审计/展示。**权威名在 `GlAccountCache.name`（其权威又是 QBO）。** 科目改名不回改历史行（快照语义），但新分类读 cache 最新值。
- `taxCode` = QBO `TaxCode.Id`（`SELECT * FROM TaxCode` 拉取，按公司不同）。**不存 "HST 13%"/"免税" 这类显示串**；显示串是前端按 code 查出来的 derived。

### 4.5 GIFI 是科目属性，不是第二套规则系统

报税期（T2）需要的 GIFI 映射，挂在 `GlAccountCache.gifiCode` 上。**分类规则永远单源**（`ClassificationRule` → GL 科目 id），GIFI 由"科目→gifiCode"派生。禁止新起一张"GL↔GIFI 规则表"造成两套规则库。

### 4.6 对账匹配的落地

- **自动匹配**（金额一致 + 日期 ±N 天 + 供应商命中）是 derived，实时算，可不物化。
- **人工确认/否决**是 canonical，落 `BankTxn.matchedDocumentId` + `matchStatus`。
- 注意：真实银行金额常 ≠ 发票 total（税舍入、合并付款、部分付款、汇率）。匹配用**容差 + 人工兜底**，不假设精确相等。

### 4.7 `confidence` 汇总规则（rollup）

- 行级 `LineItem.confidence`：M3 分类写。
- 字段级 `Extraction.fieldConfidence`：M2 OCR 写。
- **文档级 confidence = derived**：`worst(OCR 字段置信, 所有行分类置信)`，任一变更即重算。**不物化在 Document 上**（避免 M2/M3 各写各的漂移）。

### 4.8 税码规则表（2026-08-02 追加，落实 G10）

**输入三元组 →（省份, 科目类别, 供应商是否 GST/HST 登记）→ 输出 QBO `TaxCode.Id`**。规则表是 canonical，AI 不参与。

- **税码表本身来自 QBO**：`SELECT * FROM TaxCode`，随客户/省份不同，与 `GlAccountCache` 同属"QBO 权威、本地 cache"（§4.5 同款语义），落 `TaxCodeCache`。
- **餐饮招待 50%**：加拿大只有一半 GST/HST 可抵 ITC。QBO Canada 的落地方式是 **group rate**（一条 liability 半额走 ITC + 一条 expense 半额计入费用）。**由科目触发，不由 AI 判断**：科目类别 = 餐饮招待 → 强制使用该客户配置的 M&E group rate。
- **PST / QST 不可抵扣**：只有 GST/HST 部分进 ITC，PST 计入费用成本。省份决定是否存在 PST。
- **供应商未登记 GST/HST**：不得给可抵扣税码，税额并入费用。
- **未命中**：`taxCode` 留空 + 该行强制人工，**禁止兜底猜一个**。

### 4.9 CRA 抵扣凭证等级（derived，不物化）

依 CRA《Input Tax Credit Information (GST/HST) Regulations》，凭证要件按金额分三档。**由 `Extraction` 已抽字段实时算**（G4「能算的绝不存」）：

| 票面总额 | 必需字段 |
|---|---|
| < $30 | 供应商名、日期、总额 |
| $30 – $150 | 上述 + **供应商 GST/HST 登记号** + 税额或含税声明 |
| ≥ $150 | 上述 + **购方名称**、付款条款、每项供应的描述 |

- 产出 `itcEligibility: ok | incomplete`（+ 缺失字段列表），驱动复核队列排序与「不可抵扣清单」。
- 为此 `Extraction` 需新增抽取字段：`supplierTaxNumber`、`recipientName`、`paymentTerms`。
- ⚠️ 这是**风险信号，不是拦截器**：凭证不达标照样可以入账（费用照记），只是这笔 **ITC 不能抵**，必须显式告知会计师。

### 4.10 绿色通道（自动过账）的准入条件（2026-08-02 追加）

全部满足才允许 `needs_review` 直接走到录入，**任一不满足即进人工复核**：

1. 命中该客户的**供应商规则**，且该规则 `confirmedCount ≥ 3`（人工确认过至少 3 次）
2. 所有行 `confidence = high`
3. `itcEligibility = ok`（§4.9）
4. `Extraction.total ≤ Client.autoPostThreshold`（默认 CAD 200）
5. 非 `duplicate_suspected`
6. 所有行 `taxCode` 由规则表命中（§4.8），非空

自动过账**不新增状态**：仍走 `confirmed → syncing_qbo → synced`，但 `AuditLog.userId = "system"`、`action = "auto_confirm"`，并进「已自动过账」抽查列表。会计师可随时关闭该客户的绿色通道（`Client.autoPostEnabled`）。

### 4.12 追票工单：只存「催过没有」，不存「解决了没有」（2026-08-02 追加）

对账缺收据 → 向客户追票。按 G4「能算的绝不存」拆开两件事：

- **canonical**：`ChaseNotice`（催票记录）—— 何时、通过什么渠道、催了谁、内容是什么。这是发生过的事实，只能记录。
- **derived**：工单是否「已解决」= 该 `BankTxn` 现在是否已匹配到单据（§4.6 实时算）。**不存 resolved 状态**，否则补票后两处会不一致。
- 「无需收据」不进工单体系，仍走 `BankTxn.matchStatus = "ignored"`（唯一 canonical），有 ignored 就不再催。

| 表 | 字段 | 语义 |
|---|---|---|
| 新表 `ChaseNotice` | `firmId`、`clientId`、`bankTxnId`、`channel`、`recipient`、`subject`、`body`、`sentAt`、`sentBy` | 一笔流水可有多条（催了 N 次）；`sentAt` 为空表示只生成未发送 |

### 4.11 因上述裁定新增的字段（schema 增量）

| 表 | 字段 | 语义 |
|---|---|---|
| `Document` | `settlement String?` | `paid \| unpaid`，canonical（G9）。OCR 给初值，会计师可改；决定录 Expense 还是 Bill |
| `Extraction` | `supplierTaxNumber String?`、`recipientName String?`、`paymentTerms String?` | CRA 凭证要件（§4.9） |
| `ClassificationRule` | `confirmedCount Int @default(0)` | 人工确认次数，绿色通道条件 1 |
| `Client` | `province String?`、`autoPostEnabled Boolean @default(false)`、`autoPostThreshold Decimal?`、`taxNumber String?`、`qboPaymentAccountId String?` | 税码规则输入 + 绿色通道配置 + 购方 GST 号 + 已付单据冲账的银行/信用卡账户（QBO Purchase 必填，缺则已付单据无法录入） |
| `Document` | `qboEntity String?` | 实际录入的 QBO 对象类型（`Bill`\|`Purchase`），与 `qboBillId` 一起构成回查坐标（G5/G9） |
| `TaxCodeCache` | `semanticKey String?` | 规则表输出（`TaxTreatment`）→ 该客户实际税码的桥；换省份只换这张表 |
| 新表 `TaxCodeCache` | `clientId`、`qboTaxCodeId`、`name`、`rate`、`isGroup`、`syncedAt` | QBO 权威、本地 cache（同 `GlAccountCache`） |

---

## 5. 附录：已发生漂移的证据（demo vs 本契约）

保留作为"为什么需要这份契约"的实证，也是首批要消除的副本。

### 5.1 状态机分叉
[types.ts:3](../apps/web/src/lib/types.ts) 定义 `processing/syncing/duplicate/failed`，与 PRD/§4.1 的 `ocr_processing/classifying/syncing_qbo/duplicate_suspected/ocr_failed/sync_failed` 是两套词汇。→ **删 demo 那套。**

### 5.2 字段名/结构漂移
demo `DocumentRec` 把 OCR 事实压平进单对象，用 `vendor`（vs `vendorName`）、`tax`（vs `taxAmount`）、多出 `taxLabel`、`fileKind`（vs `mimeType`）。→ **按 §3 拆 Document/Extraction，统一命名。**

### 5.3 `Client.stats` 是对不上的手写缓存
[mock.ts:26](../apps/web/src/lib/mock.ts) c-01 `stats.synced=28`，但真实 documents 里 c-01 仅 2 张 synced。→ **stats 改为派生查询（G4）。**

### 5.4 科目 id 自造体系
[mock.ts:5](../apps/web/src/lib/mock.ts) `GlAccount.id="6000"`（科目代码），QBO 建 Bill 要的是 `Account.Id`。→ **改用 QBO Id（G2）。**

### 5.5 税双层双词汇
doc 级 `taxLabel` + 行级 `taxCode`，"免税" 既作 label 又作 code 的魔法串。→ **税码统一 QBO TaxCode.Id（§4.4）。**

---

## 6. 消除漂移的执行顺序（Strangler：先统一读 → 回填 → 停写副本 → 删死字段）

| 步 | 动作 | 风险 |
|----|------|------|
| 1 | 建 `packages/domain`（或 Prisma 生成类型），落 §4.1 `DocStatus`、`Confidence` 等唯一枚举 | 低（新增） |
| 2 | `apps/web/src/lib/types.ts` 改为从 domain re-export；删除平行定义的枚举/类型 | 低 |
| 3 | 把 §3 schema 落成真 Prisma migration；`GlAccountCache` 用 QBO Id | 低（新增） |
| 4 | `Client.stats`、对账匹配、doc.confidence 改为派生（删存储字段/mock 常量） | 中：影响队列页/客户页读取点 |
| 5 | 金额类型全链换 `Decimal`；删 `number` 计税 | 中 |
| 6 | 状态机显式化：跃迁函数校验合法转移，非法抛错 + 写 AuditLog | 中 |
| 7 | 不变量入 CI（接 `validating-data-integrity`）：如 `Σ LineItem.amount (+税) == Extraction.total`、`stats == count(status)` | 低 |
| 8 | E2E 真实 API 驱动跑通（接 `testing-end-to-end-experience`）：验证各列表同源一致 | — |

---

## 7. 前瞻裁定（未来阶段不许再分叉）

| 未来事实 | 现在就定的 canonical | 说明 |
|---------|---------------------|------|
| GIFI 映射 | `GlAccountCache.gifiCode` | 报税期派生，不新起规则表（§4.5） |
| GL 科目（记账 vs 报税双用） | QBO Account | 一条交易一次分类，GL 用于录入、GIFI 派生用于报税，共享同一分类结果 |
| 付款指令（不碰钱） | 未来 `PaymentInstruction` 表，引用 `qboBillId` | 只生成指令/批次，实际转账在客户网银；权威仍是 QBO Bill 的付款状态 |
| 审批 | 未来 `Approval` 表，引用 documentId | 两级：会计师复核（已在状态机）+ 老板授权付款（新增），不塞进 DocStatus |
| 多客户/多租户 | `firmId` 行级隔离（已就位） | schema 已一步到位，界面后叠 |

---

**底线**：别靠肉眼比对各列表猜哪儿不一致——对每个字段机械列出谁写谁读、是存的还是算的；凡多处可写同一事实，就是病灶。这份契约就是防"各自为政"的锚，改字段先改它。

# Seed 数据加厚 — 任务台账

> 日期：2026-08-03　背景：演示数据太薄（1 客户 / 8 单据 / 1 规则 / confirmedCount 全 0），
> 导致「越用越准」「绿色通道」「凭证风险排序」三个核心卖点在 demo 里看不见。
>
> 方法论：**不往表里塞行，而是重放业务事件**——让 seed 走真实的
> `ingestDocument → processDocument → confirmDocument → syncDocumentToQbo`，
> 数据是系统真跑出来的副产品，状态是流到哪一段的结果而非随机标签。

## 前置事实（已核对）

- `setOcrProvider()` / `setQboProvider()` / `setStorageProvider()` 三个注入钩子都已存在
- `MockQboProvider` 已存在 → seed 绝不碰真实 Intuit 沙箱
- `vendor-seed.ts` 已有加拿大商户表 → seed 用表里的真实商户名，分类才会真命中
- confirm 的学习飞轮逻辑目前**耦合在 HTTP 路由里**（`api/documents/[id]/confirm/route.ts`），
  seed 无法复用 → 必须先抽出（S1）
- `MIN_RULE_CONFIRMATIONS = 3`，绿色通道是**七条与门**（`domain/auto-post.ts`）
- 上传白名单：pdf/jpeg/png/heic，≤20MB

---

## 任务

- [x] S1 抽出 confirm 学习飞轮到 `src/lib/pipeline/confirm.ts`
      验收：HTTP 路由变成薄壳（只做鉴权+参数解析），行为不变；
            `confirmedCount` 累加/清零语义与原实现逐行一致；
            现有 90 项单测仍全绿
      产出：`src/lib/pipeline/confirm.ts`、`src/app/api/documents/[id]/confirm/route.ts`
      依赖：无

- [ ] S2 seed 改成事件重放式
      验收：3 个客户（牙科 ON / 餐厅 ON / 建筑 BC）各有稳定供应商画像；
            单据时间铺在过去 10 周而非全是今天；
            五段每段都有货 + 四类异常都有货（见下方目标分布）；
            `confirmedCount` 呈梯度（头部供应商 ≥3 已达门槛，长尾 1–2 次还差）；
            绿色通道抽查页非空；
            重跑幂等（不翻倍）
      产出：`prisma/seed.ts`、`prisma/seed/*.ts`
      依赖：S1

- [ ] S3 不变量断言 + 端到端验证
      验收：seed 末尾断言（单据 total == Σ 行项金额、synced 单必有 qboBillId、
            confirmed 之后的单必有全部行税码）；
            `npm run build` / `npx tsc --noEmit`（单独看 $?）/ `npm test` 全绿；
            浏览器实测：工作台五段有数、复核队列有货、规则页有梯度、抽查页非空
      产出：本台账回写
      依赖：S2

### 目标分布（S2 验收依据）

| 段 / 状态 | 目标数量 | 为什么要有 |
|---|---|---|
| ① received | 3 | 刚进来还没跑 |
| ② ocr_processing | 2 | 机器正在跑，演示"实时感" |
| ③ classifying | 1 | 同上 |
| ④ needs_review | 12–15 | **主战场**，复核队列的排序演示靠它 |
| ⑤ confirmed | 3 | 确认了还没录 QBO |
| 终 synced | ~30 | 已完成，绿色通道抽查从这里出 |
| 异常 ocr_failed | 2 | 演示重跑按钮 |
| 异常 duplicate_suspected | 1 | 演示去重人工裁决 |
| 异常 rejected | 2 | 演示退回流程 |
| 异常 sync_failed | 1 | 演示 QBO 录入失败重试 |

---

## 周期日志

> 每完成一条追加一行。没有行 = 没有完成。

| 周期 | 任务 | 结果 | commit |
|---|---|---|---|
| 1 | S1 抽出 confirm 飞轮 | 完成。顺手发现 batch-confirm 路由里有第二份飞轮副本，一并合并（少 30 行重复）。tsc 0 / eslint 0 / 90 测试全绿 | — |

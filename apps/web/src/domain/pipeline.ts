// 业务流程五段 —— 界面编排的唯一来源（docs/20260802-业务流程设计.md §2.2）。
// 12 个 DocStatus 是内部实现，会计师只需要理解 5 段 + 1 条异常旁支。
// 竞品同款做法：Light 把 15 个 bill 状态映射成 5 个对外 tab；我们把 12 个映射成 5 段。
import type { DocStatus } from "./doc-status";

export const STAGES = ["intake", "extract", "classify", "review", "post"] as const;
export type Stage = (typeof STAGES)[number];

export type StageMeta = {
  key: Stage;
  index: number;
  label: string;
  /** 这一段谁在干活：机器自动跑完，还是等人动手 */
  actor: "auto" | "human";
  /** 一句话说清这段发生了什么 —— 演示时不用旁白 */
  blurb: string;
  statuses: DocStatus[];
};

export const STAGE_META: Record<Stage, StageMeta> = {
  intake: {
    key: "intake",
    index: 1,
    label: "收单",
    actor: "auto",
    blurb: "邮箱转发或上传进来，按文件指纹去重",
    statuses: ["received"],
  },
  extract: {
    key: "extract",
    index: 2,
    label: "识别",
    actor: "auto",
    blurb: "OCR 抽出金额、行项目，以及 CRA 抵扣要件",
    statuses: ["ocr_processing", "ocr_done"],
  },
  classify: {
    key: "classify",
    index: 3,
    label: "定科目税码",
    actor: "auto",
    blurb: "规则优先、AI 兜底定科目；税码走确定性规则表",
    statuses: ["classifying"],
  },
  review: {
    key: "review",
    index: 4,
    label: "复核",
    actor: "human",
    blurb: "凭证风险与低置信度置顶，确认后学成供应商规则",
    statuses: ["needs_review"],
  },
  post: {
    key: "post",
    index: 5,
    label: "录入 QBO",
    actor: "human",
    blurb: "未付建 Bill、已付建 Purchase，原件作附件挂上",
    statuses: ["confirmed", "syncing_qbo"],
  },
};

// 旁支：不在主链上，但必须有人处理，否则单据永远走不完。
export const EXCEPTION_STATUSES: DocStatus[] = [
  "ocr_failed",
  "sync_failed",
  "duplicate_suspected",
  "rejected",
];

// 终点：已录入 QBO，QBO 成为权威（契约 G5），本地只读。
export const DONE_STATUSES: DocStatus[] = ["synced"];

const STATUS_TO_STAGE = new Map<DocStatus, Stage>(
  STAGES.flatMap((s) => STAGE_META[s].statuses.map((st) => [st, s] as const)),
);

/** 单据当前停在哪一段；异常与已完成返回 null（它们不在主链上排队）。 */
export function stageOf(status: DocStatus): Stage | null {
  return STATUS_TO_STAGE.get(status) ?? null;
}

export function isException(status: DocStatus): boolean {
  return EXCEPTION_STATUSES.includes(status);
}

export function isDone(status: DocStatus): boolean {
  return DONE_STATUSES.includes(status);
}

export type StageCounts = Record<Stage, number>;

export type PipelineSummary = {
  counts: StageCounts;
  exceptions: number;
  done: number;
  /** 积压最多的人工段 —— 界面上标「堵在这」，没有积压时为 null */
  bottleneck: Stage | null;
};

export function summarizePipeline(statuses: DocStatus[]): PipelineSummary {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as StageCounts;
  let exceptions = 0;
  let done = 0;

  for (const st of statuses) {
    const stage = stageOf(st);
    if (stage) counts[stage] += 1;
    else if (isDone(st)) done += 1;
    else if (isException(st)) exceptions += 1;
  }

  // 只在需要人动手的段上标堵点：机器段的积压是暂时的，会自己流走。
  const humanStages = STAGES.filter((s) => STAGE_META[s].actor === "human");
  const worst = humanStages.reduce<Stage | null>(
    (acc, s) => (counts[s] > 0 && (!acc || counts[s] > counts[acc]) ? s : acc),
    null,
  );

  return { counts, exceptions, done, bottleneck: worst };
}

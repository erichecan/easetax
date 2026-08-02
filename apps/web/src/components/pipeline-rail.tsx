"use client";

import { STAGES, STAGE_META, type PipelineSummary, type Stage } from "@/domain";

// 段色 = 地铁线路色：标「这是第几段」，不标好坏。走蓝→青→绿→金→赤陶这条冷暖路径，
// 推进感由色相本身承担。警示红不进这组（留给 conf-low），完成绿也不进（留给「已录入」）。
// band 亮版用于色带与量条，chip 深版用于序号圆（白字 ≥4.5:1，浏览器实测过）。
export const STAGE_TONE: Record<Stage, { band: string; chip: string; num: string }> = {
  intake: { band: "bg-stage-1", chip: "bg-stage-1-deep text-white", num: "text-stage-1-deep" },
  extract: { band: "bg-stage-2", chip: "bg-stage-2-deep text-white", num: "text-stage-2-deep" },
  classify: { band: "bg-stage-3", chip: "bg-stage-3-deep text-white", num: "text-stage-3-deep" },
  review: { band: "bg-stage-4", chip: "bg-stage-4-deep text-white", num: "text-stage-4-deep" },
  post: { band: "bg-stage-5", chip: "bg-stage-5-deep text-white", num: "text-stage-5-deep" },
};

// 五段流程轨道。刻意不做成五张卡片（那是通用 AI 布局的味道）——
// 用一条连续分段轨道 + 底部量条表达「哪一段在堆积」，一眼看出堵点。
// 色彩角色固定：暖金 = 需要你动手，绿 = 已流过，灰 = 机器在跑。
export function PipelineRail({
  summary,
  active,
  onSelect,
}: {
  summary: PipelineSummary;
  active?: Stage | "exception" | "done" | null;
  onSelect?: (stage: Stage | "exception" | "done" | null) => void;
}) {
  const max = Math.max(1, ...STAGES.map((s) => summary.counts[s]));

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
        {STAGES.map((stage) => {
          const meta = STAGE_META[stage];
          const count = summary.counts[stage];
          const isBottleneck = summary.bottleneck === stage;
          const isActive = active === stage;
          const human = meta.actor === "human";

          const tone = STAGE_TONE[stage];

          return (
            <button
              key={stage}
              onClick={() => onSelect?.(isActive ? null : stage)}
              className={`group relative border-b border-line px-4 pb-3 pt-5 text-left transition-colors last:border-b-0 lg:border-b-0 ${
                isActive ? "bg-paper" : "hover:bg-paper/60"
              }`}
            >
              {/* 段色带：段与段的第一层区隔，颜色即流程位置；选中时加粗 */}
              <span
                className={`absolute inset-x-0 top-0 transition-all ${tone.band} ${isActive ? "h-[9px]" : "h-[6px]"}`}
              />

              <div className="flex items-baseline gap-1.5">
                <span
                  className={`tnum grid size-[18px] shrink-0 place-items-center rounded-full text-[10px] font-bold ${tone.chip}`}
                >
                  {meta.index}
                </span>
                <span className="text-[13px] font-medium text-ink-900">{meta.label}</span>
                {human && (
                  <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-gold-700">
                    需人工
                  </span>
                )}
              </div>

              <div className="mt-1.5 flex items-end gap-1.5">
                <span
                  className={`tnum font-display text-2xl font-bold leading-none ${
                    count === 0 ? "text-faint" : tone.num
                  }`}
                >
                  {count}
                </span>
                <span className="pb-0.5 text-[11px] text-faint">张</span>
              </div>

              {/* 量条：宽度按该段占比，让积压差距成为可见的形状而不是要读数字 */}
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-line/70">
                <div
                  className={`h-full rounded-full transition-all ${count === 0 ? "bg-transparent" : tone.band}`}
                  style={{ width: `${Math.round((count / max) * 100)}%` }}
                />
              </div>

              <p className="mt-2 text-[11px] leading-snug text-faint">{meta.blurb}</p>

              {/* 堵点标记要在金色段上也能跳出来，所以用实心胶囊而非同色文字 */}
              {isBottleneck && count > 0 && (
                <span className="mt-2 inline-block rounded-full bg-gold-600 px-2 py-0.5 text-[10px] font-bold text-white">
                  堵在这一步
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line px-4 py-2.5 text-[11px]">
        <button
          onClick={() => onSelect?.(active === "done" ? null : "done")}
          className={`flex items-center gap-1.5 transition-colors ${
            active === "done" ? "font-semibold text-conf-high" : "text-muted hover:text-ink-900"
          }`}
        >
          <span className="size-1.5 rounded-full bg-conf-high" />
          已录入 QBO <span className="tnum font-medium">{summary.done}</span> 张
        </button>
        <button
          onClick={() => onSelect?.(active === "exception" ? null : "exception")}
          className={`flex items-center gap-1.5 transition-colors ${
            active === "exception" ? "font-semibold text-conf-low" : "text-muted hover:text-ink-900"
          }`}
        >
          <span className={`size-1.5 rounded-full ${summary.exceptions ? "bg-conf-low" : "bg-line-strong"}`} />
          异常待处理 <span className="tnum font-medium">{summary.exceptions}</span> 张
        </button>
        {active && (
          <button onClick={() => onSelect?.(null)} className="ml-auto text-faint hover:text-ink-900">
            清除筛选
          </button>
        )}
      </div>
    </div>
  );
}

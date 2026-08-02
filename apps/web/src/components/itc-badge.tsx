import { ITC_REQUIREMENT_LABELS, type ItcCheck } from "@/domain";

const TIER_LABEL: Record<string, string> = {
  under_30: "< $30",
  under_150: "$30–150",
  over_150: "≥ $150",
};

export function itcMissingText(itc: ItcCheck): string {
  return itc.missing.map((m) => ITC_REQUIREMENT_LABELS[m]).join("、");
}

// CRA 抵扣凭证等级徽章（契约 §4.9）。风险信号，不阻断入账。
export function ItcBadge({ itc, showTier }: { itc: ItcCheck; showTier?: boolean }) {
  const tier = showTier && itc.tier ? ` · ${TIER_LABEL[itc.tier]}` : "";

  if (itc.status === "ok") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-conf-high-bg px-2.5 py-0.5 text-[11px] font-medium text-conf-high">
        <span className="size-1.5 rounded-full bg-conf-high" />
        齐全{tier}
      </span>
    );
  }
  if (itc.status === "not_applicable") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-0.5 text-[11px] font-medium text-faint">
        <span className="size-1.5 rounded-full bg-faint" />
        免税·无 ITC
      </span>
    );
  }
  if (itc.status === "unknown") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-conf-med-bg px-2.5 py-0.5 text-[11px] font-medium text-conf-med">
        <span className="size-1.5 rounded-full bg-conf-med" />
        总额待确认
      </span>
    );
  }
  return (
    <span
      title={`ITC 抵扣缺件：${itcMissingText(itc)}`}
      className="inline-flex items-center gap-1.5 rounded-full bg-conf-low-bg px-2.5 py-0.5 text-[11px] font-medium text-conf-low"
    >
      <span className="size-1.5 rounded-full bg-conf-low" />
      缺 {itc.missing.length} 项{tier}
    </span>
  );
}

// P3 分类抽象。规则优先命中，未命中走 Classifier（Claude，有 key）或 mock。
import type { Confidence } from "@/domain";
import type { DecimalString } from "./ocr";

// 候选科目集 = 客户科目表（来自 GlAccountCache / QBO Account）。id 为 QBO Account.Id（契约 G2）。
export type GlAccountRef = {
  qboAccountId: string;
  name: string;
  accountType?: string;
};

export type ClassifyInput = {
  description: string;
  amount: DecimalString;
  vendorName: string | null;
  accounts: GlAccountRef[];
  // Veryfi 文档级分类建议（映射到本地科目后传入），作 LLM 未命中时的兜底。
  suggestedCategory?: { glAccountId: string; glAccountName: string; score: number } | null;
};

export type ClassificationSource = "rule" | "llm" | "veryfi" | "seed" | "none";

export type Classification = {
  glAccountId: string | null; // QBO Account.Id
  glAccountName: string | null; // derived 快照（契约 §4.4）
  confidence: Confidence;
  reason: string;
  source: ClassificationSource;
};

// LLM 分类器接口（规则命中在此之前处理，见 classify-line.ts）。
export interface Classifier {
  readonly name: string;
  classify(input: ClassifyInput): Promise<Classification>;
}

export const NO_MATCH: Classification = {
  glAccountId: null,
  glAccountName: null,
  confidence: "low",
  reason: "无匹配，需人工",
  source: "none",
};

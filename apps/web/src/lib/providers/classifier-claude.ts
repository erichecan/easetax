// Claude 分类器：tool use 强制结构化输出，account_id 限定为候选科目 id 的 enum，
// 保证模型只能选真实存在的科目（契约 G2）。高频分类默认 Haiku（成本，补充文档）。
import Anthropic from "@anthropic-ai/sdk";
import type { Confidence } from "@/domain";
import { CONFIDENCES } from "@/domain";
import type { Classification, Classifier, ClassifyInput } from "./classifier";
import { NO_MATCH } from "./classifier";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

function buildPrompt(input: ClassifyInput): string {
  const list = input.accounts
    .map((a) => `- id=${a.qboAccountId} | ${a.name}${a.accountType ? ` (${a.accountType})` : ""}`)
    .join("\n");
  return [
    "你是加拿大记账助手。为下面这条采购交易选择最合适的 GL 费用科目。",
    "",
    `供应商：${input.vendorName ?? "（未知）"}`,
    `摘要：${input.description}`,
    `金额：${input.amount}`,
    "",
    "可选科目（只能从中选一个 id）：",
    list,
    "",
    "调用 select_gl_account 返回你的选择。若无法确定，选最接近的并把 confidence 设为 low。",
  ].join("\n");
}

export class ClaudeClassifier implements Classifier {
  readonly name = "claude";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async classify(input: ClassifyInput): Promise<Classification> {
    if (input.accounts.length === 0) return { ...NO_MATCH, reason: "无候选科目表" };

    const tool: Anthropic.Tool = {
      name: "select_gl_account",
      description: "从候选科目中选择最合适的 GL 费用科目",
      input_schema: {
        type: "object",
        properties: {
          account_id: { type: "string", enum: input.accounts.map((a) => a.qboAccountId) },
          confidence: { type: "string", enum: [...CONFIDENCES] },
          reason: { type: "string", description: "简短中文理由" },
        },
        required: ["account_id", "confidence", "reason"],
      },
    };

    const msg = await this.client.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [tool],
      tool_choice: { type: "tool", name: "select_gl_account" },
      messages: [{ role: "user", content: buildPrompt(input) }],
    });

    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return { ...NO_MATCH, reason: "模型未返回结构化结果" };
    }

    const out = block.input as { account_id: string; confidence: Confidence; reason: string };
    const acct = input.accounts.find((a) => a.qboAccountId === out.account_id) ?? null;
    if (!acct) return { ...NO_MATCH, reason: "模型返回了不存在的科目 id" };

    return {
      glAccountId: acct.qboAccountId,
      glAccountName: acct.name,
      confidence: CONFIDENCES.includes(out.confidence) ? out.confidence : "low",
      reason: out.reason,
      source: "llm",
    };
  }
}

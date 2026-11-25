export const CHAPTER_PROSE_QUALITY_RULES = [
  "避免使用破折号、省略号或连续连字符制造模型化停顿；需要停顿时改用句号、逗号、动作或人物反应。",
  "避免高频‘不是……而是……’‘却是……’‘反而是……’否定翻转句；改用具体动作、感官细节或角色判断。",
  "禁止出现 AI 自述、拒绝话术、占位符、任务单、Prompt、Schema、上下文包等工程说明。",
  "优先使用具体动作、对话和可感知细节，避免空泛总结、机械排比和连续碎片短句。",
] as const;

export const CHAPTER_PROSE_QUALITY_AUDIT_RULES = [
  "必须检查破折号、省略号、连续连字符、否定翻转句、AI 自述、占位符、工程术语泄漏和机械碎句。",
  "上述表达风险属于正文质量问题；证据必须指向正文中的具体句子，不得只根据任务单或写作意图推断。",
] as const;

/**
 * Whether a book avoids ellipses and dashes (the default) or uses them the way people talk.
 * The style profile's language rules carry the choice; writer, acceptance and the detector read it there.
 */
export type PausePunctuationPolicy = "avoid" | "natural";

/** Stated once in the writer and acceptance prompts so a book's own contract can outrank the general rules. */
export const CHAPTER_STYLE_CONTRACT_PRECEDENCE_RULE =
  "写法合同对停顿标点、心理活动写法或章末收束另有明确约定时，以写法合同为准，通用表达要求中与之冲突的条目不再适用。";

/** The style contract line a "natural" book shows to the writer and to reviewers. */
export const NATURAL_PAUSE_PUNCTUATION_CONTRACT_LINE =
  "停顿标点：对白和人物心理活动里可以自然使用省略号、破折号，表示迟疑、拖长、被打断或话没说完；不连续堆叠，不用标点代替动作和反应。本条优先于通用表达要求中对停顿标点的限制。";

export function resolvePausePunctuationPolicy(
  languageRules: { pausePunctuation?: unknown } | null | undefined,
): PausePunctuationPolicy {
  return languageRules?.pausePunctuation === "natural" ? "natural" : "avoid";
}

import type {
  RuntimeAuditIssue,
  RuntimeAuditReport,
} from "@ai-novel/shared/types/chapterRuntime";
import {
  resolvePausePunctuationPolicy,
  type PausePunctuationPolicy,
} from "@ai-novel/shared/types/chapterProseContract";
import type { RuntimeStyleExemplar } from "@ai-novel/shared/types/styleEngine";
import { contentOnly, findLeakedSourceEntities, findStyleExemplarOverlaps } from "../../../styleEngine/exemplars";

export type ProseQualityIssueCode =
  | "prose_negative_flip"
  | "prose_dash_or_ellipsis"
  | "prose_pause_punctuation_dense"
  | "prose_exemplar_overlap"
  | "prose_source_entity_leak"
  | "prose_period_stutter"
  | "prose_long_paragraph"
  | "prose_verbatim_repeat"
  | "prose_truncation"
  | "prose_ai_self_reference"
  | "prose_placeholder_leak"
  | "prose_engineering_term_leak";

export interface ProseQualityFinding {
  code: ProseQualityIssueCode;
  severity: RuntimeAuditIssue["severity"];
  line: number;
  column: number;
  message: string;
  excerpt: string;
  fixSuggestion: string;
}

export interface ProseQualityReport {
  findings: ProseQualityFinding[];
  hasBlockingFindings: boolean;
}

/** Book-level expression choices the detector must respect. Omitted fields keep the general defaults. */
export interface ProseQualityOptions {
  pausePunctuation?: PausePunctuationPolicy;
  styleExemplars?: Array<Pick<RuntimeStyleExemplar, "id" | "text">>;
  /** Names registered for the source works of the bound style profiles. */
  sourceEntities?: string[];
}

export interface ProseQualityAuditReportInput {
  novelId: string;
  chapterId: string;
  report: ProseQualityReport;
  now?: Date;
}

interface TextSegment {
  text: string;
  line: number;
}

const MAX_FINDINGS_PER_CODE = 8;
const MAX_TOTAL_FINDINGS = 40;

const TERMINAL_PUNCTUATION = /[。！？!?”"」』）)】》…]$/u;
const NEGATIVE_FLIP_PATTERN = /(?:不是|并非|并不是|不算|不能说是|没有|不再是)[^。！？；;\n]{1,36}?[，,、]?\s*(?:而是|却是|反而是|更像是|只是)[^。！？；;\n]{1,36}/gu;
const DASH_OR_ELLIPSIS_PATTERN = /——|—|--|……|…{2,}|\.{3,}/u;
const PAUSE_MARK_PATTERN = /—+|-{2,}|…+|\.{3,}/gu;
// A book that allows pause punctuation still should not lean on it: three marks in one
// paragraph, or more than twelve per thousand characters across a chapter, reads as a tic.
const PAUSE_MARKS_PER_PARAGRAPH_LIMIT = 3;
const PAUSE_MARKS_PER_THOUSAND_LIMIT = 12;
const PAUSE_MARKS_DENSITY_MIN_COUNT = 8;
const AI_SELF_REFERENCE_PATTERN = /作为(?:一名|一个)?(?:AI|人工智能|语言模型)|我是(?:AI|人工智能|语言模型)|我无法(?:继续)?(?:创作|生成|提供|完成)|我不能(?:继续)?(?:创作|生成|提供|完成)|无法满足(?:该|这个)?请求|不能协助|as an AI|I (?:am|cannot|can't)[^。！？.!?\n]{0,40}AI/iu;
const PLACEHOLDER_PATTERN = /TODO|TBD|待补充|此处省略|省略若干|略写|占位|PLACEHOLDER|\{\{[^}]{0,80}\}\}|\[[^\]]{0,40}待补[^\]]{0,40}\]/iu;
const ENGINEERING_TERM_STRONG_PATTERN = /细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子|任务描述|任务单|scene\s*card|prompt|schema|runtime\s*package|上下文包|系统提示词|修复指令/iu;
const ENGINEERING_TERM_SOFT_PATTERN = /本章|下一章|读者|伏笔|前文|后文|剧情推进|人物弧光|爽点|节奏点|钩子/u;

/** Reads the book's expression choices from the style context a chapter was generated with. */
export function resolveProseQualityOptions(styleContext: {
  compiledBlocks?: { mergedRules?: { languageRules?: Record<string, unknown> } } | null;
  exemplars?: Array<Pick<RuntimeStyleExemplar, "id" | "text">>;
  sourceEntities?: string[];
} | null | undefined): ProseQualityOptions {
  return {
    pausePunctuation: resolvePausePunctuationPolicy(styleContext?.compiledBlocks?.mergedRules?.languageRules),
    styleExemplars: styleContext?.exemplars ?? [],
    sourceEntities: styleContext?.sourceEntities ?? [],
  };
}

export function detectProseQuality(content: string, options: ProseQualityOptions = {}): ProseQualityReport {
  const allowsPauseMarks = options.pausePunctuation === "natural";
  const segments = buildTextSegments(content);
  const findings: ProseQualityFinding[] = [];
  const counts = new Map<ProseQualityIssueCode, number>();

  const addFinding = (finding: ProseQualityFinding) => {
    if (findings.length >= MAX_TOTAL_FINDINGS) {
      return;
    }
    const currentCount = counts.get(finding.code) ?? 0;
    if (currentCount >= MAX_FINDINGS_PER_CODE) {
      return;
    }
    const duplicated = findings.some((existing) => (
      existing.code === finding.code
      && existing.line === finding.line
      && existing.excerpt === finding.excerpt
    ));
    if (duplicated) {
      return;
    }
    counts.set(finding.code, currentCount + 1);
    findings.push(finding);
  };

  // Reported first: acceptance forwards only the leading findings, and a source name in the
  // book is the one defect here that no reader-facing judgement can excuse.
  scanSourceEntityLeak(segments, options.sourceEntities ?? [], addFinding);
  for (const segment of segments) {
    scanNegativeFlip(segment, addFinding);
    if (!allowsPauseMarks) {
      scanDashOrEllipsis(segment, addFinding);
    }
    scanAiSelfReference(segment, addFinding);
    scanPlaceholderLeak(segment, addFinding);
    scanEngineeringTermLeak(segment, addFinding);
    scanPeriodStutter(segment, addFinding);
    scanLongParagraph(segment, addFinding);
  }

  if (allowsPauseMarks) {
    scanPausePunctuationDensity(segments, addFinding);
  }
  scanExemplarOverlap(content, segments, options.styleExemplars ?? [], addFinding);
  scanVerbatimRepeat(segments, addFinding);
  scanTruncation(content, segments, addFinding);

  return {
    findings,
    hasBlockingFindings: findings.some((finding) => (
      finding.severity === "high" || finding.severity === "critical"
    )),
  };
}

/** Only reject defects that the existing acceptance guard would newly classify as severe. */
export function detectNewSevereProseFindings(
  original: string,
  candidate: string,
  options: ProseQualityOptions = {},
): ProseQualityFinding[] {
  const isSevere = (finding: ProseQualityFinding) => finding.severity === "high" || finding.severity === "critical";
  const originalCodes = new Set(detectProseQuality(original, options).findings.filter(isSevere).map(finding => finding.code));
  return detectProseQuality(candidate, options).findings.filter(finding => isSevere(finding) && !originalCodes.has(finding.code));
}

export function buildProseQualityAuditReport(
  input: ProseQualityAuditReportInput,
): RuntimeAuditReport | null {
  if (input.report.findings.length === 0) {
    return null;
  }
  const createdAt = (input.now ?? new Date()).toISOString();
  const reportId = `prose-quality:${input.novelId}:${input.chapterId}`;
  const issues = input.report.findings.map<RuntimeAuditIssue>((finding, index) => ({
    id: `${reportId}:${index + 1}:${finding.code}`,
    reportId,
    auditType: "mode_fit",
    severity: finding.severity,
    code: finding.code,
    description: finding.message,
    evidence: `第 ${finding.line} 行：${finding.excerpt}`,
    fixSuggestion: finding.fixSuggestion,
    status: "open",
    createdAt,
    updatedAt: createdAt,
  }));

  return {
    id: reportId,
    novelId: input.novelId,
    chapterId: input.chapterId,
    auditType: "mode_fit",
    overallScore: scoreFindings(input.report.findings),
    summary: `正文自然度/退化检测发现 ${issues.length} 个问题。`,
    legacyScoreJson: null,
    issues,
    createdAt,
    updatedAt: createdAt,
  };
}

function buildTextSegments(content: string): TextSegment[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const segments: TextSegment[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence || trimmed.length === 0 || trimmed.startsWith(">")) {
      return;
    }
    segments.push({
      text: line,
      line: index + 1,
    });
  });
  return segments;
}

function scanNegativeFlip(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  for (const match of segment.text.matchAll(NEGATIVE_FLIP_PATTERN)) {
    const index = match.index ?? 0;
    if (isInsideQuote(segment.text, index) || /不是[^。！？；;\n]{1,16}就是/u.test(match[0])) {
      continue;
    }
    addFinding({
      code: "prose_negative_flip",
      severity: "high",
      line: segment.line,
      column: index + 1,
      message: "正文出现高频 AI 式否定翻转句，容易显得概念化、模板化。",
      excerpt: formatExcerpt(match[0]),
      fixSuggestion: "改成具体动作、感官细节或角色判断，避免用“不是 A，而是 B”解释主题。",
    });
  }
}

function scanDashOrEllipsis(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const match = segment.text.match(DASH_OR_ELLIPSIS_PATTERN);
  if (!match || match.index == null) {
    return;
  }
  addFinding({
    code: "prose_dash_or_ellipsis",
    severity: "high",
    line: segment.line,
    column: match.index + 1,
    message: "正文使用破折号、省略号或双连字符，容易形成模型化停顿。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "改写为自然的动作停顿、句读或人物反应，减少机械标点制造的情绪。",
  });
}

function scanPausePunctuationDensity(
  segments: TextSegment[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  let totalMarks = 0;
  let totalChars = 0;
  for (const segment of segments) {
    const marks = segment.text.match(PAUSE_MARK_PATTERN)?.length ?? 0;
    totalMarks += marks;
    totalChars += visibleLength(segment.text);
    if (marks >= PAUSE_MARKS_PER_PARAGRAPH_LIMIT) {
      addFinding({
        code: "prose_pause_punctuation_dense",
        severity: "medium",
        line: segment.line,
        column: 1,
        message: "同一段里省略号、破折号连续出现，停顿靠标点堆出来。",
        excerpt: formatExcerpt(segment.text),
        fixSuggestion: "保留最要紧的一处停顿，其余改成动作、反应或直接把话说完。",
      });
    }
  }
  if (
    totalMarks >= PAUSE_MARKS_DENSITY_MIN_COUNT
    && totalChars > 0
    && (totalMarks * 1000) / totalChars > PAUSE_MARKS_PER_THOUSAND_LIMIT
  ) {
    addFinding({
      code: "prose_pause_punctuation_dense",
      severity: "medium",
      line: segments[0]?.line ?? 1,
      column: 1,
      message: `全章省略号、破折号共 ${totalMarks} 处，密度偏高，读起来像口头禅。`,
      excerpt: `每千字约 ${Math.round((totalMarks * 1000) / totalChars)} 处`,
      fixSuggestion: "只在迟疑、被打断或话没说完的地方保留，其余改回正常句读。",
    });
  }
}

function scanExemplarOverlap(
  content: string,
  segments: TextSegment[],
  exemplars: Array<Pick<RuntimeStyleExemplar, "id" | "text">>,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (exemplars.length === 0) {
    return;
  }
  for (const overlap of findStyleExemplarOverlaps(content, exemplars)) {
    const anchor = overlap.shared.split("…")[0].slice(0, 8);
    const segment = segments.find((item) => contentOnly(item.text).includes(anchor));
    addFinding({
      code: "prose_exemplar_overlap",
      severity: "high",
      line: segment?.line ?? 1,
      column: 1,
      message: "正文搬用了文笔样例的句子，样例只能学读感。",
      excerpt: formatExcerpt(overlap.shared),
      fixSuggestion: "用本书自己的人物、物件和处境把这一处重写，保留节奏即可。",
    });
  }
}

function scanSourceEntityLeak(
  segments: TextSegment[],
  sourceEntities: string[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (sourceEntities.length === 0) {
    return;
  }
  const leaked = findLeakedSourceEntities(segments.map((segment) => segment.text).join("\n"), sourceEntities);
  for (const entity of leaked) {
    const segment = segments.find((item) => item.text.includes(entity));
    if (!segment) {
      continue;
    }
    addFinding({
      code: "prose_source_entity_leak",
      severity: "critical",
      line: segment.line,
      column: segment.text.indexOf(entity) + 1,
      message: `正文出现了参考作品的专名“${entity}”。`,
      excerpt: formatExcerpt(segment.text),
      fixSuggestion: "换成本书自己的人物、地点或称谓；参考作品只提供写法，不提供名字。",
    });
  }
}

function scanAiSelfReference(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const match = segment.text.match(AI_SELF_REFERENCE_PATTERN);
  if (!match || match.index == null || isInsideQuote(segment.text, match.index)) {
    return;
  }
  addFinding({
    code: "prose_ai_self_reference",
    severity: "critical",
    line: segment.line,
    column: match.index + 1,
    message: "正文泄漏 AI 身份、拒绝话术或模型说明。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "删除 AI 自述和拒绝话术，改成符合角色与场景的正文叙述。",
  });
}

function scanPlaceholderLeak(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const match = segment.text.match(PLACEHOLDER_PATTERN);
  if (!match || match.index == null || isInsideQuote(segment.text, match.index)) {
    return;
  }
  addFinding({
    code: "prose_placeholder_leak",
    severity: "critical",
    line: segment.line,
    column: match.index + 1,
    message: "正文包含占位、待补或省略提示。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "补成完整可读的剧情内容，不能把占位符留给读者。",
  });
}

function scanEngineeringTermLeak(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const strongMatch = segment.text.match(ENGINEERING_TERM_STRONG_PATTERN);
  if (strongMatch?.index != null && !isInsideQuote(segment.text, strongMatch.index)) {
    addFinding({
      code: "prose_engineering_term_leak",
      severity: "high",
      line: segment.line,
      column: strongMatch.index + 1,
      message: "正文泄漏任务单、细纲、提示词或运行态工程词。",
      excerpt: formatExcerpt(segment.text),
      fixSuggestion: "删去工程词和写作指令，把信息改写成角色行动、环境变化或叙事结果。",
    });
    return;
  }

  const softMatch = segment.text.match(ENGINEERING_TERM_SOFT_PATTERN);
  if (softMatch?.index != null && !isInsideQuote(segment.text, softMatch.index)) {
    addFinding({
      code: "prose_engineering_term_leak",
      severity: "medium",
      line: segment.line,
      column: softMatch.index + 1,
      message: "正文出现偏创作说明的元叙事词，可能削弱沉浸感。",
      excerpt: formatExcerpt(segment.text),
      fixSuggestion: "把面向作者或读者的说明转成故事内部可见的行动、结果或信息差。",
    });
  }
}

function scanPeriodStutter(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (lineLooksLikeDialogue(segment.text)) {
    return;
  }
  const matches = Array.from(segment.text.matchAll(/[^。！？!?]{1,8}[。！？!?]/gu))
    .map((match) => match[0])
    .filter((sentence) => visibleLength(sentence) <= 8);
  if (matches.length < 6) {
    return;
  }
  addFinding({
    code: "prose_period_stutter",
    severity: "medium",
    line: segment.line,
    column: 1,
    message: "正文连续使用过短句号，节奏显得碎裂和机械。",
    excerpt: formatExcerpt(matches.slice(0, 6).join("")),
    fixSuggestion: "合并部分短句，并用动作链、视线转移或心理承接形成更自然的段落节奏。",
  });
}

function scanLongParagraph(
  segment: TextSegment,
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  if (visibleLength(segment.text) <= 220) {
    return;
  }
  addFinding({
    code: "prose_long_paragraph",
    severity: "medium",
    line: segment.line,
    column: 1,
    message: "正文段落过长，阅读节奏和移动端可读性下降。",
    excerpt: formatExcerpt(segment.text),
    fixSuggestion: "按动作转折、信息揭示或情绪变化拆成更短段落。",
  });
}

function scanVerbatimRepeat(
  segments: TextSegment[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  for (let index = 1; index < segments.length; index += 1) {
    const previous = normalizeRepeatText(segments[index - 1].text);
    const current = normalizeRepeatText(segments[index].text);
    if (previous.length >= 8 && previous === current) {
      addFinding({
        code: "prose_verbatim_repeat",
        severity: "critical",
        line: segments[index].line,
        column: 1,
        message: "正文出现相邻段落复读。",
        excerpt: formatExcerpt(segments[index].text),
        fixSuggestion: "删除重复段落，保留信息推进更明确的一版。",
      });
    }
  }

  const sentenceMap = new Map<string, { sentence: string; line: number; count: number }>();
  for (const segment of segments) {
    for (const sentence of splitSentences(stripQuotedText(segment.text))) {
      const normalized = normalizeRepeatText(sentence);
      if (normalized.length < 12) {
        continue;
      }
      const item = sentenceMap.get(normalized) ?? {
        sentence,
        line: segment.line,
        count: 0,
      };
      item.count += 1;
      sentenceMap.set(normalized, item);
    }
  }
  for (const item of sentenceMap.values()) {
    if (item.count >= 3) {
      addFinding({
        code: "prose_verbatim_repeat",
        severity: "critical",
        line: item.line,
        column: 1,
        message: "正文多次重复同一句或高度相同的句子。",
        excerpt: formatExcerpt(item.sentence),
        fixSuggestion: "保留一次有效表达，其余位置改成新的动作、反应或信息推进。",
      });
    }
  }
}

function scanTruncation(
  content: string,
  segments: TextSegment[],
  addFinding: (finding: ProseQualityFinding) => void,
): void {
  const trimmed = content.trim();
  if (visibleLength(trimmed) < 80 || TERMINAL_PUNCTUATION.test(trimmed)) {
    return;
  }
  const lastSegment = segments[segments.length - 1];
  addFinding({
    code: "prose_truncation",
    severity: "critical",
    line: lastSegment?.line ?? 1,
    column: Math.max(1, (lastSegment?.text.length ?? trimmed.length) - 20),
    message: "正文结尾缺少完整句读，疑似生成中断或被截断。",
    excerpt: formatExcerpt(lastSegment?.text ?? trimmed),
    fixSuggestion: "补齐结尾句、动作结果和章节收束，确认正文不是半句停在输出末尾。",
  });
}

function splitSentences(text: string): string[] {
  return Array.from(text.matchAll(/[^。！？!?]+[。！？!?]/gu)).map((match) => match[0]);
}

function normalizeRepeatText(text: string): string {
  return text
    .replace(/[「」『』“”‘’"'（）()[\]【】《》<>]/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

function stripQuotedText(text: string): string {
  return text
    .replace(/「[^」]*」/gu, "")
    .replace(/『[^』]*』/gu, "")
    .replace(/“[^”]*”/gu, "")
    .replace(/"[^"]*"/gu, "");
}

function isInsideQuote(text: string, index: number): boolean {
  const pairs: Array<[string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["\"", "\""],
    ["'", "'"],
  ];
  return pairs.some(([open, close]) => {
    const before = text.slice(0, index);
    const openIndex = before.lastIndexOf(open);
    if (openIndex < 0) {
      return false;
    }
    const closeIndex = text.indexOf(close, openIndex + open.length);
    return closeIndex >= index;
  });
}

function lineLooksLikeDialogue(text: string): boolean {
  const trimmed = text.trim();
  return /^["“「『]/u.test(trimmed) || /[」』”"]$/u.test(trimmed);
}

function visibleLength(text: string): number {
  return text.replace(/\s+/gu, "").length;
}

function formatExcerpt(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function scoreFindings(findings: ProseQualityFinding[]): number {
  const penalty = findings.reduce((total, finding) => {
    switch (finding.severity) {
      case "critical":
        return total + 18;
      case "high":
        return total + 12;
      case "medium":
        return total + 6;
      case "low":
        return total + 3;
      default:
        return total;
    }
  }, 0);
  return Math.max(30, 100 - penalty);
}

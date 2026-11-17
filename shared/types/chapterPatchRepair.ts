import { z } from "zod";

export const CHAPTER_PATCH_REPAIR_STRATEGIES = [
  "patch_first",
  "full_rewrite",
] as const;

export type ChapterPatchRepairStrategy = typeof CHAPTER_PATCH_REPAIR_STRATEGIES[number];

export const chapterPatchOperationSchema = z.object({
  id: z.string().trim().min(1),
  targetExcerpt: z.string().trim().min(6),
  // Ordinal and count refer to the same unchanged source text as targetExcerpt.
  location: z.object({
    occurrence: z.number().int().min(1),
    expectedOccurrences: z.number().int().min(1),
  }).refine(value => value.occurrence <= value.expectedOccurrences).optional(),
  replacement: z.string().trim(),
  reason: z.string().trim().min(1),
  issueIds: z.array(z.string().trim().min(1)).max(8).default([]),
});

export const chapterPatchRepairPlanSchema = z.object({
  strategy: z.enum(CHAPTER_PATCH_REPAIR_STRATEGIES).default("patch_first"),
  summary: z.string().trim().min(1),
  patches: z.array(chapterPatchOperationSchema).max(8).default([]),
  requiresFullRewrite: z.boolean().default(false),
  escalationReason: z.string().trim().nullable().optional(),
});

export type ChapterPatchOperation = z.infer<typeof chapterPatchOperationSchema>;
export type ChapterPatchRepairPlan = z.infer<typeof chapterPatchRepairPlanSchema>;

export type ChapterPatchApplyFailureType =
  | "requires_full_rewrite"
  | "missing_target"
  | "ambiguous_target"
  | "overlapping_target"
  | "no_effect";

export type ChapterPatchMatchStrategy = "exact" | "normalized_whitespace";

export interface ChapterPatchApplyFailure {
  patchId: string;
  reason: string;
  failureType: ChapterPatchApplyFailureType;
  matchedBy?: ChapterPatchMatchStrategy;
  occurrenceCount?: number;
}

export interface ChapterPatchAppliedPatch {
  patchId: string;
  matchedBy: ChapterPatchMatchStrategy;
}

export interface ChapterPatchApplyResult {
  success: boolean;
  content: string;
  appliedPatchIds: string[];
  appliedPatches: ChapterPatchAppliedPatch[];
  failures: ChapterPatchApplyFailure[];
}

interface PatchMatch {
  start: number;
  end: number;
  matchedBy: ChapterPatchMatchStrategy;
}

function buildWhitespaceNormalizedIndex(value: string): {
  text: string;
  originalIndices: number[];
} {
  const chars: string[] = [];
  const originalIndices: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (/\s/u.test(char)) {
      continue;
    }
    chars.push(char);
    originalIndices.push(index);
  }
  return {
    text: chars.join(""),
    originalIndices,
  };
}

function findWhitespaceNormalizedMatches(content: string, target: string): PatchMatch[] {
  const normalizedContent = buildWhitespaceNormalizedIndex(content);
  const normalizedTarget = buildWhitespaceNormalizedIndex(target);
  if (!normalizedTarget.text) {
    return [];
  }

  const matches: PatchMatch[] = [];
  let cursor = 0;
  while (cursor < normalizedContent.text.length) {
    const normalizedIndex = normalizedContent.text.indexOf(normalizedTarget.text, cursor);
    if (normalizedIndex < 0) {
      break;
    }
    const lastNormalizedIndex = normalizedIndex + normalizedTarget.text.length - 1;
    const start = normalizedContent.originalIndices[normalizedIndex];
    const endSourceIndex = normalizedContent.originalIndices[lastNormalizedIndex];
    if (typeof start === "number" && typeof endSourceIndex === "number") {
      matches.push({
        start,
        end: endSourceIndex + 1,
        matchedBy: "normalized_whitespace",
      });
    }
    cursor = normalizedIndex + normalizedTarget.text.length;
  }
  return matches;
}

function findSafePatchMatch(content: string, target: string, location?: ChapterPatchOperation["location"]): {
  match: PatchMatch | null;
  occurrenceCount: number;
  matchedBy?: ChapterPatchMatchStrategy;
} {
  const exact: PatchMatch[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(target, cursor);
    if (start < 0) break;
    exact.push({ start, end: start + target.length, matchedBy: "exact" });
    cursor = start + target.length;
  }
  const matches = exact.length ? exact : findWhitespaceNormalizedMatches(content, target);
  const match = location
    ? (location.expectedOccurrences === matches.length ? matches[location.occurrence - 1] ?? null : null)
    : (matches.length === 1 ? matches[0]! : null);
  return { match, occurrenceCount: matches.length, matchedBy: matches[0]?.matchedBy };
}

export function applyChapterPatchRepairPlan(
  content: string,
  plan: ChapterPatchRepairPlan,
): ChapterPatchApplyResult {
  const normalizedPlan = chapterPatchRepairPlanSchema.parse(plan);
  let nextContent = content;
  const appliedPatchIds: string[] = [];
  const appliedPatches: ChapterPatchAppliedPatch[] = [];
  const failures: ChapterPatchApplyFailure[] = [];

  if (normalizedPlan.strategy !== "patch_first" || normalizedPlan.requiresFullRewrite) {
    return {
      success: false,
      content,
      appliedPatchIds,
      appliedPatches,
      failures: [{
        patchId: "plan",
        reason: normalizedPlan.escalationReason?.trim() || "补丁计划要求整章重写。",
        failureType: "requires_full_rewrite",
      }],
    };
  }

  const located: { patch: ChapterPatchOperation; match: PatchMatch }[] = [];
  for (const patch of normalizedPlan.patches) {
    const target = patch.targetExcerpt.trim();
    const replacement = patch.replacement.trim();
    const matchResult = findSafePatchMatch(content, target, patch.location);
    if (!matchResult.match) {
      failures.push({
        patchId: patch.id,
        reason: matchResult.occurrenceCount === 0
          ? "目标片段不存在，不能安全应用局部补丁。"
          : patch.location ? "目标出现次数或位置与当前正文不一致，不能安全应用局部补丁。"
          : "目标片段出现多次，不能确定局部补丁位置。",
        failureType: matchResult.occurrenceCount === 0 ? "missing_target" : "ambiguous_target",
        matchedBy: matchResult.matchedBy,
        occurrenceCount: matchResult.occurrenceCount,
      });
      continue;
    }

    if (content.slice(matchResult.match.start, matchResult.match.end) === replacement) {
      failures.push({
        patchId: patch.id,
        reason: "局部补丁没有产生有效正文变化。",
        failureType: "no_effect",
        matchedBy: matchResult.match.matchedBy,
        occurrenceCount: matchResult.occurrenceCount,
      });
      continue;
    }
    located.push({ patch, match: matchResult.match });
  }

  // Resolve every range against the original text before changing any prose.
  // Nested targets cannot be composed safely: neither replacement may be discarded.
  for (let i = 0; i < located.length; i += 1) {
    const current = located[i]!;
    const conflicts = located.filter((other, j) => j !== i
      && current.match.start < other.match.end && other.match.start < current.match.end);
    if (conflicts.length) {
      failures.push({
        patchId: current.patch.id,
        failureType: "overlapping_target",
        matchedBy: current.match.matchedBy,
        reason: `目标片段与补丁 ${conflicts.map(other => other.patch.id).join("、")} 重叠，需合并为一条补丁。`,
      });
    }
  }
  if (failures.length) return { success: false, content, appliedPatchIds, appliedPatches, failures };

  for (const { patch, match } of [...located].sort((a, b) => b.match.start - a.match.start)) {
    nextContent = nextContent.slice(0, match.start) + patch.replacement.trim() + nextContent.slice(match.end);
  }
  for (const { patch, match } of located) {
    appliedPatchIds.push(patch.id);
    appliedPatches.push({
      patchId: patch.id,
      matchedBy: match.matchedBy,
    });
  }

  const changed = nextContent.trim() !== content.trim();
  return {
    success: failures.length === 0 && appliedPatchIds.length > 0 && changed,
    content: nextContent,
    appliedPatchIds,
    appliedPatches,
    failures,
  };
}

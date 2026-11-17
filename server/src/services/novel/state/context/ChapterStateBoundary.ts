import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../../../db/prisma";
import { CHAPTER_ARTIFACT_BOUNDARY_TYPE, hasCurrentChapterArtifactSyncBoundary } from "../../runtime/artifactSync/ChapterArtifactSyncBoundary";
import { buildChapterArtifactContentHash } from "../../runtime/artifactSync/ChapterArtifactContentVersion";

/** History remains stored; only current, synchronized source revisions may feed a chapter. */
export async function readChapterStateSources(novelId: string, chapterOrder: number,
  db: Pick<Prisma.TransactionClient, "chapter"> = prisma, includeCurrent = false) {
  if (chapterOrder <= 1 && !includeCurrent) return [];
  const rows = await db.chapter.findMany({
    where: {novelId, order: includeCurrent ? {lte: chapterOrder} : {lt: chapterOrder}},
    orderBy: {order: "desc"},
    select: {id: true, order: true, content: true, productionUnitRuns: {select: {progressJson: true}}, artifactSyncCheckpoints: {
      where: {artifactType: CHAPTER_ARTIFACT_BOUNDARY_TYPE, status: "succeeded"},
      select: {contentHash: true, metadataJson: true, artifactType: true},
    }},
  });
  return rows.filter(row => hasCurrentChapterArtifactSyncBoundary(row.content, row.artifactSyncCheckpoints,
    {requireAppliedDelta: true}) || hasCurrentNativeStateBoundary(row, novelId)).map(row => ({id: row.id, order: row.order, contentHash: buildChapterArtifactContentHash(row.content!)}));
}

/** This marker is an application-owned projection, not author prose or semantic matching. */
export function chapterBaselineCharacter<T extends {currentState?: string | null; currentGoal?: string | null; lastEvolvedAt?: Date | null}>(character: T): T {
  return {...character,
    currentState: character.lastEvolvedAt ? null : (character.currentState?.replace(/\n?【信息边界】[^\n]*/g, "").trim() || null),
    currentGoal: character.lastEvolvedAt ? null : character.currentGoal ?? null,
  };
}

export function snapshotMatchesSource(snapshot: {sourceChapterId: string | null; rawStateJson?: string | null},
  sources: Array<{id: string; contentHash: string}>): boolean {
  const source = sources.find(row => row.id === snapshot.sourceChapterId);
  if (!source) return false;
  if (!snapshot.rawStateJson) return true; // Legacy snapshots still require a valid chapter boundary.
  try {
    const value = JSON.parse(snapshot.rawStateJson);
    return !value.sourceContentHash || value.sourceContentHash === source.contentHash;
  } catch { return false; }
}

export function payoffVisibleBeforeChapter(item: {targetStartChapterOrder?: number | null; firstSeenChapterOrder?: number | null;
  lastTouchedChapterOrder?: number | null; lastTouchedChapterId?: string | null}, order: number, sources?: Set<string>) {
  if (item.lastTouchedChapterId && sources && !sources.has(item.lastTouchedChapterId)) return false;
  if (item.firstSeenChapterOrder != null && item.firstSeenChapterOrder >= order) return false;
  if (item.lastTouchedChapterOrder != null && item.lastTouchedChapterOrder >= order) return false;
  return item.targetStartChapterOrder == null || item.targetStartChapterOrder <= order;
}

export function projectChapterCharacters<T extends {id: string; currentState?: string | null; currentGoal?: string | null; lastEvolvedAt?: Date | null}>(
  characters: T[], states: Array<{characterId?: string; currentGoal?: string | null; summary?: string | null; knownFactsJson?: string | null}> = []): T[] {
  return characters.map(original => {
    const baseline = chapterBaselineCharacter(original);
    const state = states.find(row => row.characterId === original.id);
    let knownFacts: string[] = [];
    try { const parsed = JSON.parse(state?.knownFactsJson ?? "[]"); if (Array.isArray(parsed)) knownFacts = parsed.filter(item => typeof item === "string"); } catch { /* Invalid historical metadata is not context. */ }
    return {...baseline, currentGoal: state?.currentGoal ?? baseline.currentGoal,
      currentState: [state?.summary || baseline.currentState, ...knownFacts.map(fact => `已知：${fact}`)].filter(Boolean).join("；") || null};
  });
}

export function resourceVisibleBeforeChapter(item: {lastTouchedChapterId?: string | null; lastTouchedChapterOrder?: number | null}, order: number, sources: Set<string>) {
  return (!item.lastTouchedChapterId || sources.has(item.lastTouchedChapterId))
    && (item.lastTouchedChapterOrder == null || item.lastTouchedChapterOrder < order);
}

function hasCurrentNativeStateBoundary(chapter: {id: string; order: number; content: string | null; productionUnitRuns: Array<{progressJson: string}>}, novelId: string): boolean {
  if (!chapter.content?.trim()) return false;
  const hash = createHash("sha256").update(chapter.content).digest("hex");
  return chapter.productionUnitRuns.some(row => {
    try {
      const progress = JSON.parse(row.progressJson);
      return progress.unit?.novelId === novelId && progress.unit?.chapterId === chapter.id && progress.unit?.order === chapter.order
        && progress.committedContentHash === hash && progress.selectedContentHash === hash
        && Array.isArray(progress.completed) && progress.completed.includes("commit") && progress.completed.includes("reconcile")
        && ["completed", "degraded"].includes(progress.reconcileStatus);
    } catch { return false; }
  });
}

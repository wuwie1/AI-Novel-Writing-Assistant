import type {DirectorNovelCharacterAppearances} from "@ai-novel/shared/types/director/characterAppearances";

/** Count verified scene presence, never infer absence from untracked or unwritten prose. */
export function summarizeAppearanceCoverage(
  chapters: DirectorNovelCharacterAppearances["chapters"], characterId: string,
  volumeOrders: ReadonlySet<number>, currentOrder: number | null,
): {orders: number[]; hasUnverifiedAbsence: boolean} {
  const window = chapters.filter(chapter => volumeOrders.has(chapter.chapterOrder)
    && currentOrder != null && chapter.chapterOrder <= currentOrder);
  const orders = [...new Set(window.filter(chapter => chapter.events.some(event =>
    event.characterId === characterId && event.kind === "present")).map(chapter => chapter.chapterOrder))].sort((a,b)=>a-b);
  const last = orders.at(-1) ?? 0;
  return {orders, hasUnverifiedAbsence: window.some(chapter => chapter.chapterOrder > last && chapter.coverage !== "recorded")};
}

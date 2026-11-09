import type { Chapter, VolumePlan } from "@ai-novel/shared/types/novel";
import { EntityDirectory } from "@/platform";

export function BookChapterDirectory({ novelId, chapters, volumes, selected, select, pending, error, retry }: {
  novelId: string; chapters: Chapter[]; volumes?: VolumePlan[]; selected?: string | null;
  select: (id: string) => void; pending?: boolean; error?: boolean; retry?: () => void;
}) {
  const groups = new Map(volumes?.flatMap(volume => volume.chapters.flatMap(plan => plan.chapterId
    ? [[plan.chapterId, volume.title || `第 ${volume.sortOrder} 卷`] as const] : [])));
  return <EntityDirectory collection={`chapters:${novelId}`} title="章节目录" selection={selected}
    rows={[...chapters].sort((a,b) => a.order-b.order).map(c => ({
      id:c.id, label:`第 ${c.order} 章 · ${c.title}`, group:groups.get(c.id),
    }))} onSelect={select} pending={pending} error={error} retry={retry}/>;
}

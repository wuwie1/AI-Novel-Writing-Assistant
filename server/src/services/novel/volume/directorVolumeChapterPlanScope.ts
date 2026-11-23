import type { Prisma } from "@prisma/client";

const chapterPlanStatuses = [
  "active",
  "chapter_list_partial",
  "chapter_list_generated",
  "chapter_list_partial:active",
  "chapter_list_partial:chapter_list_generated",
];

export function directorVolumeChapterPlanFilter(novelId: string, activeVersionId?: string | null): Prisma.VolumePlanWhereInput {
  return {
    novelId,
    OR: [
      { status: { in: chapterPlanStatuses } },
      // A legacy volume's label alone does not identify which version owns it.
      {
        status: { in: ["planned", "chapter_list_partial:planned"] },
        sourceVersionId: activeVersionId,
        sourceVersion: { is: { novelId, status: "active" } },
      },
    ],
  };
}

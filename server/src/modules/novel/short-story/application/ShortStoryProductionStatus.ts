import type {
  ProductionRuntimeStatus,
  ProductionStatusResult,
  ProductionStatusStage,
} from "../../../../services/novel/NovelProductionStatusService";

export interface ShortStoryStatusSource {
  id: string;
  title: string;
  targetWordCount: number | null;
  shortStoryPlan?: { status: string; targetWordCount: number } | null;
  shortStorySegments?: Array<{ order: number; status: string; content: string | null }>;
}

export function buildShortStoryProductionStatus(
  novel: ShortStoryStatusSource,
  runtimeStatus: ProductionRuntimeStatus,
): ProductionStatusResult {
  const title = novel.title.trim().replace(/^《(.+)》$/, "$1");
  const plan = novel.shortStoryPlan ?? null;
  const segments = [...(novel.shortStorySegments ?? [])].sort((left, right) => left.order - right.order);
  const segmentTotal = segments.length;
  const segmentDone = segments.filter((segment) => segment.status === "completed").length;
  const wordCount = segments.reduce((sum, segment) => sum + (segment.content?.trim().length ?? 0), 0);
  const targetWordCount = plan?.targetWordCount ?? novel.targetWordCount ?? null;
  const finished = plan?.status === "completed" && segmentTotal > 0 && segmentDone === segmentTotal;

  const assetStages: ProductionStatusStage[] = [
    { key: "novel_workspace", label: "作品", status: "completed", detail: `《${title}》` },
    {
      key: "short_story_plan",
      label: "短篇方案",
      status: plan ? "completed" : "pending",
      detail: targetWordCount ? `目标约 ${targetWordCount} 字` : null,
    },
    {
      key: "short_story_segments",
      label: "正文",
      status: segmentTotal > 0 && segmentDone === segmentTotal ? "completed" : segmentDone > 0 ? "running" : "pending",
      detail: segmentTotal > 0 ? `${segmentDone}/${segmentTotal} 段，约 ${wordCount} 字` : null,
    },
    {
      key: "short_story_review",
      label: "成稿检查",
      status: finished ? "completed" : "pending",
      detail: null,
    },
  ];

  const currentStage = finished
    ? "完整作品已完成"
    : !plan
      ? "准备短篇方案"
      : segmentDone > 0
        ? "续写正文"
        : "开始写正文";
  const totalPercent = finished
    ? 100
    : segmentTotal > 0
      ? Math.round((segmentDone / segmentTotal) * 90)
      : 0;
  const summary = segmentTotal > 0
    ? `《${title}》是一部短篇，已完成 ${segmentDone}/${segmentTotal} 段，约 ${wordCount} 字。`
    : `《${title}》是一部短篇，还没有正文。`;
  const recoveryHint = finished
    ? "打开这部短篇的创作页通读全文，需要调整时在那里发起修改。"
    : "打开这部短篇的创作页继续生成正文。";

  return {
    novelId: novel.id,
    title,
    narrativeForm: "short_story",
    worldId: null,
    worldName: null,
    chapterCount: 0,
    targetChapterCount: 0,
    assetStages,
    assetsReady: Boolean(plan),
    pipelineReady: Boolean(plan),
    pipelineJobId: runtimeStatus.jobId,
    pipelineStatus: runtimeStatus.status,
    failureSummary: runtimeStatus.failureSummary,
    recoveryHint,
    currentStage,
    summary,
    progressBasis: "facts",
    factProgress: {
      planningCompleted: plan ? 1 : 0,
      planningTotal: 1,
      planningPercent: plan ? 100 : 0,
      plannedChapterCount: 0,
      chapterCount: 0,
      draftedChapterCount: 0,
      reviewedChapterCount: 0,
      approvedChapterCount: 0,
      committedChapterCount: 0,
      completedChapters: 0,
      needsRepairChapters: 0,
      currentChapterOrder: null,
      activeChapterOrder: null,
      chapterExecutionPercent: 0,
      qualityRepairPercent: 0,
      totalPercent,
      facts: {
        hasWorld: false,
        hasStoryMacro: false,
        hasBookContract: false,
        hasStoryBible: false,
        hasCharacters: false,
        characterCount: 0,
        hasVolumeStrategy: false,
        volumeCount: 0,
        hasChapterTaskSheets: false,
        syncedChapterCount: 0,
      },
    },
    runtimeStatus,
  };
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DirectorContinuationMode } from "@ai-novel/shared/types/novelDirector";
import type {
  DirectorBookAutomationAction,
  DirectorBookAutomationProjection,
} from "@ai-novel/shared/types/directorRuntime";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDirectorBookAutomationProjection } from "@/api/novelDirector";
import { continueNovelWorkflow } from "@/api/novelWorkflow";
import { deleteNovel, downloadNovelExport, getNovelList, type NovelListItem } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import AICockpit from "@/components/autoDirector/AICockpit";
import { Button } from "@/components/ui/button";
import {
  AppDialogContent,
  Dialog,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { resolveWorkflowContinuationFeedback } from "@/lib/novelWorkflowContinuation";
import { getDirectorCockpitActionHref, getNovelWorkspaceHref } from "@/lib/novelRoutes";
import {
  getDirectorCockpitContinuationMode,
  isDirectorCockpitContinuationAction,
} from "@/lib/directorCockpitActions";
import { useTaskRecovery } from "@/components/layout/TaskRecoveryContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NovelListEmptyState } from "./components/list/NovelListEmptyState";
import { NovelListFilterBar } from "./components/list/NovelListFilterBar";
import { NovelListHeader } from "./components/list/NovelListHeader";
import { NovelListPagination } from "./components/list/NovelListPagination";
import { NovelListSkeleton } from "./components/list/NovelListSkeleton";
import { NovelProjectCard } from "./components/list/NovelProjectCard";
import { NovelContinueCard, NovelShelfCard } from "./components/list/NovelShelfCard";
import { NovelCoverDialog } from "./components/cover/NovelCoverDialog";
import { createDefaultNovelBasicFormState, type NovelBasicFormState } from "./novelBasicInfo.shared";
import {
  buildNovelListSummary,
  getNovelWorkflowTask,
  NOVEL_LIST_PAGE_SIZE,
  type StatusFilter,
  type WritingModeFilter,
} from "./components/list/novelListViewModel";

function createDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface NovelListPresentation {
  novels: NovelListItem[];
  total: number;
  page: number;
  totalPages: number;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  search: string;
  setSearch: (value: string) => void;
  status: StatusFilter;
  setStatus: (value: StatusFilter) => void;
  writingMode: WritingModeFilter;
  setWritingMode: (value: WritingModeFilter) => void;
  narrativeForm: "all" | "short_story" | "long_novel";
  setNarrativeForm: (value: "all" | "short_story" | "long_novel") => void;
  sort: "updated" | "created" | "progress";
  setSort: (value: "updated" | "created" | "progress") => void;
  view: "shelf" | "workbench";
  setView: (value: "shelf" | "workbench") => void;
  setPage: (page: number) => void;
  refetch: () => void;
  openNovel: (id: string) => void;
  openCockpit: (id: string) => void;
  openCover: (id: string) => void;
  download: (input: { novelId: string; novelTitle: string }) => void;
  remove: (id: string, title: string, options?: { confirmed?: boolean }) => void;
  downloadPendingId: string | null;
  deletePendingId: string | null;
}

export default function NovelList({ render }: { render?: (model: NovelListPresentation) => ReactNode } = {}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const storedView = typeof window !== "undefined" ? window.localStorage.getItem("novel-list-view") : null;
  const initialView = searchParams.get("view") === "workbench" || searchParams.get("view") === "shelf"
    ? searchParams.get("view") as "shelf" | "workbench"
    : storedView === "workbench" ? "workbench" : "shelf";
  const initialStatus = (["all", "draft", "published"].includes(searchParams.get("status") ?? "")
    ? searchParams.get("status")
    : "all") as StatusFilter;
  const initialWritingMode = (["all", "original", "continuation"].includes(searchParams.get("writingMode") ?? "")
    ? searchParams.get("writingMode")
    : "all") as WritingModeFilter;
  const initialNarrativeForm = (["all", "short_story", "long_novel"].includes(searchParams.get("narrativeForm") ?? "")
    ? searchParams.get("narrativeForm")
    : "all") as "all" | "short_story" | "long_novel";
  const initialSort = (["updated", "created", "progress"].includes(searchParams.get("sort") ?? "")
    ? searchParams.get("sort")
    : "updated") as "updated" | "created" | "progress";
  const initialSearch = searchParams.get("q")?.trim() ?? "";
  const [view, setView] = useState<"shelf" | "workbench">(initialView);
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [writingMode, setWritingMode] = useState<WritingModeFilter>(initialWritingMode);
  const [narrativeForm, setNarrativeForm] = useState<"all" | "short_story" | "long_novel">(initialNarrativeForm);
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [sort, setSort] = useState<"updated" | "created" | "progress">(initialSort);
  const [cockpitNovelId, setCockpitNovelId] = useState<string | null>(null);
  const [coverNovelId, setCoverNovelId] = useState<string | null>(null);
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get("page") || "1") || 1));
  const { candidateCount: recoveryCandidateCount, openDialog: openRecoveryDialog } = useTaskRecovery();
  const effectiveSearch = render || view === "shelf" ? search : "";
  const effectiveNarrativeForm = render || view === "shelf" ? narrativeForm : "all";
  const effectiveSort = render || view === "shelf" ? sort : "updated";

  const novelListQuery = useQuery({
    queryKey: [...queryKeys.novels.list(page, NOVEL_LIST_PAGE_SIZE), view, effectiveSearch, status, writingMode, effectiveNarrativeForm, effectiveSort],
    queryFn: () => getNovelList({
      page,
      limit: NOVEL_LIST_PAGE_SIZE,
      search: effectiveSearch,
      status,
      writingMode,
      narrativeForm: effectiveNarrativeForm,
      sort: effectiveSort,
    }),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const items = query.state.data?.data?.items ?? [];
      return items.some((novel) => {
        const task = novel.narrativeForm === "short_story"
          ? novel.latestCreationStudioTask
          : novel.latestAutoDirectorTask;
        return task?.status === "queued" || task?.status === "running" || task?.status === "waiting_approval";
      })
        ? 4000
        : false;
    },
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [view, search, status, writingMode, narrativeForm, sort]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const assign = (key: string, value: string, fallback: string) => {
      if (!value || value === fallback) next.delete(key);
      else next.set(key, value);
    };
    assign("view", view, "shelf");
    assign("status", status, "all");
    assign("writingMode", writingMode, "all");
    assign("narrativeForm", narrativeForm, "all");
    assign("sort", sort, "updated");
    assign("q", search, "");
    assign("page", String(page), "1");
    const current = searchParams.toString();
    const upcoming = next.toString();
    if (current !== upcoming) {
      setSearchParams(next, { replace: true });
    }
  }, [narrativeForm, page, search, searchParams, setSearchParams, sort, status, view, writingMode]);

  const cockpitProjectionQuery = useQuery({
    queryKey: cockpitNovelId
      ? queryKeys.novels.directorBookAutomation(cockpitNovelId)
      : ["novels", "director-book-automation", "idle"],
    queryFn: () => getDirectorBookAutomationProjection(cockpitNovelId ?? ""),
    enabled: Boolean(cockpitNovelId),
    staleTime: 10_000,
    refetchInterval: (query) => {
      return query.state.data?.data?.projection.displayState === "processing" ? 4000 : false;
    },
  });

  const deleteNovelMutation = useMutation({
    mutationFn: (id: string) => deleteNovel(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.novels.all });
      toast.success("小说已删除。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "删除小说失败。");
    },
  });

  const downloadNovelMutation = useMutation({
    mutationFn: (input: { novelId: string; novelTitle: string }) => downloadNovelExport(
      input.novelId,
      "txt",
      "full",
      input.novelTitle,
    ),
    onSuccess: ({ blob, fileName }) => {
      createDownload(blob, fileName);
      toast.success("导出已开始。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "导出小说失败。");
    },
  });

  const continueWorkflowMutation = useMutation({
    mutationFn: async (input: {
      taskId: string;
      mode?: DirectorContinuationMode;
    }) => continueNovelWorkflow(input.taskId, input.mode ? { continuationMode: input.mode } : undefined),
    onSuccess: async (response, input) => {
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: queryKeys.novels.all }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ];
      if (cockpitNovelId) {
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: queryKeys.novels.directorBookAutomation(cockpitNovelId) }),
        );
      }
      await Promise.all(invalidations);
      const feedback = resolveWorkflowContinuationFeedback(response.data, {
        mode: input.mode,
      });
      if (feedback.tone === "error") {
        toast.error(feedback.message);
        return;
      }
      toast.success(feedback.message);
    },
    onError: (error, input) => {
      toast.error(
        error instanceof Error
          ? error.message
          : input.mode === "auto_execute_range"
            ? "继续自动执行当前章节范围失败。"
            : "继续自动导演失败。",
      );
    },
  });

  const allNovels = novelListQuery.data?.data?.items ?? [];
  const totalPages = novelListQuery.data?.data?.totalPages ?? 1;
  const totalNovels = novelListQuery.data?.data?.total ?? 0;
  const selectedCockpitNovel = allNovels.find((item) => item.id === cockpitNovelId) ?? null;
  const cockpitProjection = cockpitProjectionQuery.data?.data?.projection ?? null;

  const novels = allNovels;
  const summary = useMemo(() => buildNovelListSummary(allNovels), [allNovels]);

  useEffect(() => {
    if (page > Math.max(1, totalPages)) {
      setPage(Math.max(1, totalPages));
    }
  }, [page, totalPages]);

  const handleDelete = (novelId: string, title: string, options?: { confirmed?: boolean }) => {
    if (!options?.confirmed) {
      const confirmed = window.confirm(`确认删除《${title}》吗？该操作会直接删除当前小说。`);
      if (!confirmed) {
        return;
      }
    }
    deleteNovelMutation.mutate(novelId);
  };

  const openNovelEditor = (novelId: string) => {
    const novel = allNovels.find((item) => item.id === novelId);
    if (!novel) {
      navigate(`/novels/${novelId}/edit`);
      return;
    }
    navigate(getNovelWorkspaceHref(novel));
  };

  const handleViewChange = (nextView: "shelf" | "workbench") => {
    setView(nextView);
    window.localStorage.setItem("novel-list-view", nextView);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("view", nextView);
      return next;
    }, { replace: true });
  };

  const coverNovel = coverNovelId ? allNovels.find((item) => item.id === coverNovelId) ?? null : null;
  const continueNovels = useMemo(
    () => novels.filter((novel) => {
      const task = getNovelWorkflowTask(novel);
      return task?.status === "running" || task?.status === "waiting_approval";
    }).slice(0, 3),
    [novels],
  );
  const coverBasicForm = useMemo<NovelBasicFormState | null>(() => {
    if (!coverNovel) return null;
    const base = createDefaultNovelBasicFormState();
    return {
      ...base,
      title: coverNovel.title,
      description: coverNovel.description ?? "",
      targetAudience: coverNovel.targetAudience ?? "",
      bookSellingPoint: coverNovel.bookSellingPoint ?? "",
      competingFeel: coverNovel.competingFeel ?? "",
      first30ChapterPromise: coverNovel.first30ChapterPromise ?? "",
      status: coverNovel.status,
      writingMode: coverNovel.writingMode,
      projectMode: coverNovel.projectMode ?? base.projectMode,
      writingPlatformPreference: coverNovel.writingPlatform ?? base.writingPlatformPreference,
      narrativePov: coverNovel.narrativePov ?? base.narrativePov,
      pacePreference: coverNovel.pacePreference ?? base.pacePreference,
      styleTone: coverNovel.styleTone ?? "",
      emotionIntensity: coverNovel.emotionIntensity ?? base.emotionIntensity,
      aiFreedom: coverNovel.aiFreedom ?? base.aiFreedom,
      postGenerationStyleReviewEnabled: coverNovel.postGenerationStyleReviewEnabled,
      defaultChapterLength: coverNovel.defaultChapterLength ?? base.defaultChapterLength,
      estimatedChapterCount: coverNovel.estimatedChapterCount ?? base.estimatedChapterCount,
      projectStatus: coverNovel.projectStatus ?? base.projectStatus,
      storylineStatus: coverNovel.storylineStatus ?? base.storylineStatus,
      outlineStatus: coverNovel.outlineStatus ?? base.outlineStatus,
      resourceReadyScore: coverNovel.resourceReadyScore ?? base.resourceReadyScore,
    };
  }, [coverNovel]);

  const handleCockpitAction = (
    projection: DirectorBookAutomationProjection,
    action: DirectorBookAutomationAction,
  ) => {
    const taskId = action.commandPayload?.taskId ?? action.target.taskId ?? projection.latestTask?.id;
    if (taskId && isDirectorCockpitContinuationAction(action)) {
      continueWorkflowMutation.mutate({
        taskId,
        mode: getDirectorCockpitContinuationMode(action),
      });
      return;
    }
    setCockpitNovelId(null);
    navigate(getDirectorCockpitActionHref(projection, action));
  };

  return (
    <div className={render ? "mac-novel-feature" : "space-y-5"}>
      {render ? render({
        novels, total: totalNovels, page, totalPages,
        isPending: novelListQuery.isPending, isError: novelListQuery.isError, isFetching: novelListQuery.isFetching,
        search: searchInput, setSearch: setSearchInput, status, setStatus,
        writingMode, setWritingMode, narrativeForm, setNarrativeForm, sort, setSort,
        view, setView: handleViewChange,
        setPage, refetch: () => { void novelListQuery.refetch(); }, openNovel: openNovelEditor,
        openCockpit: setCockpitNovelId, openCover: setCoverNovelId,
        download: downloadNovelMutation.mutate, remove: handleDelete,
        downloadPendingId: downloadNovelMutation.isPending ? downloadNovelMutation.variables?.novelId ?? null : null,
        deletePendingId: deleteNovelMutation.isPending ? deleteNovelMutation.variables ?? null : null,
      }) : <>
      <NovelListHeader
        page={page}
        totalPages={totalPages}
        totalNovels={totalNovels}
        recoveryCandidateCount={recoveryCandidateCount}
        summary={summary}
        onOpenRecovery={openRecoveryDialog}
        view={view}
        onViewChange={handleViewChange}
      />

      <NovelListFilterBar
        status={status}
        writingMode={writingMode}
        onStatusChange={setStatus}
        onWritingModeChange={setWritingMode}
        view={view}
        search={searchInput}
        onSearchChange={setSearchInput}
        narrativeForm={narrativeForm}
        onNarrativeFormChange={setNarrativeForm}
        sort={sort}
        onSortChange={setSort}
      />

      {novelListQuery.isPending ? (
        <NovelListSkeleton />
      ) : novelListQuery.isError ? (
        <Card>
          <CardHeader>
            <CardTitle>加载小说列表失败</CardTitle>
            <CardDescription>当前无法读取项目列表，可以重试一次。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void novelListQuery.refetch()}>重新加载</Button>
          </CardContent>
        </Card>
      ) : novels.length === 0 ? (
        <NovelListEmptyState hasAnyNovel={allNovels.length > 0} />
      ) : (
        <>
          {view === "shelf" ? (
            <div className="space-y-7">
              {continueNovels.length > 0 ? (
                <section className="space-y-3">
                  <h2 className="text-lg font-semibold">继续创作</h2>
                  <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
                    {continueNovels.map((novel) => (
                      <NovelContinueCard key={`continue-${novel.id}`} novel={novel} onManageCover={setCoverNovelId} onDelete={handleDelete} />
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="space-y-3">
                <h2 className="text-lg font-semibold">我的作品</h2>
                <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
                  {novels.filter((novel) => !continueNovels.some((item) => item.id === novel.id)).map((novel) => (
                    <NovelShelfCard key={novel.id} novel={novel} onManageCover={setCoverNovelId} onDownload={downloadNovelMutation.mutate} onDelete={handleDelete} />
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {novels.map((novel) => (
                <NovelProjectCard
                  key={novel.id}
                  novel={novel}
                  continuePendingTaskId={continueWorkflowMutation.isPending
                    ? continueWorkflowMutation.variables?.taskId ?? null
                    : null}
                  downloadPendingNovelId={downloadNovelMutation.isPending
                    ? downloadNovelMutation.variables?.novelId ?? null
                    : null}
                  deletePendingNovelId={deleteNovelMutation.isPending ? deleteNovelMutation.variables ?? null : null}
                  onOpenNovel={openNovelEditor}
                  onOpenCockpit={setCockpitNovelId}
                  onContinueWorkflow={continueWorkflowMutation.mutate}
                  onDownload={downloadNovelMutation.mutate}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
          <NovelListPagination
            page={page}
            totalPages={totalPages}
            isFetching={novelListQuery.isFetching}
            onPageChange={setPage}
          />
        </>
      )}

      </>}

      {coverNovel && coverBasicForm ? (
        <NovelCoverDialog
          open={Boolean(coverNovelId)}
          novelId={coverNovel.id}
          basicForm={coverBasicForm}
          genreOptions={[]}
          storyModeOptions={[]}
          worldOptions={[]}
          onOpenChange={(open) => {
            if (!open) {
              setCoverNovelId(null);
              void queryClient.invalidateQueries({ queryKey: queryKeys.novels.all });
            }
          }}
        />
      ) : null}

      <Dialog
        open={Boolean(cockpitNovelId)}
        onOpenChange={(open) => {
          if (!open) {
            setCockpitNovelId(null);
          }
        }}
      >
        <AppDialogContent
          className="max-w-2xl"
          title="AI 驾驶舱"
          description={
            selectedCockpitNovel?.title
              ? `查看《${selectedCockpitNovel.title}》的 AI 推进状态和下一步动作。`
              : "查看这本书的 AI 推进状态和下一步动作。"
          }
        >
          {cockpitProjectionQuery.isPending ? (
            <div className="rounded-lg border p-3 text-sm text-muted-foreground">
              读取这本书的 AI 状态...
            </div>
          ) : cockpitProjectionQuery.isError ? (
            <div className="rounded-lg border p-3">
              <div className="text-sm text-muted-foreground">无法读取这本书的 AI 状态，请稍后重试。</div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => void cockpitProjectionQuery.refetch()}
              >
                重新读取
              </Button>
            </div>
          ) : cockpitProjection ? (
            <AICockpit
              projection={cockpitProjection}
              mode="focusedNovel"
              isActionPending={continueWorkflowMutation.isPending}
              onAction={handleCockpitAction}
              onOpenNovel={(projection) => {
                setCockpitNovelId(null);
                navigate(projection.focusNovel.href);
              }}
            />
          ) : (
            <AICockpit fallbackSummary="这本书没有需要处理的 AI 自动推进任务。" />
          )}
        </AppDialogContent>
      </Dialog>
    </div>
  );
}

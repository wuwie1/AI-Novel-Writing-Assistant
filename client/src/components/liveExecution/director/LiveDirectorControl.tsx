import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatch } from "react-router-dom";
import { Pause, Play } from "lucide-react";
import { createDirectorCommandKey, getDirectorSummary, submitDirectorCommand } from "@/api/directorNext";
import { getNovelDetail } from "@/api/novel";
import { getDirectorBookAutomationProjection, pauseDirectorTask } from "@/api/novelDirector";
import { continueNovelWorkflow } from "@/api/novelWorkflow";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { useDirectorCharacterCandidates } from "@/components/directorNext/characters/DirectorCharacterCandidates";
import { getNovelWorkspaceHref } from "@/lib/novelRoutes";
import { currentDirectorAction, legacyDirectorAction } from "./control";

type Action = "pause" | "resume";

function ControlRow({ title, status, action, execute, refresh, recoveryLink }: {
  title: string;
  status: string;
  action: Action | null;
  execute: (action: Action) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  recoveryLink: ReactNode;
}) {
  const command = useMutation({ mutationFn: execute, onSettled: refresh, retry: false });
  const pending = command.isPending;
  return (
    <section aria-label="本书自动导演" className="shrink-0 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-100">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium" title={title}>《{title}》 · 自动导演</p>
          <p className="mt-0.5 line-clamp-2 text-emerald-100/70" title={status} role="status">{status}</p>
        </div>
        {action ? <Button type="button" size="sm" variant="ghost" disabled={pending}
          className="h-8 shrink-0 gap-1.5 text-emerald-200 hover:bg-emerald-400/10 hover:text-emerald-50"
          onClick={() => command.mutate(action)}>
          {action === "pause" ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {pending ? "处理中…" : action === "pause" ? "暂停生成" : "继续生成"}
        </Button> : recoveryLink}
      </div>
      {command.isError && <p role="alert" className="mt-1 text-amber-200">
        {command.error instanceof Error ? command.error.message : "暂时无法操作，请重新读取任务进度。"}
      </p>}
    </section>
  );
}

interface BookProps { novelId: string; title: string; taskId?: string | null; onOpenSource: () => void }

function CurrentDirectorControl({ novelId, title, taskId, onOpenSource }: BookProps) {
  const client = useQueryClient();
  const keys = queryKeys.directorNext;
  const query = useQuery({ queryKey: keys.summary(novelId), queryFn: () => getDirectorSummary(novelId),
    refetchInterval: 4000, retry: false });
  const summary = query.data?.data;
  const view = summary?.novelId === novelId && (!taskId || taskId === summary.runId) ? summary : null;
  const proposed = view ? currentDirectorAction(view) : null;
  const candidates = useDirectorCharacterCandidates(view?.runId ?? "", proposed === "resume");
  if (query.isError) return <ReadError retry={query.refetch} />;
  if (!view) return null;
  if (proposed === "resume" && candidates.isError) return <ReadError retry={candidates.refetch} />;
  if (proposed === "resume" && candidates.isPending) return null;
  const reviewCharacters = proposed === "resume" && candidates.data?.data?.reviews.some(review => review.blocking);
  const action = reviewCharacters ? null : proposed;
  if (!action && view.mode !== "paused") return null;
  return <ControlRow key={view.runId} title={title} action={action}
    status={reviewCharacters ? "请先在导演台确认本章人物。" : action === "resume" ? "已暂停，可从保存进度继续。" : view.headline}
    recoveryLink={<Link className="shrink-0 underline" to={view.sourceRoute} onClick={onOpenSource}>查看暂停事项</Link>}
    execute={type => submitDirectorCommand({type, runId: view.runId, expectedVersion: view.sourceTrace.controlVersion,
      idempotencyKey: createDirectorCommandKey()})}
    refresh={() => Promise.all([keys.summary(novelId), keys.detail(novelId), keys.runs(false), keys.runs(true)]
      .map(queryKey => client.invalidateQueries({queryKey})))}
  />;
}

function LegacyDirectorControl({ novelId, title, taskId, onOpenSource }: BookProps) {
  const client = useQueryClient();
  const keys = queryKeys.novels;
  const query = useQuery({queryKey: keys.directorBookAutomation(novelId), queryFn: () => getDirectorBookAutomationProjection(novelId),
    refetchInterval: 4000, retry: false});
  const projection = query.data?.data?.projection;
  if (query.isError) return <ReadError retry={query.refetch} />;
  const task = projection?.latestTask;
  if (!projection || !task || projection.novelId !== novelId || (taskId && taskId !== task.id)) return null;
  const action = legacyDirectorAction(projection);
  if (!action && !task.pendingManualRecovery) return null;
  return <ControlRow key={task.id} title={title} action={action}
    status={task.pendingManualRecovery ? task.lastError || projection.userReason || projection.userHeadline : projection.userHeadline}
    recoveryLink={<Link className="shrink-0 underline" to={projection.focusNovel.href} onClick={onOpenSource}>查看暂停事项</Link>}
    execute={type => type === "pause" ? pauseDirectorTask(task.id) : continueNovelWorkflow(task.id, {continuationMode: "resume"})}
    refresh={() => Promise.all([keys.directorBookAutomation(novelId), keys.autoDirectorTask(novelId), keys.simpleShelf(novelId),
      queryKeys.tasks.directorRuntime(task.id), queryKeys.tasks.directorTaskSnapshot(task.id)]
      .map(queryKey => client.invalidateQueries({queryKey})))}
  />;
}

function ReadError({retry}: {retry: () => Promise<unknown>}) {
  return <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-amber-200">
    无法读取本书任务。<button type="button" className="underline" onClick={() => void retry()}>重新读取</button>
  </div>;
}

export function LiveDirectorControl({ sessionNovelId, taskId, onOpenSource }: {
  sessionNovelId?: string | null;
  taskId?: string | null;
  onOpenSource: () => void;
}) {
  const director = useMatch("/lab/director/:id");
  const editor = useMatch("/novels/:id/edit");
  const shelf = useMatch("/novels/:id/simple");
  const chapter = useMatch("/novels/:id/chapters/:chapterId");
  const sourceId = (director ?? editor ?? shelf ?? chapter)?.params.id;
  const preview = director?.params.id === "preview";
  const novelId = sourceId || sessionNovelId;
  const query = useQuery({ queryKey: queryKeys.novels.detail(novelId ?? ""), queryFn: () => getNovelDetail(novelId!),
    enabled: Boolean(novelId) && !preview, staleTime: 30_000, retry: false });
  const book = query.data?.data;
  if (preview || !novelId) return null;
  if (query.isError) return sourceId ? <ReadError retry={query.refetch} /> : null;
  if (!book || book.id !== novelId || book.narrativeForm === "short_story") return null;
  if (!sourceId) return <Link className="px-3 py-2 text-xs text-emerald-200 underline" to={getNovelWorkspaceHref(book)}>
    打开《{book.title}》工作台
  </Link>;
  const props = {novelId, title: book.title, taskId, onOpenSource};
  if (book.directorVersion === "v2") return <CurrentDirectorControl key={novelId} {...props} />;
  if (book.directorVersion === "v1") return <LegacyDirectorControl key={novelId} {...props} />;
  return null;
}

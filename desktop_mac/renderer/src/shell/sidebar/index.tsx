import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronsUpDown } from "lucide-react";
import { getNovelChapters, getNovelDetail, getNovelList } from "@/api/novel";
import { listCreativeHubThreads } from "@/api/creativeHub";
import { listDirectorRuns } from "@/api/directorNext";
import { listDramaProjects } from "@/api/drama";
import { listComicProjects } from "@/api/comic";
import { queryKeys } from "@/api/queryKeys";
import { getNovelWorkspaceHref } from "@/lib/novelRoutes";
import { readTaskStatus, taskStatusOptions } from "../../features/tasks";
import { pathIsWithin, type MacNavigation, type NavigationLink } from "../navigation";

function SidebarLinks({ links }: { links: readonly NavigationLink[] }) {
  const { pathname } = useLocation();
  const selected = [...links].sort(([a], [b]) => b.length - a.length).find(([to]) => pathIsWithin(pathname, to))?.[0];
  return <>{links.map(([to, label]) => <Link key={to} to={to} className={`mac-list-row${selected === to ? " is-selected" : ""}`} aria-current={selected === to ? "page" : undefined}><span>{label}</span></Link>)}</>;
}

function ListState({ pending, error, empty, emptyText }: { pending: boolean; error: boolean; empty: boolean; emptyText: string }) {
  if (pending) return <p className="mac-list-message" role="status">正在读取列表…</p>;
  if (error) return <p className="mac-list-message" role="status">列表暂时无法读取，请稍后重试。</p>;
  return empty ? <p className="mac-list-message">{emptyText}</p> : null;
}

function NovelList() {
  const query = useQuery({ queryKey: ["novels", "mac-sidebar"], queryFn: () => getNovelList({ page: 1, limit: 100, sort: "updated" }), staleTime: 30_000 });
  const novels = query.data?.data?.items ?? [];
  return <>
    <SidebarLinks links={[["/novels", "全部作品"], ["/create", "新建小说"]]} />
    <div className="mac-list-label">最近更新</div>
    <ListState pending={query.isPending} error={query.isError} empty={!novels.length} emptyText="创建小说后可在这里继续写作。" />
    {novels.map((novel) => <Link key={novel.id} className="mac-list-row" to={getNovelWorkspaceHref(novel)}><BookOpen size={14}/><span>{novel.title}</span></Link>)}
  </>;
}

function NovelContents({ context }: { context: MacNavigation }) {
  const [choosingBook, setChoosingBook] = useState(false);
  const { key } = useLocation();
  useEffect(() => { setChoosingBook(false); }, [key]);
  const id = context.novelId!;
  const detail = useQuery({ queryKey: queryKeys.novels.detail(id), queryFn: () => getNovelDetail(id), staleTime: 30_000 });
  const chapters = useQuery({ queryKey: queryKeys.novels.chapters(id), queryFn: () => getNovelChapters(id), staleTime: 30_000 });
  const novel = detail.data?.data;
  const items = chapters.data?.data ?? [];
  return <>
    <button className="mac-current-book" onClick={() => setChoosingBook((value) => !value)} title="选择小说" aria-expanded={choosingBook}><BookOpen size={16}/><span>{novel?.title ?? "当前小说"}</span><ChevronsUpDown size={14}/></button>
    {choosingBook ? <NovelList/> : <>
      <SidebarLinks links={[[novel ? getNovelWorkspaceHref(novel) : `/novels/${encodeURIComponent(id)}/edit`, "作品工作台"], [`/novels/${encodeURIComponent(id)}/preview`, "阅读预览"], [`/novels/${encodeURIComponent(id)}/ai-usage`, "AI 用量"]]} />
      <div className="mac-list-label">章节目录</div>
      <ListState pending={chapters.isPending} error={chapters.isError} empty={!items.length} emptyText="这本小说还没有章节。" />
      {items.map((chapter) => <Link key={chapter.id} to={`/novels/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter.id)}`} className={`mac-list-row${chapter.id === context.chapterId ? " is-selected" : ""}`} aria-current={chapter.id === context.chapterId ? "page" : undefined}><span>{chapter.order}</span><span>{chapter.title || "未命名章节"}</span></Link>)}
    </>}
  </>;
}

function CreativeConversations() {
  const { search } = useLocation();
  const activeId = new URLSearchParams(search).get("threadId");
  const query = useQuery({ queryKey: queryKeys.creativeHub.threads, queryFn: listCreativeHubThreads, staleTime: 15_000 });
  const threads = query.data?.data ?? [];
  return <>
    <div className="mac-list-label">对话</div>
    <ListState pending={query.isPending} error={query.isError} empty={!threads.length} emptyText="在创作中枢开始对话，和 AI 一起构思。" />
    {threads.map((thread) => <Link key={thread.id} to={`/creative-hub?threadId=${encodeURIComponent(thread.id)}`} className={`mac-list-row${activeId === thread.id ? " is-selected" : ""}`} aria-current={activeId === thread.id ? "page" : undefined}><span>{thread.title || "创作对话"}</span></Link>)}
  </>;
}

function DirectorRecords({ context }: { context: MacNavigation }) {
  const query = useQuery({ queryKey: queryKeys.directorNext.runs(false), queryFn: () => listDirectorRuns({ needsAttention: false, limit: 50 }), staleTime: 15_000, retry: false });
  const items = query.data?.data ?? [];
  return <>
    <SidebarLinks links={context.links ?? []}/><div className="mac-list-label">最近创作</div>
    <ListState pending={query.isPending} error={query.isError} empty={!items.length} emptyText="开始 AI 创作后，可在这里查看进度。" />
    {items.map((item) => <Link key={item.runId} to={item.directorRoute} className="mac-list-row mac-detail-row"><strong>{item.headline}</strong><small>{item.statusLabel} · {item.progressLabel}</small></Link>)}
  </>;
}

function ProjectList({ section }: { section: "drama" | "comic" }) {
  const drama = useQuery({ queryKey: queryKeys.drama.projects, queryFn: listDramaProjects, enabled: section === "drama", staleTime: 30_000 });
  const comic = useQuery({ queryKey: ["comic", "projects"], queryFn: listComicProjects, enabled: section === "comic", staleTime: 30_000 });
  const query = section === "drama" ? drama : comic;
  const items = section === "drama" ? drama.data?.data ?? [] : comic.data ?? [];
  return <>
    <SidebarLinks links={[[`/${section}`, "全部项目"]]}/><div className="mac-list-label">项目</div>
    <ListState pending={query.isPending} error={query.isError} empty={!items.length} emptyText="创建项目后可在这里继续制作。" />
    <SidebarLinks links={items.map((item) => [`/${section}/projects/${encodeURIComponent(item.id)}`, item.title])}/>
  </>;
}

function TaskFilters() {
  const { search } = useLocation();
  const status = readTaskStatus(new URLSearchParams(search));
  return <>
    <div className="mac-list-label">按状态查看</div>
    {taskStatusOptions.map(([value, label]) => <Link key={value} to={value ? `/tasks?status=${value}` : "/tasks"} className={`mac-list-row${status === value ? " is-selected" : ""}`} aria-current={status === value ? "page" : undefined}><span>{label}</span></Link>)}
    <p className="mac-list-message">查看记录后，打开对应创作页面处理后续事项。</p>
  </>;
}

/** 每种列表只挂载自己的读取器，切换全局菜单后不保留章节查询。 */
export function MacSidebarContent({ context }: { context: MacNavigation }) {
  switch (context.section) {
    case "shelf": return <NovelList/>;
    case "novel": return <NovelContents key={context.novelId} context={context}/>;
    case "creative": return <CreativeConversations/>;
    case "director": return <DirectorRecords context={context}/>;
    case "tasks": return <TaskFilters/>;
    case "drama": case "comic": return <ProjectList section={context.section}/>;
    default: return <SidebarLinks links={context.links ?? []}/>;
  }
}

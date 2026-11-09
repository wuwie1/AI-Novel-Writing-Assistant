import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getNovelChapters, getNovelDetail } from "@/api/novel";
import { listCreativeHubThreads } from "@/api/creativeHub";
import { listDirectorRuns } from "@/api/directorNext";
import { listDramaProjects } from "@/api/drama";
import { listComicProjects } from "@/api/comic";
import { queryKeys } from "@/api/queryKeys";
import { getNovelWorkspaceHref } from "@/lib/novelRoutes";
import { NOVEL_WORKSPACE_FLOW_STEPS } from "@/pages/novels/novelWorkspaceNavigation";
import { pathIsWithin, type MacNavigation, type NavigationLink } from "../navigation";

// 列表搜索只筛选已加载的展示数据，不参与 AI 意图识别或后端任务路由。
function matchesSearch(search: string, ...values: Array<string | number | undefined | null>) {
  const needle = search.trim().toLocaleLowerCase();
  return values.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
}

function SidebarLinks({ links, search = "" }: { links: readonly NavigationLink[]; search?: string }) {
  const { pathname } = useLocation();
  const selected = [...links].sort(([a], [b]) => b.length - a.length).find(([to]) => pathIsWithin(pathname, to))?.[0];
  const visible = links.filter(([, label]) => matchesSearch(search, label));
  return <>{visible.map(([to, label]) => <Link key={to} to={to} className={`mac-list-row${selected === to ? " is-selected" : ""}`} aria-current={selected === to ? "page" : undefined}><span>{label}</span></Link>)}{search.trim() && !visible.length ? <p className="mac-list-message">未找到匹配的条目。</p> : null}</>;
}

function ListState({ pending, error, empty, emptyText }: { pending: boolean; error: boolean; empty: boolean; emptyText: string }) {
  if (pending) return <p className="mac-list-message" role="status">正在读取列表…</p>;
  if (error) return <p className="mac-list-message" role="status">列表暂时无法读取，请稍后重试。</p>;
  return empty ? <p className="mac-list-message">{emptyText}</p> : null;
}

function NovelContents({ context, search }: { context: MacNavigation; search: string }) {
  const location = useLocation();
  const { pathname, search: locationSearch } = location;
  const id = context.novelId!;
  const detail = useQuery({ queryKey: queryKeys.novels.detail(id), queryFn: () => getNovelDetail(id), staleTime: 15_000, refetchOnWindowFocus: true });
  const chapters = useQuery({ queryKey: queryKeys.novels.chapters(id), queryFn: () => getNovelChapters(id), staleTime: 15_000, refetchOnWindowFocus: true });
  const novel = detail.data?.data;
  const items = (chapters.data?.data ?? []).filter((chapter) => matchesSearch(search, chapter.title, chapter.order));
  const editBase = `/novels/${encodeURIComponent(id)}/edit`;
  const activeStage = pathname.includes("/chapters/")
    ? "chapter"
    : new URLSearchParams(locationSearch).get("stage") || (pathname.endsWith("/edit") ? "basic" : "");
  const stageLinks = NOVEL_WORKSPACE_FLOW_STEPS
    .map((step, index) => ({ to: `${editBase}?stage=${step.key}`, label: step.label, stage: step.key, order: index + 1 }))
    .filter((item) => matchesSearch(search, item.label));
  return <>
    <Link className="mac-current-book" to="/novels">{novel?.title ?? "返回书架"}</Link>
    <>
      <SidebarLinks links={[
        [novel ? getNovelWorkspaceHref(novel) : editBase, "作品工作台"],
        [`/novels/${encodeURIComponent(id)}/preview`, "阅读预览"],
        [`/novels/${encodeURIComponent(id)}/ai-usage`, "AI 用量"],
        [`/lab/director/${encodeURIComponent(id)}`, "AI 驾驶舱"],
        [`${editBase}?stage=history`, "版本历史"],
      ]} />
      <div className="mac-list-label">写作步骤</div>
      {stageLinks.map((item) => {
        const selected = activeStage === item.stage;
        // An open chapter is the current page; its writing step is only the enclosing step.
        const withinChapter = selected && Boolean(context.chapterId);
        return <Link key={item.to} to={item.to} className={`mac-list-row${selected ? withinChapter ? " is-within" : " is-selected" : ""}`} aria-current={selected ? withinChapter ? "step" : "page" : undefined}><span className="mac-chapter-order">{item.order}</span><span>{item.label}</span></Link>;
      })}
      {search.trim() && !stageLinks.length ? <p className="mac-list-message">未找到匹配的写作步骤。</p> : null}
      <div className="mac-list-label">章节目录</div>
      <ListState pending={chapters.isPending} error={chapters.isError} empty={!items.length} emptyText={search.trim() ? "未找到匹配的章节。" : "这本小说还没有章节。"} />
      {items.map((chapter) => <Link key={chapter.id} to={`/novels/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter.id)}`} className={`mac-list-row${chapter.id === context.chapterId ? " is-selected" : ""}`} aria-current={chapter.id === context.chapterId ? "page" : undefined}><span className="mac-chapter-order">{chapter.order}</span><span>{chapter.title || "未命名章节"}</span></Link>)}
    </>
  </>;
}

function CreativeConversations({ search }: { search: string }) {
  const location = useLocation();
  const activeId = new URLSearchParams(location.search).get("threadId");
  const query = useQuery({ queryKey: queryKeys.creativeHub.threads, queryFn: listCreativeHubThreads, staleTime: 15_000 });
  const threads = (query.data?.data ?? []).filter((thread) => matchesSearch(search, thread.title || "创作对话"));
  return <>
    <div className="mac-list-label">对话</div>
    <ListState pending={query.isPending} error={query.isError} empty={!threads.length} emptyText={search.trim() ? "未找到匹配的对话。" : "在创作中枢开始对话，和 AI 一起构思。"} />
    {threads.map((thread) => <Link key={thread.id} to={`/creative-hub?threadId=${encodeURIComponent(thread.id)}`} className={`mac-list-row${activeId === thread.id ? " is-selected" : ""}`} aria-current={activeId === thread.id ? "page" : undefined}><span>{thread.title || "创作对话"}</span></Link>)}
  </>;
}

function DirectorRecords({ context, search }: { context: MacNavigation; search: string }) {
  const query = useQuery({ queryKey: queryKeys.directorNext.runs(false), queryFn: () => listDirectorRuns({ needsAttention: false, limit: 50 }), staleTime: 15_000, retry: false });
  const items = (query.data?.data ?? []).filter((item) => matchesSearch(search, item.headline, item.statusLabel));
  return <>
    <SidebarLinks links={context.links ?? []}/><div className="mac-list-label">最近创作</div>
    <ListState pending={query.isPending} error={query.isError} empty={!items.length} emptyText={search.trim() ? "未找到匹配的创作记录。" : "开始 AI 创作后，可在这里查看进度。"} />
    {items.map((item) => <Link key={item.runId} to={item.directorRoute} className="mac-list-row mac-detail-row"><strong>{item.headline}</strong><small>{item.statusLabel} · {item.progressLabel}</small></Link>)}
  </>;
}

function ProjectList({ section, search }: { section: "drama" | "comic"; search: string }) {
  const drama = useQuery({ queryKey: queryKeys.drama.projects, queryFn: listDramaProjects, enabled: section === "drama", staleTime: 30_000 });
  const comic = useQuery({ queryKey: ["comic", "projects"], queryFn: listComicProjects, enabled: section === "comic", staleTime: 30_000 });
  const query = section === "drama" ? drama : comic;
  const items = (section === "drama" ? drama.data?.data ?? [] : comic.data ?? []).filter((item) => matchesSearch(search, item.title));
  return <>
    <SidebarLinks links={[[`/${section}`, "全部项目"]]}/><div className="mac-list-label">项目</div>
    <ListState pending={query.isPending} error={query.isError} empty={!items.length} emptyText={search.trim() ? "未找到匹配的项目。" : "创建项目后可在这里继续制作。"} />
    <SidebarLinks links={items.map((item) => [`/${section}/projects/${encodeURIComponent(item.id)}`, item.title])}/>
  </>;
}

/** 每种列表只挂载自己的读取器，切换全局菜单后不保留章节查询。 */
export function MacSidebarContent({ context, search }: { context: MacNavigation; search: string }) {
  switch (context.section) {
    case "novel": return <NovelContents key={context.novelId} context={context} search={search}/>;
    case "creative": return <CreativeConversations search={search}/>;
    case "director": return <DirectorRecords context={context} search={search}/>;
    case "drama": case "comic": return <ProjectList section={context.section} search={search}/>;
    default: return <SidebarLinks links={context.links ?? []} search={search}/>;
  }
}

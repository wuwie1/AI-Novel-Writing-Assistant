import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, matchPath } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen, CircleHelp, FilePlus2, FolderOpen,
  MoreHorizontal, Settings2, Sparkles, Workflow, X, ScrollText, ChevronsUpDown,
} from "lucide-react";
import { getNovelChapters, getNovelDetail, getNovelList } from "@/api/novel";

import { getNovelWorkspaceHref } from "@/lib/novelRoutes";
import { macEnvironment } from "../platform/native";

const primaryItems = [
  { to: "/create", label: "新建", Icon: FilePlus2 },
  { to: "/novels", label: "书架", Icon: BookOpen },
  { to: "/creative-hub", label: "创作中枢", Icon: Sparkles },
  { to: "/lab/director", label: "导演", Icon: Workflow },
  { to: "/tasks", label: "运行记录", Icon: ScrollText },
];
const moreItems = [
  ["/book-analysis", "书籍分析"], ["/market-radar", "市场雷达"], ["/knowledge", "知识库"],
  ["/genres", "题材"], ["/story-modes", "故事模式"], ["/titles", "标题工坊"],
  ["/prompt-workbench", "提示词工作台"], ["/anti-ai-rules", "写作规则"], ["/worlds", "世界设定"],
  ["/style-engine", "写作风格"], ["/base-characters", "角色素材"], ["/drama", "短剧"],
  ["/comic", "漫画"], ["/auto-director/follow-ups", "导演跟进"],
] as const;

function routeTitle(path: string) {
  if (path.startsWith("/novels/") && path.includes("/chapters/")) return "章节编辑";
  if (path.startsWith("/novels/")) return path.includes("/preview") ? "阅读预览" : "小说工作台";
  return [...primaryItems.map(({ to, label }) => [to, label] as const), ...moreItems,
    ["/settings", "设置"], ["/help", "帮助"]].find(([to]) => path === to || (to !== "/" && path.startsWith(`${to}/`)))?.[1] ?? "创作工作台";
}

function isActive(path: string, to: string) {
  return path === to || (to !== "/" && path.startsWith(`${to}/`));
}

export function MacAppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const matchedNovelId = matchPath("/novels/:id/*", location.pathname)?.params.id ?? matchPath("/lab/director/:id", location.pathname)?.params.id;
  const routeNovelId = matchedNovelId && !["create", "auto-director"].includes(matchedNovelId) ? matchedNovelId : undefined;
  const [selectedNovelId, setSelectedNovelId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [secondaryCollapsed, setSecondaryCollapsed] = useState(false);
  const [choosingBook, setChoosingBook] = useState(false);
  const mode = macEnvironment()?.mode;
  const novelsQuery = useQuery({ queryKey: ["mac-shell", "novels"], queryFn: () => getNovelList({ page: 1, limit: 100, sort: "updated" }), staleTime: 60_000 });
  const activeNovelId = routeNovelId ?? selectedNovelId;
  const detailQuery = useQuery({ queryKey: ["mac-shell", "novel-detail", activeNovelId], queryFn: () => getNovelDetail(activeNovelId!), enabled: Boolean(activeNovelId), staleTime: 60_000 });
  const chaptersQuery = useQuery({ queryKey: ["mac-shell", "chapters", activeNovelId], queryFn: () => getNovelChapters(activeNovelId!), enabled: Boolean(activeNovelId) && !location.pathname.includes("/chapters/"), staleTime: 60_000 });
  const novels = novelsQuery.data?.data?.items ?? [];
  const activeNovel = detailQuery.data?.data ?? novels.find((novel) => novel.id === activeNovelId);
  const chapters = chaptersQuery.data?.data ?? [];
  const inChapterEditor = location.pathname.includes("/chapters/");
  const title = useMemo(() => routeTitle(location.pathname), [location.pathname]);

  useEffect(() => {
    if (routeNovelId) setSelectedNovelId(routeNovelId);
  }, [routeNovelId]);
  useEffect(() => {
    if (!moreOpen && !drawerOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setMoreOpen(false); setDrawerOpen(false); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [moreOpen, drawerOpen]);

  const secondary = (
    <aside className={`mac-secondary${drawerOpen ? " is-open" : ""}`} aria-label="小说与章节">
      <div className="mac-secondary-head">
        <span>{activeNovel ? "当前小说" : "最近小说"}</span>
        <button className="mac-icon-button mac-secondary-close" aria-label="关闭小说目录" onClick={() => setDrawerOpen(false)}><X size={16} /></button>
      </div>
      {activeNovel ? <button className="mac-current-book" onClick={() => setChoosingBook((value) => !value)} title="选择小说" aria-expanded={choosingBook}>
        <BookOpen size={16} /><span>{activeNovel.title}</span><ChevronsUpDown size={14}/>
      </button> : null}
      {inChapterEditor && !choosingBook ? <div className="mac-list-message">章节导航位于编辑区内。</div> : activeNovelId && !choosingBook ? <div className="mac-chapter-list" aria-label="章节目录">
        <div className="mac-list-label">章节目录</div>
        {chaptersQuery.isPending ? <div className="mac-list-message">正在读取章节…</div> : chaptersQuery.isError ? <div className="mac-list-message" role="status">章节暂时无法读取</div> : chapters.length ? chapters.map((chapter: { id: string; title?: string; order?: number }) => <button key={chapter.id} className="mac-list-row" onClick={() => navigate(`/novels/${activeNovelId}/chapters/${chapter.id}`)}><span>{chapter.order ?? ""}</span><span>{chapter.title || "未命名章节"}</span></button>) : <div className="mac-list-message">这本小说还没有章节</div>}
      </div> : <div className="mac-chapter-list">
        <div className="mac-list-label">{novelsQuery.isPending ? "正在读取小说…" : "小说"}</div>
        {novelsQuery.isError ? <div className="mac-list-message" role="status">小说列表暂时无法读取</div> : novels.length ? novels.slice(0, 30).map((novel) => <button key={novel.id} className={`mac-list-row${selectedNovelId === novel.id ? " is-selected" : ""}`} onClick={() => { navigate(getNovelWorkspaceHref(novel)); setChoosingBook(false); setDrawerOpen(false); }}><BookOpen size={14} /><span>{novel.title}</span></button>) : !novelsQuery.isPending ? <div className="mac-list-message">创建小说后可在这里继续写作</div> : null}
      </div>}
      <div className="mac-secondary-foot"><button className="mac-quiet-button" onClick={() => navigate("/novels")}>查看全部小说</button></div>
    </aside>
  );

  return <div className={`mac-shell${(secondaryCollapsed || inChapterEditor) ? " is-secondary-collapsed" : ""}`}>
    <nav className="mac-icon-rail" aria-label="主导航">
      <div className="mac-rail-primary">{primaryItems.map(({ to, label, Icon }) => <Link key={to} to={to} className={`mac-rail-link${isActive(location.pathname, to) ? " is-active" : ""}`} aria-label={label} aria-current={isActive(location.pathname, to) ? "page" : undefined} title={label} onClick={() => setMoreOpen(false)}><Icon size={17} strokeWidth={1.7} /></Link>)}
        <div className="mac-more-wrap"><button className={`mac-rail-link${moreOpen || moreItems.some(([to]) => isActive(location.pathname, to)) ? " is-active" : ""}`} aria-label="更多功能" aria-expanded={moreOpen} title="更多功能" onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={18} /></button>
          {moreOpen ? <><button className="mac-dismiss" aria-label="关闭更多功能菜单" onClick={() => setMoreOpen(false)} /><div className="mac-more-menu" role="menu" aria-label="更多功能">{moreItems.map(([to, label]) => <Link key={to} role="menuitem" to={to} className={isActive(location.pathname, to) ? "is-active" : ""} onClick={() => setMoreOpen(false)}>{label}</Link>)}</div></> : null}
        </div>
      </div>
      <div className="mac-rail-bottom"><Link to="/settings" className={`mac-rail-link${isActive(location.pathname, "/settings") ? " is-active" : ""}`} aria-label="设置" title="设置"><Settings2 size={17} strokeWidth={1.7} /></Link><Link to="/help" className={`mac-rail-link${isActive(location.pathname, "/help") ? " is-active" : ""}`} aria-label="帮助" title="帮助"><CircleHelp size={17} strokeWidth={1.7} /></Link></div>
    </nav>
    {secondary}
    {drawerOpen ? <button className="mac-drawer-scrim" aria-label="关闭小说目录" onClick={() => setDrawerOpen(false)} /> : null}
    <main className="mac-workspace">
      <header className="mac-toolbar"><button className="mac-icon-button mac-drawer-toggle" aria-label={secondaryCollapsed ? "展开小说与章节目录" : "收起小说与章节目录"} title="小说与章节" onClick={() => { if (window.matchMedia("(max-width: 960px)").matches) setDrawerOpen(true); else setSecondaryCollapsed((collapsed) => !collapsed); }}><FolderOpen size={16} /></button><div className="mac-toolbar-title">{title}</div>{activeNovel ? <button className="mac-toolbar-book" onClick={() => navigate(getNovelWorkspaceHref(activeNovel))}>{activeNovel.title}</button> : null}<span className={`mac-mode-indicator${mode === "local" ? " is-local" : ""}`}><span />{mode === "local" ? "本地测试" : mode === "remote" ? "服务器" : "桌面"}</span></header>
      <section className="mac-canvas" aria-label={title}><Suspense fallback={<div className="mac-loading" role="status">正在打开页面…</div>}><Outlet /></Suspense></section>
    </main>
  </div>;
}

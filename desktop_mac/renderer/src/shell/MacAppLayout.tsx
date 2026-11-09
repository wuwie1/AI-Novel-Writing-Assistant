import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CircleHelp, Plus, PanelLeft, MoreHorizontal, Settings2, Sparkles, Workflow, X, ScrollText } from "lucide-react";
import { VisualAssetLibraryDialog } from "@/components/visualAssets";
import LLMSelector from "@/components/common/LLMSelector";
import { listTasks } from "@/api/tasks";
import { listDirectorRuns } from "@/api/directorNext";
import { queryKeys } from "@/api/queryKeys";
import { EntityListContext, type EntityCollection } from "@/platform";
import { macEnvironment } from "../platform/native";
import { createLinks, moreLinks, pathIsWithin, primaryLinks, resolveMacNavigation } from "./navigation";
import { MacReleaseNotesDialog, MacVersionBadge } from "./MacReleaseNotes";
import { MacSidebarContent } from "./sidebar";

const primaryIcons = [Plus, BookOpen, Sparkles, Workflow, ScrollText];

export function MacAppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const context = resolveMacNavigation(location.pathname, location.search);
  const [moreOpen, setMoreOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ key: string; open: boolean } | null>(null);
  const [entity, setEntity] = useState<EntityCollection | null>(null);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const register = useCallback((value: EntityCollection) => {
    setEntity(value);
    return () => setEntity((current) => current === value ? null : current);
  }, []);
  const [listSearch, setListSearch] = useState("");
  const [visualAssetsOpen, setVisualAssetsOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 960px)").matches);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const attentionTasks = useQuery({
    queryKey: ["mac-rail", "attention-tasks"],
    queryFn: () => listTasks({ status: "waiting_approval", limit: 20 }),
    staleTime: 20_000,
    refetchInterval: 20_000,
  });
  const failedTasks = useQuery({
    queryKey: ["mac-rail", "failed-tasks"],
    queryFn: () => listTasks({ status: "failed", limit: 20 }),
    staleTime: 20_000,
    refetchInterval: 20_000,
  });
  const directorAttention = useQuery({
    queryKey: queryKeys.directorNext.runs(true,20),
    queryFn: () => listDirectorRuns({ needsAttention: true, limit: 20 }),
    staleTime: 20_000,
    refetchInterval: 20_000,
    retry: false,
  });
  const taskBadgeCount = (attentionTasks.data?.data?.items.length ?? 0)
    + (failedTasks.data?.data?.items.length ?? 0);
  const directorBadgeCount = directorAttention.data?.data?.length ?? 0;
  // These workbenches own their document/thread directory. Keep one directory
  // visible initially, while allowing the user to reopen the global navigator.
  const workbench = context.chapterId ? "chapter-editor"
    : context.section === "creative" ? "creative-workbench"
    : context.novelId && context.primary === "/lab/director" ? "director-workbench" : null;
  const legacy = !entity && !location.pathname.startsWith("/worlds/") && !["/knowledge", "/book-analysis", "/market-radar", "/genres", "/story-modes", "/base-characters", "/worlds", "/worlds/generator", "/titles", "/style-engine", "/anti-ai-rules", "/prompt-workbench"].includes(location.pathname) && !["help", "tasks", "create", "shelf", "novel", "director", "creative"].includes(context.section);
  const hasList = !!entity || legacy;
  const title = entity?.title ?? context.sidebarTitle;
  const collapseKey = entity?.collection ?? workbench ?? context.section;
  const drawerKey = JSON.stringify([collapseKey, entity ? entity.selection : location.key]);
  const drawerOpen = narrow && hasList && (drawer?.key === drawerKey ? drawer.open : entity?.selection === null);
  const setDrawerOpen = (open: boolean) => setDrawer({ key: drawerKey, open });
  const host = useMemo(() => ({ target, narrow, register }), [target, narrow, register]);
  const closeDrawer = () => { setDrawerOpen(false); toggle.current?.focus(); };
  const collapsed = collapsedSections[collapseKey] ?? (!entity && Boolean(workbench));
  const mode = macEnvironment()?.mode;

  useEffect(() => {
    if (location.hash === "#visual-assets") {
      setVisualAssetsOpen(true);
      setMoreOpen(false);
    }
  }, [location.hash, location.key]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 960px)");
    const update = () => { setNarrow(query.matches); setDrawer(null); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    // 路由确认成功后才切换列表；取消离开时保留原页面和目录。
    setMoreOpen(false);
  }, [location.key]);
  useEffect(() => { setListSearch(""); }, [context.key]);
  useEffect(() => {
    if (!moreOpen && !drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMoreOpen(false); if (drawerOpen) closeDrawer(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [moreOpen, drawerOpen, drawerKey]);

  return <div className={`mac-shell${!hasList || (!narrow && collapsed) ? " is-secondary-collapsed" : ""}`}>
    <nav className="mac-icon-rail" aria-label="主导航">
      <div className="mac-rail-primary">
        {primaryLinks.map(([to, label], index) => {
          const Icon = primaryIcons[index];
          const active = context.primary === to;
          const badge = to === "/tasks"
            ? taskBadgeCount
            : to === "/lab/director"
              ? directorBadgeCount
              : 0;
          return <Link key={to} to={to} className={`mac-rail-link${index === 0 ? " mac-rail-create" : ""}${active ? " is-active" : ""}`} aria-label={badge > 0 ? `${label}，${badge} 条待处理` : label} aria-current={active ? "page" : undefined} data-tooltip={label} onClick={(event) => {
            if (narrow && active && hasList && location.pathname === to) { event.preventDefault(); setDrawerOpen(!drawerOpen); }
          }}><Icon size={16} strokeWidth={1.5}/>{badge > 0 ? <span className="mac-rail-badge" aria-hidden="true">{badge > 9 ? "9+" : badge}</span> : null}</Link>;
        })}
        <div className="mac-rail-divider" role="separator"/>
        <div className="mac-more-wrap">
          <button className={`mac-rail-link${moreOpen || context.primary === "more" ? " is-active" : ""}`} aria-label="更多功能" aria-expanded={moreOpen} data-tooltip="更多功能" onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={16} strokeWidth={1.5}/></button>
          {moreOpen ? <>
            <button className="mac-dismiss" aria-label="关闭更多功能菜单" onClick={() => setMoreOpen(false)}/>
            <div className="mac-more-menu" role="menu" aria-label="更多功能">{moreLinks.map(([to, label]) => (
              to.startsWith("#")
                ? <button key={to} type="button" role="menuitem" className={visualAssetsOpen ? "is-active" : ""} onClick={() => { setMoreOpen(false); setVisualAssetsOpen(true); }}>{label}</button>
                : <Link key={to} role="menuitem" to={to} className={pathIsWithin(location.pathname, to) ? "is-active" : ""} onClick={() => setMoreOpen(false)}>{label}</Link>
            ))}</div>
          </> : null}
        </div>
      </div>
      <div className="mac-rail-bottom">
        <Link to="/settings" className={`mac-rail-link${context.primary === "/settings" ? " is-active" : ""}`} aria-label="设置" aria-current={context.primary === "/settings" ? "page" : undefined} data-tooltip="设置"><Settings2 size={16} strokeWidth={1.5}/></Link>
        <Link to="/help" className={`mac-rail-link${context.primary === "/help" ? " is-active" : ""}`} aria-label="帮助" aria-current={context.primary === "/help" ? "page" : undefined} data-tooltip="帮助"><CircleHelp size={16} strokeWidth={1.5}/></Link>
      </div>
    </nav>
    <header className="mac-toolbar">
      <div className="mac-toolbar-library">
        {hasList && <button ref={toggle} className="mac-icon-button mac-drawer-toggle" aria-label={`${(narrow ? !drawerOpen : collapsed) ? "展开" : "收起"}${title}`} title={title} aria-expanded={narrow ? drawerOpen : !collapsed} onClick={() => {
          if (narrow) setDrawerOpen(!drawerOpen);
          else setCollapsedSections((current) => ({ ...current, [collapseKey]: !collapsed }));
        }}><PanelLeft size={16} strokeWidth={1.5}/>{narrow ? <span className="mac-drawer-toggle-label">{title}</span> : null}</button>}
        <div className="mac-toolbar-title">{context.title}</div>
      </div>
      <div className="mac-toolbar-model" aria-label="当前创作模型">
        <LLMSelector compact showCompactTemperature showHelperText={false} showBadge={false} />
      </div>
      <span className={`mac-mode-indicator${mode === "local" ? " is-local" : ""}`}><span/>{mode === "local" ? "本地测试" : mode === "remote" ? "服务器" : "桌面"}</span>
      <MacVersionBadge onOpenNotes={() => setReleaseNotesOpen(true)} />
    </header>
    <aside hidden={!hasList} className={`mac-secondary${drawerOpen ? " is-open" : ""}`} aria-label={title} inert={!hasList || (narrow ? !drawerOpen : collapsed)} aria-hidden={!hasList || (narrow ? !drawerOpen : collapsed)}>
      {hasList && narrow && <button className="mac-icon-button mac-secondary-close" aria-label={`关闭${title}`} onClick={closeDrawer}><X size={16}/></button>}
      <div ref={setTarget} className="mac-collection-slot"/>
      {legacy && <>
        <div className="mac-list-tools"><input type="search" aria-label={`搜索${title}`} placeholder={`搜索${title}`} value={listSearch} onChange={(event) => setListSearch(event.target.value)}/></div>
        <div className="mac-context-list" key={context.key}>{!collapsed || drawerOpen ? <MacSidebarContent context={context} search={listSearch}/> : null}</div>
      </>}
    </aside>
    {drawerOpen ? <button className="mac-drawer-scrim" aria-label={`关闭${title}`} onClick={closeDrawer}/> : null}
    <main className="mac-workspace">
      <section className="mac-canvas" aria-label={context.title}>{context.section === "director" && location.pathname !== "/lab/director/preview" && <nav className="mac-view-links" aria-label="导演工作区"><Link to="/lab/director">运行记录</Link><Link to="/auto-director/follow-ups">导演跟进</Link></nav>}{context.section === "create" && <nav className="mac-view-links" aria-label="开始创作">{createLinks.map(([href,label]) => <Link key={href} to={href} aria-current={label === context.title ? "page" : undefined}>{label}</Link>)}</nav>}<Suspense fallback={<div className="mac-loading" role="status">正在打开页面…</div>}><EntityListContext.Provider value={host}><Outlet/></EntityListContext.Provider></Suspense></section>
    </main>
    <VisualAssetLibraryDialog
      open={visualAssetsOpen}
      onOpenChange={(open) => {
        setVisualAssetsOpen(open);
        if (!open && location.hash === "#visual-assets") {
          navigate({ pathname: location.pathname, search: location.search }, { replace: true });
        }
      }}
    />
    <MacReleaseNotesDialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} />
  </div>;
}

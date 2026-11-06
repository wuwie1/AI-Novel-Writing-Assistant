import { Suspense, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { BookOpen, CircleHelp, Plus, PanelLeft, MoreHorizontal, Settings2, Sparkles, Workflow, X, ScrollText } from "lucide-react";
import { macEnvironment } from "../platform/native";
import { moreLinks, pathIsWithin, primaryLinks, resolveMacNavigation } from "./navigation";
import { MacSidebarContent } from "./sidebar";

const primaryIcons = [Plus, BookOpen, Sparkles, Workflow, ScrollText];

export function MacAppLayout() {
  const location = useLocation();
  const context = resolveMacNavigation(location.pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 960px)").matches);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const collapseKey = context.chapterId ? "chapter-editor" : context.section;
  const collapsed = collapsedSections[collapseKey] ?? Boolean(context.chapterId);
  const mode = macEnvironment()?.mode;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 960px)");
    const update = () => { setNarrow(query.matches); setDrawerOpen(false); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    // 路由确认成功后才切换列表；取消离开时保留原页面和目录。
    setMoreOpen(false);
    setDrawerOpen(false);
  }, [location.key]);
  useEffect(() => { setListSearch(""); }, [context.key]);
  useEffect(() => {
    if (!moreOpen && !drawerOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMoreOpen(false); setDrawerOpen(false); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [moreOpen, drawerOpen]);

  return <div className={`mac-shell${collapsed ? " is-secondary-collapsed" : ""}`}>
    <nav className="mac-icon-rail" aria-label="主导航">
      <div className="mac-rail-primary">
        {primaryLinks.map(([to, label], index) => {
          const Icon = primaryIcons[index];
          const active = context.primary === to;
          return <Link key={to} to={to} className={`mac-rail-link${index === 0 ? " mac-rail-create" : ""}${active ? " is-active" : ""}`} aria-label={label} aria-current={active ? "page" : undefined} data-tooltip={label}><Icon size={16} strokeWidth={1.5}/></Link>;
        })}
        <div className="mac-rail-divider" role="separator"/>
        <div className="mac-more-wrap">
          <button className={`mac-rail-link${moreOpen || context.primary === "more" ? " is-active" : ""}`} aria-label="更多功能" aria-expanded={moreOpen} data-tooltip="更多功能" onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={16} strokeWidth={1.5}/></button>
          {moreOpen ? <>
            <button className="mac-dismiss" aria-label="关闭更多功能菜单" onClick={() => setMoreOpen(false)}/>
            <div className="mac-more-menu" role="menu" aria-label="更多功能">{moreLinks.map(([to, label]) => <Link key={to} role="menuitem" to={to} className={pathIsWithin(location.pathname, to) ? "is-active" : ""}>{label}</Link>)}</div>
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
        <button className="mac-icon-button mac-drawer-toggle" aria-label={`${(narrow ? !drawerOpen : collapsed) ? "展开" : "收起"}${context.sidebarTitle}`} title={context.sidebarTitle} aria-expanded={narrow ? drawerOpen : !collapsed} onClick={() => {
          if (narrow) setDrawerOpen((open) => !open);
          else setCollapsedSections((current) => ({ ...current, [collapseKey]: !collapsed }));
        }}><PanelLeft size={16} strokeWidth={1.5}/></button>
        <div className="mac-toolbar-title">{context.title}</div>
      </div>
      <span className={`mac-mode-indicator${mode === "local" ? " is-local" : ""}`}><span/>{mode === "local" ? "本地测试" : mode === "remote" ? "服务器" : "桌面"}</span>
    </header>
    <aside className={`mac-secondary${drawerOpen ? " is-open" : ""}`} aria-label={context.sidebarTitle} inert={narrow ? !drawerOpen : collapsed} aria-hidden={narrow ? !drawerOpen : collapsed}>
      <div className="mac-list-tools">
        <input type="search" aria-label={`搜索${context.sidebarTitle}`} placeholder={`搜索${context.sidebarTitle}`} value={listSearch} onChange={(event) => setListSearch(event.target.value)}/>
        <button className="mac-icon-button mac-secondary-close" aria-label={`关闭${context.sidebarTitle}`} onClick={() => setDrawerOpen(false)}><X size={16} strokeWidth={1.5}/></button>
      </div>
      <div className="mac-context-list" key={context.key}>
        {!collapsed || drawerOpen ? <MacSidebarContent context={context} search={listSearch}/> : null}
      </div>
    </aside>
    {drawerOpen ? <button className="mac-drawer-scrim" aria-label={`关闭${context.sidebarTitle}`} onClick={() => setDrawerOpen(false)}/> : null}
    <main className="mac-workspace">
      <section className="mac-canvas" aria-label={context.title}><Suspense fallback={<div className="mac-loading" role="status">正在打开页面…</div>}><Outlet/></Suspense></section>
    </main>
  </div>;
}

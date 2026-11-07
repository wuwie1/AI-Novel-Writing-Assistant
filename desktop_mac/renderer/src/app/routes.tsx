import { lazy, type ReactNode } from "react";
import { Link, type RouteObject } from "react-router-dom";
import MacNovelShelf from "../features/novels/MacNovelShelf";
const MacTaskRecords = lazy(() => import("../features/tasks/MacTaskRecords"));
const MacSettings = lazy(() => import("../features/settings/MacSettings"));
const MacAppearance = lazy(() => import("../features/settings/MacSettings").then((module) => ({ default: module.MacAppearance })));
const MacMaintenance = lazy(() => import("../features/settings/MacSettings").then((module) => ({ default: module.MacMaintenance })));

export const macPageOverrides = {
  home: <MacNovelShelf/>, novels: <MacNovelShelf/>, tasks: <MacTaskRecords/>, settings: <MacSettings/>,
  "settings/appearance": <MacAppearance/>, "settings/maintenance": <MacMaintenance/>,
};

function MacFeature({ id, children }: { id: string; children: ReactNode }) {
  // Editors own unsaved state; visiting a route is not evidence of an edit.
  return <div className="mac-feature" data-mac-page={id}>{children}</div>;
}

export function wrapMacRoutes(routes: RouteObject[]): RouteObject[] {
  return routes.map((route) => route.index ? route : ({ ...route,
    errorElement: <div className="mac-page"><h1>页面暂时无法打开</h1><p>请回到书架重新打开作品。章节中已保留的本机草稿会随作品恢复。</p><Link to="/novels">返回书架</Link></div>,
    children: route.children?.map((page) => {
      const id = page.id ?? "home";
      return { ...page, element: <MacFeature id={id}>{page.element}</MacFeature> };
    }),
  }));
}

import { matchPath } from "react-router-dom";
import { settingsSections } from "../features/settings";

export type NavigationLink = readonly [to: string, label: string];
export const primaryLinks: readonly NavigationLink[] = [["/create", "新建"], ["/novels", "书架"], ["/creative-hub", "创作中枢"], ["/lab/director", "导演"], ["/tasks", "运行记录"]];
const resourceGroups = [
  { title: "资料与参考", links: [["/book-analysis", "书籍分析"], ["/market-radar", "市场雷达"], ["/knowledge", "知识库"]] },
  { title: "故事素材", links: [["/genres", "题材"], ["/story-modes", "故事模式"], ["/worlds", "世界设定"], ["/base-characters", "角色素材"]] },
  { title: "写作工具", links: [["/titles", "标题工坊"], ["/style-engine", "写作风格"], ["/prompt-workbench", "提示词工作台"], ["/anti-ai-rules", "写作规则"]] },
] satisfies Array<{ title: string; links: NavigationLink[] }>;
export const moreLinks: readonly NavigationLink[] = [
  ...resourceGroups.flatMap((group) => group.links),
  ["#visual-assets", "视觉资源库"],
  ["/comic", "漫画"],
  ["/auto-director/follow-ups", "导演跟进"],
];
export const createLinks: NavigationLink[] = [
  ["/create", "从想法开始"],
  ["/create?form=short_story", "创作短篇"],
  ["/novels/auto-director?start=reference", "照着一本书写"],
  ["/novels/create", "填写小说设定"],
  ["/novels/auto-director", "AI 自动创作"],
];

export interface MacNavigation {
  section: "create" | "shelf" | "novel" | "creative" | "director" | "tasks" | "settings" | "help" | "resources" | "drama" | "comic";
  title: string;
  primary: string;
}

export function pathIsWithin(path: string, root: string) {
  return path === root || (root !== "/" && path.startsWith(`${root}/`));
}

function resolveCreateTitle(pathname: string, search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (pathname === "/create" && params.get("form") === "short_story") return "创作短篇";
  if (pathname === "/novels/auto-director" && params.get("start") === "reference") return "照着一本书写";
  if (pathname === "/novels/auto-director") return "AI 自动创作";
  if (pathname === "/novels/create") return "填写小说设定";
  return "从想法开始";
}

/** 菜单上下文只由当前路由决定；上次浏览的小说不能覆盖全局工具。 */
export function resolveMacNavigation(pathname: string, search = ""): MacNavigation {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/create" || path === "/novels/create" || path === "/novels/auto-director") {
    return {
      section: "create",
      title: resolveCreateTitle(path, search),
      primary: "/create",
    };
  }
  if (path === "/" || path === "/novels") return { section: "shelf", title: "书架", primary: "/novels" };
  const novel = matchPath("/novels/:id/*", path);
  const director = matchPath("/lab/director/:novelId", path);
  const novelId = novel?.params.id ?? (director?.params.novelId !== "preview" ? director?.params.novelId : undefined);
  if (novelId) {
    const chapterId = matchPath("/novels/:id/chapters/:chapterId", path)?.params.chapterId;
    return { section: "novel", title: chapterId ? "章节编辑" : director ? "小说导演台" : path.endsWith("/preview") ? "阅读预览" : "小说工作台", primary: director ? "/lab/director" : "/novels" };
  }
  if (pathIsWithin(path, "/creative-hub") || path === "/chat-legacy" || path === "/chat") return { section: "creative", title: "创作中枢", primary: "/creative-hub" };
  if (pathIsWithin(path, "/lab/director") || pathIsWithin(path, "/auto-director")) return { section: "director", title: pathIsWithin(path, "/auto-director") ? "导演跟进" : "导演运行记录", primary: "/lab/director" };
  if (path === "/tasks") return { section: "tasks", title: "运行记录", primary: "/tasks" };
  if (pathIsWithin(path, "/settings")) return { section: "settings", title: settingsSections.find(([key]) => path === `/settings/${key}`)?.[1] ?? "设置", primary: "/settings" };
  if (path === "/help") return { section: "help", title: "帮助", primary: "/help" };
  if (pathIsWithin(path, "/comic")) return { section: "comic", title: "漫画", primary: "more" };
  // 短剧入口与 Web 保持一致：路由保留，但不作为 Mac 主导航入口。
  if (pathIsWithin(path, "/drama")) return { section: "drama", title: "短剧", primary: "more" };
  const group = resourceGroups.find(({ links }) => links.some(([to]) => pathIsWithin(path, to)));
  return { section: "resources", title: group?.links.find(([to]) => pathIsWithin(path, to))?.[1] ?? "创作工具", primary: "more" };
}

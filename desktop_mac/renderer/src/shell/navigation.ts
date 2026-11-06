import { matchPath } from "react-router-dom";
import { settingsSections } from "../features/settings";

export type NavigationLink = readonly [to: string, label: string];
export const primaryLinks: readonly NavigationLink[] = [["/create", "新建"], ["/novels", "书架"], ["/creative-hub", "创作中枢"], ["/lab/director", "导演"], ["/tasks", "运行记录"]];
const resourceGroups = [
  { title: "资料与参考", links: [["/book-analysis", "书籍分析"], ["/market-radar", "市场雷达"], ["/knowledge", "知识库"]] },
  { title: "故事素材", links: [["/genres", "题材"], ["/story-modes", "故事模式"], ["/worlds", "世界设定"], ["/base-characters", "角色素材"]] },
  { title: "写作工具", links: [["/titles", "标题工坊"], ["/style-engine", "写作风格"], ["/prompt-workbench", "提示词工作台"], ["/anti-ai-rules", "写作规则"]] },
] satisfies Array<{ title: string; links: NavigationLink[] }>;
export const moreLinks: readonly NavigationLink[] = [...resourceGroups.flatMap((group) => group.links), ["/drama", "短剧"], ["/comic", "漫画"], ["/auto-director/follow-ups", "导演跟进"]];
const createLinks: NavigationLink[] = [["/create", "从想法开始"], ["/novels/create", "填写小说设定"], ["/novels/auto-director", "AI 自动创作"]];
const directorLinks: NavigationLink[] = [["/lab/director", "导演运行记录"], ["/auto-director/follow-ups", "导演跟进"]];

export interface MacNavigation {
  key: string;
  section: "create" | "shelf" | "novel" | "creative" | "director" | "tasks" | "settings" | "help" | "resources" | "drama" | "comic";
  title: string;
  sidebarTitle: string;
  primary: string;
  links?: readonly NavigationLink[];
  novelId?: string;
  chapterId?: string;
}

export function pathIsWithin(path: string, root: string) {
  return path === root || (root !== "/" && path.startsWith(`${root}/`));
}

/** 菜单上下文只由当前路由决定；上次浏览的小说不能覆盖全局工具。 */
export function resolveMacNavigation(path: string): MacNavigation {
  path = path.replace(/\/+$/, "") || "/";
  const creation = createLinks.find(([to]) => path === to);
  if (creation) return { key: "create", section: "create", title: creation[1], sidebarTitle: "开始创作", primary: "/create", links: createLinks };
  if (path === "/" || path === "/novels") return { key: "shelf", section: "shelf", title: "书架", sidebarTitle: "我的小说", primary: "/novels" };
  const novel = matchPath("/novels/:id/*", path);
  const director = matchPath("/lab/director/:novelId", path);
  const novelId = novel?.params.id ?? (director?.params.novelId !== "preview" ? director?.params.novelId : undefined);
  if (novelId) {
    const chapterId = matchPath("/novels/:id/chapters/:chapterId", path)?.params.chapterId;
    return { key: `novel:${novelId}`, section: "novel", title: chapterId ? "章节编辑" : director ? "小说导演台" : path.endsWith("/preview") ? "阅读预览" : "小说工作台", sidebarTitle: "小说与章节", primary: director ? "/lab/director" : "/novels", novelId, chapterId };
  }
  if (pathIsWithin(path, "/creative-hub") || path === "/chat-legacy" || path === "/chat") return { key: "creative", section: "creative", title: "创作中枢", sidebarTitle: "创作对话", primary: "/creative-hub" };
  if (pathIsWithin(path, "/lab/director") || pathIsWithin(path, "/auto-director")) return { key: "director", section: "director", title: pathIsWithin(path, "/auto-director") ? "导演跟进" : "导演运行记录", sidebarTitle: "导演创作", primary: "/lab/director", links: directorLinks };
  if (path === "/tasks") return { key: "tasks", section: "tasks", title: "运行记录", sidebarTitle: "记录筛选", primary: "/tasks" };
  if (pathIsWithin(path, "/settings")) return { key: "settings", section: "settings", title: settingsSections.find(([key]) => path === `/settings/${key}`)?.[1] ?? "设置", sidebarTitle: "设置分类", primary: "/settings", links: [["/settings", "设置概览"], ...settingsSections.map(([key, title]) => [`/settings/${key}`, title] as const)] };
  if (path === "/help") return { key: "help", section: "help", title: "帮助", sidebarTitle: "创作指南", primary: "/help", links: [["/help", "创作路线"], ["/settings/models", "准备 AI 模型"], ["/create", "开始第一部作品"]] };
  for (const section of ["drama", "comic"] as const) {
    if (pathIsWithin(path, `/${section}`)) return { key: section, section, title: section === "drama" ? "短剧" : "漫画", sidebarTitle: section === "drama" ? "短剧项目" : "漫画项目", primary: "more" };
  }
  const group = resourceGroups.find(({ links }) => links.some(([to]) => pathIsWithin(path, to)));
  return { key: group?.title ?? "more", section: "resources", title: group?.links.find(([to]) => pathIsWithin(path, to))?.[1] ?? "创作工具", sidebarTitle: group?.title ?? "更多功能", primary: "more", links: group?.links ?? moreLinks };
}

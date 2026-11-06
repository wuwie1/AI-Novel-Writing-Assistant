# Mac 页面覆盖与复用边界

所有页面来自 `createAppRoutes` 的同一份路由合同。Web 默认 `AppRouter` 仍使用原 `AppLayout`；Mac 注入 `MacWorkspace`，没有加载 Web 的 main.tsx/index.css，也不直接打开服务器 Web 页面。

书架、运行记录、设置概览与桌面专属设置采用独立视图。其他页面复用已存在的业务组件与操作合同，呈现由 Mac 容器、主题、正文排版以及组件语义标记共同约束；不复制服务端 AI 决策或任务恢复逻辑。此表表示入口与代码接入，不表示视觉/交互已经验收。

| 页面 ID / 路径 | Mac 视图 | 共用逻辑入口 | 离开保护 | 工程检查 | 用户验收 / 开关 |
| --- | --- | --- | --- | --- | --- |
| `home` | MacNovelShelf | NovelList | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `help` | 原业务能力 + Mac 页面呈现 | HelpPage | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `lab/director` | 原业务能力 + Mac 页面呈现 | DirectorRunHistoryPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `lab/director/:novelId` | 原业务能力 + Mac 页面呈现 | DirectorNovelPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `novels` | MacNovelShelf | NovelList | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `create` | 原业务能力 + Mac 页面呈现 | CreationStudioPage | 想法 dirty/busy/本机草稿；其他输入页内保存 | 类型/构建通过 | 用户验收待完成 |
| `novels/create` | 原业务能力 + Mac 页面呈现 | NovelCreate | 创建表单 dirty/busy/本机草稿 | 类型/构建通过 | 用户验收待完成 |
| `novels/auto-director` | 原业务能力 + Mac 页面呈现 | AutoDirectorCreatePage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `novels/:id/simple` | 原业务能力 + Mac 页面呈现 | SimpleNovelShelfPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `novels/:id/story` | 原业务能力 + Mac 页面呈现 | ShortStoryStudioPage | 短篇正文 dirty/busy/save/discard；其他输入页内保存 | 类型/构建通过 | 用户验收待完成 |
| `novels/:id/preview` | 原业务能力 + Mac 页面呈现 | NovelPreview | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `novels/:id/ai-usage` | 原业务能力 + Mac 页面呈现 | NovelUsagePage | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `novels/:id/edit` | 原业务能力 + Mac 页面呈现 | NarrativeFormNovelEditRoute | 卷章规划 dirty/busy/discard；其他表单页内保存 | 类型/构建通过 | 用户验收待完成 |
| `novels/:id/chapters/:chapterId` | 原业务能力 + Mac 页面呈现 | NovelChapterEdit | 章节/AI候选 dirty/busy/save/discard | 类型/构建通过 | 用户验收待完成 |
| `drama` | 原业务能力 + Mac 页面呈现 | DramaWorkspacePage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `drama/projects/:id` | 原业务能力 + Mac 页面呈现 | DramaProjectPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `comic` | 原业务能力 + Mac 页面呈现 | ComicWorkspacePage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `comic/projects/:id` | 原业务能力 + Mac 页面呈现 | ComicProjectPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `creative-hub` | 原业务能力 + Mac 页面呈现 | CreativeHubPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `chat-legacy` | 原业务能力 + Mac 页面呈现 | ChatPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `chat` | 保留原重定向 | Navigate | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `book-analysis` | 原业务能力 + Mac 页面呈现 | BookAnalysisPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `market-radar` | 原业务能力 + Mac 页面呈现 | MarketRadarPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `tasks` | MacTaskRecords | listTasks/getTaskDetail | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `auto-director/follow-ups` | 原业务能力 + Mac 页面呈现 | AutoDirectorFollowUpCenterPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `auto-director/follow-up-center` | 保留原重定向 | Navigate | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `auto-director/followup-center` | 保留原重定向 | Navigate | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `knowledge` | 原业务能力 + Mac 页面呈现 | KnowledgePage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `genres` | 原业务能力 + Mac 页面呈现 | GenreManagementPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `story-modes` | 原业务能力 + Mac 页面呈现 | StoryModeManagementPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `titles` | 原业务能力 + Mac 页面呈现 | TitleStudioPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `prompt-workbench` | 原业务能力 + Mac 页面呈现 | PromptWorkbenchPage | 草稿与模板 dirty/save/discard；其他表单页内保存 | 类型/构建通过 | 用户验收待完成 |
| `anti-ai-rules` | 原业务能力 + Mac 页面呈现 | AntiAiRulesPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `settings/model-routes` | 原业务能力 + Mac 页面呈现 | ModelRoutesSettingsPage | 模型路由 dirty/busy/save/discard | 类型/构建通过 | 用户验收待完成 |
| `settings/models` | 原业务能力 + Mac 页面呈现 | ModelsSettingsPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `settings/director` | 原业务能力 + Mac 页面呈现 | DirectorSettingsPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `settings/knowledge` | 原业务能力 + Mac 页面呈现 | KnowledgeSettingsPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `settings/maintenance` | MacMaintenance | 平台设置 | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `settings/appearance` | MacAppearance | 平台设置 | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `settings` | MacSettings | 平台设置 | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `worlds` | 原业务能力 + Mac 页面呈现 | WorldList | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `worlds/generator` | 原业务能力 + Mac 页面呈现 | 原路由业务组件/功能开关 | 页内保存（未接入统一离开保护） | 类型/构建通过 | 沿用 worldWizardEnabled；禁用时回世界列表 |
| `worlds/:id/workspace` | 原业务能力 + Mac 页面呈现 | 原路由业务组件/功能开关 | 页内保存（未接入统一离开保护） | 类型/构建通过 | 沿用 worldWizardEnabled；禁用时回世界列表 |
| `style-engine` | 原业务能力 + Mac 页面呈现 | WritingFormulaPage | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `writing-formula` | 保留原重定向 | Navigate | 只读/导航 | 类型/构建通过 | 用户验收待完成 |
| `base-characters` | 原业务能力 + Mac 页面呈现 | CharacterLibrary | 页内保存（未接入统一离开保护） | 类型/构建通过 | 用户验收待完成 |
| `*` | 保留原重定向 | Navigate | 只读/导航 | 类型/构建通过 | 用户验收待完成 |

## 统一呈现

- 根主题仅作用于 `html[data-app-shell="mac"]`；Portal 也读取该主题。Web CSS 文件没有修改。
- 主导航、当前小说、章节目录、菜单、书架、设置、运行记录由 Mac 自有组件呈现。
- 共享业务组件的 Card/Button/WorkspaceHeader 提供无视觉副作用的 `data-ui` 标记；Mac 自有 CSS 控制密度、标题与平面分组。表单、Tab、表格、弹窗与正文在 Mac 作用域内统一。
- 默认正文20px/1.6，用户可在正文排版中调整；Mac 编辑器偏好与 Web 的存储键不同。
- 运行记录只读；继续、恢复、重试等动作仍位于来源创作页。短篇和导演V2作品入口使用统一的小说来源路由解析，不能硬编码到旧工作台。

## 文档保护边界

显式文档保护接入章节正文/AI候选、短篇编辑、开书想法、手动创建、卷章规划、提示词草稿/模板、模型路由设置。保存使用原业务 mutation；无直接保存合同的卷章规划提示返回本页保存。Web 的默认平台实现为空，不增加 Web 退出拦截。

章节草稿按后端身份持久化，保留原有版本冲突判断。开书想法和创建表单可选择保存为本机草稿。其他业务页沿用自身保存/确认行为，需要使用页面内的保存或提交操作。未接入统一保护的临时表单不能宣称已受 Mac 退出保护；对应缺口在上表明确列出。路由名称和 `manualReview` 元数据不能代表有未保存修改，因此不触发通用离开弹窗，也不通过扫描 DOM 猜测保存状态。后续新增或修改此类编辑器时应在状态所有者接入 `useDocumentGuard`，仅在真实 dirty/busy 时阻止离开。

真实AI生成、地图/图表、复杂表单和未统一注册的临时表单都需按 acceptance.md 验收；不能把成功打包视为页面交互完整验证。

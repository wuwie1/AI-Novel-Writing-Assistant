# Mac 页面覆盖与复用边界

所有页面来自 `createAppRoutes` 的同一份路由合同。Web 默认 `AppRouter` 仍使用原 `AppLayout`；Mac 注入 `MacWorkspace`，没有加载 Web 的 main.tsx/index.css，也不直接打开服务器 Web 页面。

书架、运行记录、设置概览与桌面专属设置采用独立视图。其他页面复用已存在的业务组件与操作合同，呈现由 Mac 容器、主题、正文排版以及组件语义标记共同约束；不复制服务端 AI 决策或任务恢复逻辑。覆盖测试将此表的 47 个 ID 与共享路由逐一比对，并在世界向导启用及关闭时检查实际路由元素和跳转目标。实机项目见[用户验收清单](acceptance.md)。

| 页面 ID / 路径 | Mac 视图 | 中栏对象或整宽视图 | 共用逻辑入口 | 编辑与离开 | 实机验收 / 开关 |
| --- | --- | --- | --- | --- | --- |
| `home` | MacNovelShelf | 本页书架作品；显式打开总览时整宽 | NovelList | 只读/导航 | 用户验收待完成 |
| `help` | 共享业务页 | 整宽 · 首作指南 | HelpPage | 只读/导航 | 用户验收待完成 |
| `lab/director` | 共享业务页 | 新旧导演运行，按版本与运行 ID 查看 | DirectorRunHistoryPage | 沿用页内操作 | 用户验收待完成 |
| `lab/director/:novelId` | 共享业务页 | 当前书的章、卷、节奏段、角色或规划章；单份资料整宽 | DirectorNovelPage | 沿用页内操作 | 用户验收待完成 |
| `novels` | MacNovelShelf | 按条件分页的书架作品；总览整宽 | NovelList | 只读/导航 | 用户验收待完成 |
| `create` | 共享业务页 | 当前解释任务的创作方向；起步表单整宽 | CreationStudioPage | 想法 dirty/busy/本机草稿；其他输入页内保存 | 用户验收待完成 |
| `novels/create` | 共享业务页 | 整宽 · 手动创建表单 | NovelCreate | 创建表单 dirty/busy/本机草稿 | 用户验收待完成 |
| `novels/auto-director` | 共享业务页 | 当前任务的批次候选；参考与设定表单整宽 | AutoDirectorCreatePage | 沿用页内操作 | 用户验收待完成 |
| `novels/:id/simple` | 共享业务页 | 简易创作的章节与可读状态 | SimpleNovelShelfPage | 沿用页内操作 | 用户验收待完成 |
| `novels/:id/story` | 共享业务页 | 编辑时为本篇分段；连续阅读整宽 | ShortStoryStudioPage | 短篇正文 dirty/busy/save/discard；其他输入页内保存 | 用户验收待完成 |
| `novels/:id/preview` | 共享业务页 | 本书章节；选行继续阅读 | NovelPreview | 只读/导航 | 用户验收待完成 |
| `novels/:id/ai-usage` | 共享业务页 | 本页模型调用与用量汇总 | NovelUsagePage | 只读/导航 | 用户验收待完成 |
| `novels/:id/edit` | 共享业务页 | 本步角色、卷、规划章、正文章、报告或快照；单文档整宽 | NarrativeFormNovelEditRoute | 卷章规划 dirty/busy/discard；其他表单页内保存 | 用户验收待完成 |
| `novels/:id/chapters/:chapterId` | 共享业务页 | 本书章节；正文与诊断留在画布 | NovelChapterEdit | 章节/AI候选 dirty/busy/save/discard | 用户验收待完成 |
| `drama` | 共享业务页 | 短剧项目 | DramaWorkspacePage | 沿用页内操作 | 用户验收待完成 |
| `drama/projects/:id` | 共享业务页 | 该短剧的分集或角色；单份项目设定整宽 | DramaProjectPage | 分集台本与角色草稿保护；其余页内保存 | 用户验收待完成 |
| `comic` | 共享业务页 | 漫画项目 | ComicWorkspacePage | 沿用页内操作 | 用户验收待完成 |
| `comic/projects/:id` | 共享业务页 | 该漫画的分话、角色或场景；单份项目设定整宽 | ComicProjectPage | 分话大纲、角色外貌与场景草稿保护；其余页内保存 | 用户验收待完成 |
| `creative-hub` | 共享业务页 | 创作对话；消息与绑定资料留在画布 | CreativeHubPage | 会话忙碌时锁定切换 | 用户验收待完成 |
| `chat-legacy` | 共享业务页 | 本地旧版会话 | ChatPage | 回复期间保护当前会话 | 用户验收待完成 |
| `chat` | 共享路由 | 转到创作中枢 | Navigate | 只读/导航 | 用户验收待完成 |
| `book-analysis` | 共享业务页 | 分析记录；按来源文档和版本查看参考 | BookAnalysisPage | 沿用页内操作 | 用户验收待完成 |
| `market-radar` | 共享业务页 | 当前榜单、当前报告的信号或收藏题材 | MarketRadarPage | 沿用页内操作 | 用户验收待完成 |
| `tasks` | MacTaskRecords | 真实运行记录，按状态、类型、关键词与游标读取 | listTasks/getTaskDetail | 只读/导航 | 用户验收待完成 |
| `auto-director/follow-ups` | 共享业务页 | 导演跟进事项；在来源工作区处理 | AutoDirectorFollowUpCenterPage | 沿用页内操作 | 用户验收待完成 |
| `auto-director/follow-up-center` | 共享路由 | 转到导演跟进 | Navigate | 只读/导航 | 用户验收待完成 |
| `auto-director/followup-center` | 共享路由 | 转到导演跟进 | Navigate | 只读/导航 | 用户验收待完成 |
| `knowledge` | 共享业务页 | 文档或最近索引作业；检索设置整宽 | KnowledgePage | 沿用页内操作 | 用户验收待完成 |
| `genres` | 共享业务页 | 题材树节点 | GenreManagementPage | 沿用页内操作 | 用户验收待完成 |
| `story-modes` | 共享业务页 | 故事模式树节点 | StoryModeManagementPage | 沿用页内操作 | 用户验收待完成 |
| `titles` | 共享业务页 | 标题库条目；生成表单整宽 | TitleStudioPage | 沿用页内操作 | 用户验收待完成 |
| `prompt-workbench` | 共享业务页 | 提示词目录；从书章进入的正文实验整宽 | PromptWorkbenchPage | 条目及作用域切换保护草稿；实验按书章定位 | 用户验收待完成 |
| `anti-ai-rules` | 共享业务页 | 写作规则及其生效范围 | AntiAiRulesPage | 沿用页内操作 | 用户验收待完成 |
| `settings/model-routes` | 共享业务页 | 任务模型路由；公共备用模型设置留在画布 | ModelRoutesSettingsPage | 任务路由与备用模型 dirty/busy/save/discard | 用户验收待完成 |
| `settings/models` | 共享业务页 | 模型厂商 | ModelsSettingsPage | 沿用页内操作 | 用户验收待完成 |
| `settings/director` | 共享业务页 | 整宽 · 导演设置 | DirectorSettingsPage | 沿用页内操作 | 用户验收待完成 |
| `settings/knowledge` | 共享业务页 | 整宽 · 检索设置 | KnowledgeSettingsPage | 沿用页内操作 | 用户验收待完成 |
| `settings/maintenance` | MacMaintenance | 整宽 · 维护设置 | 平台设置 | 只读/导航 | 用户验收待完成 |
| `settings/appearance` | MacAppearance | 整宽 · 显示偏好 | 平台设置 | 只读/导航 | 用户验收待完成 |
| `settings` | MacSettings | 整宽 · 设置概览 | 平台设置 | 只读/导航 | 用户验收待完成 |
| `worlds` | 共享业务页 | 世界列表 | WorldList | 沿用页内操作 | 用户验收待完成 |
| `worlds/generator` | 共享业务页 | 整宽 · 创建世界 | 原路由业务组件/功能开关 | 沿用页内操作 | 沿用 worldWizardEnabled；禁用时回世界列表 |
| `worlds/:id/workspace` | 共享业务页 | 快照、绑定参考和共享素材；概览及预留工具整宽 | 原路由业务组件/功能开关 | 沿用页内操作 | 沿用 worldWizardEnabled；禁用时回世界列表 |
| `style-engine` | 共享业务页 | 写法资产 | WritingFormulaPage | 沿用页内操作 | 用户验收待完成 |
| `writing-formula` | 共享路由 | 转到写作风格 | Navigate | 只读/导航 | 用户验收待完成 |
| `base-characters` | 共享业务页 | 全局角色素材 | CharacterLibrary | 沿用页内操作 | 用户验收待完成 |
| `*` | 共享路由 | 转到首页书架 | Navigate | 只读/导航 | 用户验收待完成 |

## 统一呈现

- 根主题仅作用于 `html[data-app-shell="mac"]`；Portal 也读取该主题。Web CSS 文件没有修改。
- 图标栏与更多功能打开业务页。活动页面发布唯一实体目录，导航元数据仅提供标题与图标高亮。写作步骤和设置分类放在画布，帮助与单一表单使用整宽。
- 共享业务组件的 Card/Button/WorkspaceHeader 提供无视觉副作用的 `data-ui` 标记；Mac 自有 CSS 控制密度、标题与平面分组。表单、Tab、表格、弹窗与正文在 Mac 作用域内统一。
- 默认正文20px/1.6，用户可在正文排版中调整；Mac 编辑器偏好与 Web 的存储键不同。
- 运行记录只读；继续、恢复、重试等动作仍位于来源创作页。短篇和导演V2作品入口使用统一的小说来源路由解析，不能硬编码到旧工作台。

## 文档保护边界

显式文档保护接入章节正文/AI候选、短篇编辑、开书想法、手动创建、卷章规划、提示词草稿/模板、模型路由设置。保存使用原业务 mutation；无直接保存合同的卷章规划提示返回本页保存。Web 的默认平台实现为空，不增加 Web 退出拦截。

章节草稿按后端身份持久化，保留原有版本冲突判断。开书想法和创建表单可选择保存为本机草稿。其他业务页沿用自身保存/确认行为，需要使用页面内的保存或提交操作。未接入统一保护的临时表单不能宣称已受 Mac 退出保护；对应缺口在上表明确列出。路由名称和 `manualReview` 元数据不能代表有未保存修改，因此不触发通用离开弹窗，也不通过扫描 DOM 猜测保存状态。后续新增或修改此类编辑器时应在状态所有者接入 `useDocumentGuard`，仅在真实 dirty/busy 时阻止离开。

导演样例 `/lab/director/preview` 由 `lab/director/:novelId` 命中，使用内置样例。视觉资源库由“更多功能”或 `#visual-assets` 打开，关闭后恢复原页面和所选对象。世界工作台的地图与图谱预留视图使用整宽画布。真实 AI 生成、地图、复杂表单和原生窗口的验收条件见[用户验收清单](acceptance.md)。

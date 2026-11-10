# Mac 工作台中栏列表与详情升级计划

## 执行入口

将下面这段指令交给仓库根目录中的 Codex 即可开始。

```text
读取 AGENTS.md 和 plan.md，在从 ai 分支创建的 codex/mac-entity-lists 功能分支上实施（已存在则切换过去继续）。按“实施阶段”的依赖顺序，从第一个未完成的复选框开始。每阶段打通真实页面入口，运行对应检查，把勾选进度和检查结果与该阶段改动一起提交，再继续下一阶段。沿用 Web 现有的数据和操作合同，不新增服务端接口、Prompt 或数据库迁移。检查失败先在本阶段修复；遇到计划与源码冲突、需要新接口或破坏性操作时，停在当前阶段并报告原因。完成后交付本地 beta 集成结果、检查证据和用户实机验收清单，不推送远端。
```

计划依据为本仓库和 `/Users/likai/go/src/write/wukong` 的 `c610746b`。实施时以当前分支源码为准。Mac renderer 只存在于 `ai` 分支，`main` 没有 `desktop_mac/`，功能分支必须从 `ai` 创建。此次升级针对 `desktop_mac/renderer` 与它复用的客户端业务视图。保留现有 Mac 配色、排版、图标轨道、原生窗口及服务连接方式。

范围边界：列表只使用现有接口和页面已有投影。某个集合缺少可用的列表数据时，该视图收起中栏，并在阶段提交说明中记录缺口，不为此新建接口、拼装假数据或回退到页面链接。

## 一、布局与参考

| 位置 | 用户在这里做什么 | 运行记录示例 |
| --- | --- | --- |
| 左侧图标栏和“更多功能” | 进入一个功能 | 打开“运行记录” |
| 中栏 | 搜索、筛选和翻页，从当前功能的实际数据中选一项 | 选中“《山海》· 第 5 章正文生成”，行内可见状态和更新时间 |
| 右侧工作区 | 查看选中对象、切换对象的视图，在有权限的来源页操作 | 看该次生成的进度、步骤和错误，点“打开创作页面”回到作品 |

- **切视图**用工作区标题下方的横向标签。少量互斥类型可用分段按钮，多项状态、排序和组合条件用列表工具栏的筛选菜单。八步写作流程使用当前步骤、上一步/下一步和可展开的步骤选择。页内按钮承担新建、预览、历史及返回等操作。
- **有集合就显示中栏**。记录暂未产生时，显示该集合自己的加载、空列表、无匹配或读取失败状态。纯表单、设置说明和单文档工作区收起整个中栏及其搜索、开关，画布占满剩余宽度。列表行对应可定位的实体 ID 或业务复合键。
- **每屏一份同类目录**。右侧可保留不同职责的诊断、写作助手或导演面板。列表、详情各自滚动，保留 64px 图标栏、244px 中栏、40px 顶栏和现有选中色。宽度不超过 960px 时复用抽屉，成功选中后回到详情，取消离开保留原抽屉、选中项与焦点。筛选面板支持 Esc 和焦点返回，标签支持方向键，行可用键盘打开。

直接参照下列悟空实现。本项目继续按自己的业务权限和路由工作。

| 参考实现 | 在本项目采用的做法 |
| --- | --- |
| [任务列表与详情](../wukong/web/src/features/tasks/TasksView.jsx) · [任务筛选](../wukong/web/src/features/tasks/TaskFilters.jsx) | 一行一次任务，状态和类型收在搜索旁的筛选菜单。运行记录只提供读取、刷新与来源页导航。 |
| [小说列表](../wukong/web/src/features/books/BooksView.jsx) · [回收站](../wukong/web/src/features/recycle-bin/RecycleBinView.jsx) | 选小说后在右侧看作品资料。借用回收站的分类筛选、分页、空态和窄窗返回方式。当前项目没有回收站路由，本次沿用现有书架删除合同。 |
| [世界资料](../wukong/web/src/features/world/WorldView.jsx) · [故事结构](../wukong/web/src/features/story/StoryView.jsx) | 类型标签位于工作区顶部。切换类型时，更换下方数据和对应详情。直接复用本项目的标签、按钮和菜单原语。 |

## 二、从现有代码接入

1. **外壳与路由。** [MacAppLayout](desktop_mac/renderer/src/shell/MacAppLayout.tsx) 持有搜索、抽屉和折叠状态。[navigation.ts](desktop_mac/renderer/src/shell/navigation.ts) 给新建、资料和设置返回页面链接组，基线中的 `shell/sidebar` 将它们渲染成行，还把书内步骤、导演入口和任务状态放进中栏。保留路由推导标题及图标高亮的能力，逐个菜单移交列表所有权。[共享路由](client/src/router/index.tsx) 的 `createAppRoutes`、功能开关和重定向继续作为入口合同，[Mac 页面覆盖](desktop_mac/renderer/src/app/routes.tsx) 注入专属呈现。
2. **列表由业务页提供。** 在现有 [客户端平台入口](client/src/platform/index.tsx) 旁增加可选的列表呈现槽，输入为集合标识（功能、父对象、类型）、名称、工具和列表内容。Mac 外壳提供稳定的中栏容器，业务页把列表及筛选控件通过 React portal 放入容器，详情留在同一业务组件树。Web 默认在原位置渲染。路由切走时释放槽，按已确认的路由和集合标识更新标题与抽屉。收栏保留右侧编辑器和业务控制器。分批迁移时按页面显式启用，最后移除旧 `SidebarLinks` 兜底。
3. **一个集合一个状态所有者。** 搜索、筛选、分页、选中键、请求和轮询来自原页面的 hook、render prop 或受控组件。外壳负责摆放和焦点。书架现有中栏另取“最近 100 本”，右侧 `NovelList` 却按真实筛选分页。运行记录中栏的 `TaskFilters` 与右侧 `MacTaskRecords` 也各有控件。迁移时删掉这类重复读取和列表，把已有行组件或模型移到槽内。全局角标可保留独立用途，查询参数不同的请求应使用不同缓存键。
4. **区分筛选、定位和打开。** 沿用页面已有路径和查询参数。切换可分享的对象时创建历史项，提交搜索或纠正无效参数时替换当前项。保留原业务明确使用的替换式步骤导航。筛选只改自己的参数并重置页码或游标，选择对象保留筛选与来源信息。页外深链优先按 ID 读取已有详情接口，只有列表投影的功能从自己的集合解析。对象暂被搜索隐藏时可清除筛选找回，详情确认失效时提供返回列表。切换父对象或实体类型时清理不兼容的选中键，旧响应只更新旧键的缓存。分页书架和运行记录使用接口搜索，仅搜索已加载条目的页面标明范围。
5. **保护编辑中的内容。** [MacDocumentProtection](desktop_mac/renderer/src/platform/MacDocumentProtection.tsx) 会拦截有 dirty/busy 文档的路径和查询串变更。编辑页的临时搜索、展开分组用本地视图状态。会替换文档的选行、换页、切类型，先走路由 blocker 或页面已有的保存/取消流程，再更新高亮。只有本地回调、却会卸载脏文档的选择器，应从平台接口复用同一离开确认，再提交选中键。窗口重新激活沿用按后端身份和文档状态进行的读取。

## 三、各功能的中栏、详情与数据依赖

下表同时是逐页交付清单。“收起”表示该视图没有独立的实体集合。页面内现有写入、AI 调用、导出、批量选择及确认仍由原业务控制器处理。

### 小说创作与运行

| 路由或场景 | 中栏的真实对象 | 右侧呈现、数据依赖与交接 |
| --- | --- | --- |
| `/`、`/novels` 书架 | 按现有搜索、形态、写作模式、状态和排序分页的小说，每行一部 | 默认选书后看封面、进度和“继续写作”。复用 [NovelListPresentation](client/src/pages/novels/NovelList.tsx) 的封面、导出、删除确认和驾驶舱操作。保留书架封面网格/工作台总览，显式进入总览时让画布独占空间。 |
| `/create`、`/novels/create`、`/novels/auto-director` | 想法、手动设定和参考书起步表单收起。取得结构化结果后，展示当前任务的方向 `direction.id` 或当前批次候选 | “从想法开始、创作短篇、照着一本书写、填写小说设定、AI 自动创作”放在新建页。切候选只查看，确认沿用原 mutation。保留 `form=short_story`、`start=reference`、`taskId`、参考书及市场简报入口。确认后的目标取 `resumeRoute` 或原候选任务解析结果。 |
| `/novels/:id/edit` 专业创作 | 项目设定、宏观规划等单表单收起。角色准备列本书角色，卷规划列卷，拆章列当前卷已规划的章，章节执行列真实章节，质量页列章节报告，版本历史列本书快照。世界准备按已有本书资料呈现，单份资料可直接占用画布 | [八步定义](client/src/pages/novels/novelWorkspaceNavigation.ts)、[工作流选择](client/src/pages/novels/hooks/useNovelEditWorkflow.ts) 和 [业务视图](client/src/pages/novels/components/NovelEditView.tsx) 决定当前步骤与推荐下一步。使用 `stage`、`volumeId`、`chapterId`、`taskPanel`，保留手工路径、导演锁、接管及恢复上下文。历史从作品工具打开。 |
| `/novels/:id/chapters/:chapterId`、`/novels/:id/preview` | 同书章节，按章序排列，有可靠卷归属时按卷分组 | 编辑页由作品和章节 ID 取得正文与 `getChapterEditorWorkspace`。右侧保留 Plate、诊断、保存和 AI 候选。预览页用 `?chapterId=` 切换阅读章节，显式“编辑本章”才进入编辑器。 |
| `/novels/:id/simple`、`/novels/:id/story`、`/novels/:id/ai-usage` | 简易创作用 `getSimpleCreationShelf` 的章节及可读状态。短篇连续阅读收起，分段编辑时可按 `segment.id` 定位。用量页列当前筛选下的实际调用 `invocationId` | 分别显示所选章正文、连续短篇或用量汇总及调用明细。保留短篇分段草稿与版本、简易创作的升级入口、用量账本的游标及汇总。三者各自使用本页投影。 |
| `/tasks` 运行记录 | `listTasks({status, kind, keyword, cursor, limit})` 返回的记录，行键为 `(kind,id)`。状态、类型、搜索位于列表工具栏 | `getTaskDetail(kind,id)` 读取步骤、进度、错误与恢复位置。用 [getTaskHistorySourceHref](client/src/lib/novelRoutes.ts) 打开有效的站内来源。无来源可读详情。继续、恢复、重试等命令仅在相应创作页执行。 |
| `/lab/director`、`/auto-director/follow-ups` | 运行历史列 `listDirectorRuns` 与已有旧版历史。跟进页列 `listAutoDirectorFollowUps` 的事项 | “运行记录 / 导演跟进”移到导演工作区顶部。历史以 `runId` 对应详情，分别用 V2 的 `directorRoute`、旧记录的 `sourceRoute` 打开作品。跟进页复用 `directorTaskId`、按书查当前导演任务、筛选和批量选择规则，确认操作留在跟进详情。 |
| `/lab/director/:novelId` | 从 [书内工作台](client/src/pages/directorNext/workspace/README.md) 的 `WorkspaceBook` 投影当前类型的卷、章、角色、节拍或计划行 | 将 `ResourceDirectory` 的类型入口移至工作区顶部，保留其业务 `Selection`、生成跟随、审阅定位和正文编辑弹层。目录读取与导演运行投影分开。只把本书已保存或业务明确支持的项交给详情。`/lab/director/preview` 用现有样例，页面列表不请求真实作品。 |
| `/creative-hub`、`/chat-legacy` | 创作中枢用原会话列表。旧聊天用 `chatStore.sessions` | 中枢复用 `CreativeHubPage` 的选会话回调、`threadNavigationDisabled` 和 [资源绑定](client/src/pages/creativeHub/routing/creativeHubRouteBindings.ts)。右侧显示该对话的消息、输入、资料与待确认事项。归档、新建仍可达。旧聊天使用自己的会话存储。`/chat` 沿用重定向。 |

### 素材、工具与系统

| 路由或场景 | 中栏的真实对象 | 右侧呈现、数据依赖与交接 |
| --- | --- | --- |
| `/knowledge` → `/book-analysis` | 知识库列文档，索引页列已有作业，检索设置收起。书籍分析列分析记录 | 复用 [知识库页](client/src/pages/knowledge/KnowledgePage.tsx) 的文档详情、版本及标签，和 [分析工作区](client/src/pages/bookAnalysis/hooks/useBookAnalysisWorkspace.ts) 的 `analysisId/documentId/mode`。参考分析依赖所选文档及版本，作品诊断走其小说来源。分析结果、角色、章节阅读等视图在右侧切换。 |
| `/market-radar` | “当前榜单”列本次榜单条目，“AI 分析结果”列报告中的信号，“热门题材”列收藏项 | 复用扫描 → 选榜单项目 → 报告 → 选信号 → 简报的依赖。单行查看与加入多选分开。仅点击创作动作后带 `marketBriefId` 前往开书，不构造扫描历史接口。 |
| `/genres`、`/story-modes`、`/base-characters` | 题材树节点、故事模式树节点、全局角色素材 | 分别复用 `getGenreTree`、`getStoryModeTree`、`getBaseCharacterList`。树选择对接现有 `selectedId` 入参和父子关系，右侧显示节点详情、编辑或扩展候选。角色素材与书内角色使用各自 ID 及绑定动作。 |
| `/worlds`、`/worlds/:id/workspace`、`/worlds/generator` | 世界列表按世界 ID。进入单个世界后，资产页列该世界的实际资产，单份概览或生成表单收起 | 从摘要显式进入世界工作台。沿用 `worldWizardEnabled`、原标签和世界 ID 读取。挂到小说继续走现有世界绑定规则。 |
| `/titles`、`/style-engine`、`/anti-ai-rules` | 标题库条目、风格档案、写作规则。标题生成表单收起 | 标题的“生成候选 / 标题库”使用原标签，保留题材与目标小说。风格复用 `getStyleProfiles`、模板和绑定，规则复用 `getAntiAiRules` 及生效预览。右侧明确作用到全局、风格还是指定作品。 |
| `/prompt-workbench` | [提示词目录](client/src/pages/promptWorkbench/components/PromptCatalogSidebar.tsx) 中真实条目，以目录 `key` 选中 | 右侧常用调整、完整模板、上下文和试运行沿用能力标记。由章节打开的 `experience=writing&novelId=…&chapterId=…` 固定正文实验上下文，使用专属视图。换条目或作用域须保护草稿。 |
| `/comic`、`/comic/projects/:id`、`/drama`、`/drama/projects/:id` | 入口列各自的项目。项目内有分话、角色、场景等可选集合时，展示当前项目和当前类型的对象 | 选项目后读取对应详情，在右侧用现有工作台切类型、制作或导出。保留小说来源及各自 API 的返回形状。短剧按当前导航可见性保留直达入口。视觉资源库沿用“更多功能”中的弹窗和 `#visual-assets`，弹窗管理自己的集合。 |
| `/settings/models`、`/settings/model-routes` | 模型配置列厂商，模型路由列已有任务路由 | 右侧查看所选厂商、模型或任务路由，批量修改和保存沿用原页。设置分类使用画布标题处的一套导航，调整 Mac 样式对 `SettingsShell` 导航的隐藏规则。 |
| `/settings`、`/settings/director`、`/settings/knowledge`、`/settings/appearance`、`/settings/maintenance`、`/help` | 概览、单页设置及首作指南收起 | 概览进入对应设置，子页可横向切换分类。帮助沿用首作里程碑与推荐下一步。 |

## 四、实施阶段

按编号即可顺序执行。P0、P1 建立并验证共用交互，P2 至 P4 打通小说主线，P5 至 P7 接入其余业务。用户可以直接从想法开书，知识库、参考分析与市场简报都是可选来源。

- [x] **P0 · 建立列表槽与无列表布局**

  工程验证通过。导航组件 10 项、Mac 与客户端 typecheck。工作区自带的计划基线文字调整一并保留。

  核对 `git status --short --branch`、`git branch -avv` 和 `git worktree list`。工作区有非本计划的未提交改动时停下报告。从 `ai` 创建 `codex/mac-entity-lists`，分支已存在则切换并从首个未勾选阶段继续。在客户端平台边界、`MacAppLayout`、`navigation.ts` 和 Mac 主题接入列表槽。以“帮助”验证整宽画布，在导航组件测试中用两条记录验证列表入槽及抽屉。P1 接入正式运行记录页，未迁移页面暂留原入口。

  验收时，帮助没有空白栏，键盘跳过隐藏栏，开关抽屉只挂载一份业务控制器，Web 能在原位置操作列表。

- [x] **P1 · 完成运行记录样板**（依赖 P0）

  工程验证通过。导航 11 项、两端 typecheck、运行记录只读合同 1 项。

  在 `desktop_mac/renderer/src/features/tasks/` 拆出列表和详情，保留一个控制器，替换 `TaskFilters` 和画布内第二份列表。现有 `kind/id` 专指详情，类型筛选用独立参数 `filterKind`，关键词用 `q`，状态沿用 `status`。游标归属于当前筛选组合，筛选变更回最新，活跃记录沿用原轮询。无选中项时右侧提示选记录，窄窗首先展示列表，带有效详情深链时直接展示详情。

  用同 ID 不同 kind、首页以外的深链、非法 kind、404、空结果和后退分别验收。断言列表与选行只产生读请求，刷新及轮询均保留所选记录。

- [x] **P2 · 接通书架和新建**（依赖 P1）

  工程验证通过。导航 12 项、两端 typecheck、开书与书架合同 7 项。

  从 `MacNovelShelf` 的 render 模型提供列表，移除独立的前 100 本查询。书架引入 Mac 专用 `selectedNovelId`，宽窗首次进入时展示首本作品摘要，窄窗先选书。显式选书打开其摘要，“继续写作”才调用 `getNovelWorkspaceHref`。页外深链先读作品元数据，使短篇、V2、简易和专业创作均能解析正确入口。书架总览用 Mac 专用 `layout=overview` 打开原网格/工作台。旧链接只有显式 `view=shelf` 或 `view=workbench` 时打开对应总览。显式布局优先，选择对象的链接可独立还原详情。前进后退时从 URL 同步 `q/status/writingMode/narrativeForm/sort/page`，防止旧本地状态回写覆盖。

  新建画布提供五种入口，任务返回候选后开启中栏。用第二页作品、无作品、筛选无结果和四类作品入口验收。点击方向只预览，明确确认后才交给现有生成流程。

- [x] **P3 · 按书内阶段挂载目录**（依赖 P2）

  工程验证通过。导航 13 项、两端 typecheck、导演章节编辑与开书合同 29 项。拆章使用独立的规划章定位，避免将规划 ID 当作执行章 ID。

  在 `NovelEditView`、各阶段子组件和章节/预览/简易/短篇/用量页接入。保持项目设定 → 故事宏观规划 → 世界观准备 → 角色准备 → 卷战略 → 节奏与拆章 → 章节执行 → 质量修复的原导航和 AI 推荐。列出已有卷，选卷读取规划章，已有正文用真实章节 ID 打开。新卷无章时指向原规划入口，按活动步骤读取角色、章节或报告。现有 `NovelEdit.tsx` 超过 1,300 行，优先在视图和阶段模块工作。若必须扩展该控制器，先按职责拆出本阶段模块并核验入口。

  跨书后不得出现上一书的章或卷。同书切章保留目录搜索，预览选章仍在预览，取消离开编辑时原文、高亮和焦点仍对应原章。

- [x] **P4 · 接通导演与创作中枢**（依赖 P1、P3）

  工程验证通过。导航 13 项、两端 typecheck、创作与运行合同 40 项、书级恢复投影 16 项。现有跟进入口会清理旧任务参数，使用 followUpId 保存实际 directorTaskId。

  在 `DirectorRunHistoryPage`、`AutoDirectorFollowUpCenterPage`、书内 `NovelWorkspace` 和 `CreativeHubPage` 的状态所有者接入列表。保留当前/旧版运行、跟进和书内审阅的来源。导演角标取 20 条、历史页取 50 条，区分缓存键中的读取范围，避免只看待处理时误用角标的截断结果。

  同书两次运行可区分。书级 `failed/blocked/waiting_recovery` 在 URL 缺少导演任务 ID 时仍能从最新投影打开驾驶舱、任务抽屉与恢复入口。`workspaceTaskId` 仅属手工工作区。局部质量债仍显示提示，策略要求的人工暂停仍需显式恢复。另测导演预览、跟随生成、切会话时更新绑定、会话忙碌时禁用导航。

- [x] **P5 · 打通参考资料到开书**（依赖 P1、P2）

  工程验证通过。导航 14 项、两端 typecheck、拆书与提示词合同 30 项。索引列表只含接口返回的最近 30 项，市场扫描通过已知 runId 定位，没有扫描历史列表。

  迁移知识库、书籍分析、市场雷达的列表与既有详情。先让文档/版本和分析定位可恢复，再接结果页已有的参考开书、提取风格与市场简报入口。

  由具体分析带 `bookAnalysisId/sourceDocumentId` 或由雷达带 `marketBriefId` 开书时应还原来源。缺少版本、报告或候选时显示本阶段可用的下一步，用户显式选择生成后才调用 AI。

- [x] **P6 · 接入素材树与写作工具**（依赖 P3、P5）

  工程验证通过。导航 15 项、两端 typecheck、拆书与正文实验合同 30 项。世界地图与图谱为预留入口，未提供实际资产行，收起中栏；共享世界素材标明来源。

  先接题材/模式树、世界和角色，再接标题、风格与规则，最后接需要书章上下文的提示词工作台。工具入口由“更多功能”提供，中栏展示具体节点和条目。树组件目前读 `initialSelectedId`，同页连续选行需接入受控选择。

  用同名不同 ID 的节点、连续切工具、关闭世界向导、从章节进入提示词实验四个场景验收。核对详情、来源书章和未保存草稿。

- [x] **P7 · 接入改编项目、设置及兼容入口**（依赖 P0、P2）

  工程验证通过。导航 17 项、两端 typecheck、拆书与正文实验合同 30 项。短剧按现有可见性保留直达入口，视觉资源库使用原弹窗。

  漫画和短剧分别连接项目列表、分话/分集和项目详情。短剧在现有 `resolveMacNavigation` 会落入通用资料链接，实施时补齐独立上下文。迁移设置分类、模型/路由选择，核对旧聊天、视觉资源库与帮助入口。

  项目直达链接只加载对应项目类型。模型路由草稿可取消离开，视觉资源弹窗关闭后返回原对象，纯设置表单占满画布。

- [x] **P8 · 跨功能回归与 beta 集成**（依赖 P4、P5、P6、P7）

  工程验证通过。导航组件 20 项、路由与世界开关 2 项（47 个入口）、两端 typecheck、共享业务合同 72 项、导演工作区回归 20 项；功能候选的 Mac renderer 和 Web 生产构建均通过。 导演样例使用无路由也可渲染的业务视图，Mac 在自己的入口接入可分享定位。预发布合并结果与实机验收分开记录。

  清除旧中栏页面链接、重复读取和过渡适配。按 `appPageIds` 逐项核对 [路由覆盖表](desktop_mac/docs/route-parity.md)。本基线有 47 个子路由条目，含首页、重定向和通配 `*`。验证 `/writing-formula`、`/auto-director/follow-up-center`、`/auto-director/followup-center` 的落点，以及世界功能开关的两种状态。同步 [Mac 架构 Wiki](docs/wiki/architecture/mac-desktop.md) 的中栏规则与[实机验收清单](desktop_mac/docs/acceptance.md)。

  按项目流程将功能分支合入 `beta`，在组合后的提交上验证。编写计划时本地与远端均无 `beta`，且 `main` 不含 `desktop_mac/`。若届时仍无 `beta`，从 `ai` 当前提交建立本地 `beta` 再合入；不要从 `main` 建立，否则会把整条 `ai` 历史一起带进预发布线。已有 `beta` 时先确认它包含 `ai` 的 Mac 提交，不包含则停下报告。只在本地合并，推送 `beta`、提升到 `main` 及删除功能分支交由用户决定。记录目标 SHA、工程结果、待用户验收项。

### 阶段检查与提交

从仓库根目录运行与本阶段相符的命令。导航测试使用 JSDOM、内存路由和模拟 API。迁移时替换其中断言“中栏出现状态/设置分类/同组页面名”的旧用例，挂载实际业务提供者。保留已有的保存、取消、原生关闭和只读请求断言。

| 时机 | 命令及验收范围 |
| --- | --- |
| 每阶段 | `git diff --check`，暂存后执行 `git diff --cached --check` 和 `git diff --cached --stat`。按 `.agents/skills/readme-release-updater/SKILL.md` 核对用户可见影响，发布说明与 README 按实际交付更新。已落地的稳定边界同步到 Wiki。把勾选、检查证据和本阶段修改纳入同一提交。 |
| P0–P7 触及外壳、选择或保护 | `node --test desktop_mac/tests/navigation.test.mjs`，以及 `pnpm --filter @ai-novel/desktop-mac typecheck`。改到共享客户端同时执行 `pnpm --filter @ai-novel/client typecheck`。在受影响阶段用固定夹具覆盖加载/失败重读、空集合/无匹配、越页深链、快切 A→B 后 A 延迟返回等情形。 |
| P1–P4 按改动选跑 | 在支持项目 TypeScript 测试的 Node 环境执行 `node --experimental-strip-types --test client/tests/taskRecoveryReadOnly.test.js client/tests/directorShelfEntry.test.js client/tests/directorChapterEditing.test.js client/tests/creationStudioContracts.test.js client/tests/creativeHubWorkspaceViewModel.test.mjs`。 |
| P5–P7 按改动选跑 | `node --experimental-strip-types --test client/tests/bookAnalysisWorkspaceContracts.test.mjs client/tests/bookAnalysisWorkspaceViewModel.test.mjs client/tests/promptWritingLabContracts.test.js`。为原测试未覆盖的资源切换、回跳和模型草稿补针对性组件断言。 |
| P8 集成候选 | `pnpm --filter @ai-novel/desktop-mac build:renderer`。共享视图有变更时执行 `pnpm --filter @ai-novel/client build`。同一提交及输入有有效验证记录即可复用，记录 SHA、命令和覆盖范围。 |

### 用户实机验收

| 从哪里开始 | 通过条件 |
| --- | --- |
| 书架 → 搜索第 2 页作品 → 继续写作 → 阅读/编辑 | 中栏能辨认当前对象。短篇、简易、专业与 V2 各按其入口打开。预览切章只切阅读内容，编辑时取消离开可继续输入。 |
| 运行记录 → 状态/类型筛选 → 较早记录 → 来源页 → 后退 | 中栏一行一条记录，详情与行一致，回到原筛选和选中项。需要处理的创作事项在来源页有上下文。 |
| 知识库经参考分析开书，或由市场报告经简报开书 | 来源与所选版本/信号相符，用户可先查看，再决定生成。没有可用参考时仍能从想法入口创作。 |
| 创作会话 A/B、导演跟进、提示词或模型路由草稿 | 会话、作品、导演运行和草稿各自对应正确对象。忙碌、取消、保存失败和已删除记录均有明确反馈。 |
| 1440px 宽窗、960px 及以下窄窗、键盘操作和 ⌘R | 宽窗仅一份同类目录，窄窗能从详情返回列表，Esc 恢复焦点。工作区标签在窄幅仍可达，无集合页面留出完整画布。 |

工程阶段使用代码级回归。视觉、输入法和原生交互由用户在测试作品上验收，结果记入验收清单。计划本身属于内部文档，现行行为与发布说明的更新以各实施阶段落地为准。

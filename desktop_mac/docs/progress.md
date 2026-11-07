# Mac 桌面实施进度

## 基线与范围

- 日期：2026-11-06。实施基线 `MAC_BASE_SHA=e938bab605a24ac7242a35fd6ae9629cb9ea12ba`，功能分支 `codex/mac-desktop`。
- wukong 参考 `c610746be8684f79a9d1d763904a2acebda70ff6`，读取时工作区干净。
- 当前机器 arm64、macOS 27.2、Swift 6.4.2；编译目标 macOS 14。Intel、其他系统版本未验收。
- 新源码集中在 desktop_mac；相对实施基线，`server/**`、`shared/**`、`desktop/**`、`infra/server/**` 和 Web CSS 零差异。
- client 仅增加可选宿主入口、渲染覆盖、草稿/文档保护和无默认视觉影响的语义标记；Web 默认入口、主题、样式不变。

## 阶段状态

阶段 1–5 连续集成实施，统一通过检查后作为可运行的工程批次提交；避免把缺少连接/退出保护的窗口或依赖缺失的页面单独交付。

| 计划阶段 | 工程状态 | 用户验收状态 |
| --- | --- | --- |
| 0 基线 | engineering_done | Git、参考源码、工具与部署拓扑已核实 |
| 1 壳与连接 | engineering_done | 原生启停、文件交互、真实 SSE 待验收 |
| 2 风格样板 | engineering_done | wukong 风格及四类页面样板待验收 |
| 3 创作链 | engineering_done | 用测试小说完成创建→规划→正文→导出待验收 |
| 4 页面适配 | engineering_done | 47 个路由入口登记；复杂表单、窄窗与输入法待验收 |
| 5 命令与部署 | engineering_done | 只读远端预演完成；真实部署未执行 |
| 6 集成验收 | engineering_done | 已合入本地 beta；UI 为 user_acceptance_pending，不晋级 main、不推送、不上传 |

完整 UI 验收仍为 `user_acceptance_pending`。初始实施阶段没有默认运行浏览器、截图、Playwright、原生窗口或真实 AI 生成；后续应用户要求进行的实机观察见文末记录，不能代替全部页面与创作链验收。

## 工程验证记录

同一功能分支、相应源码最后修改后完成的检查：

| 检查 | 结果与证据 |
| --- | --- |
| `pnpm --filter @ai-novel/desktop-mac build` | 成功；包含 TypeScript、Vite 和 Swift 原生编译。`/tmp/mac-build.log` |
| 原生 bundle | `codesign --verify --deep --strict` 与 `plutil -lint` 通过；仅本机 ad-hoc 签名，不是公证包 |
| `node --test desktop_mac/tests/*.test.mjs` | 24 项通过，`/tmp/mac-tests.log`；涵盖进程归属、重复启动、退出取消、失败窗口保留、草稿环境身份、流式/二进制代理、静止检查、运行时选择、日志轮转及部署隔离测试 |
| `pnpm --filter @ai-novel/client build` | 成功，`/tmp/mac-web-build.log`；共享客户端之后无变更，复用此结果 |
| `pnpm --filter @ai-novel/client build:desktop` | 成功，`/tmp/mac-windows-renderer-build.log`；只验证 Windows renderer，不代表 Windows 安装包验收 |
| shared / server build | 成功，`/tmp/mac-server-build.log`；未修改后端代码 |
| 共享客户端针对性测试 | 15 项通过：章节草稿、质量债务、任务队列和恢复；不重复全量测试 |
| 继承的后端增量回归 | `initialCharacterSchedule.test.js` + `volumeChapterListChunking.test.js` 共 27 项通过；Node 22 + 临时 SQLite 路径，未用现有小说库做测试 |
| Make | `make list` 中文说明正确；`make -n dev_app app stop_app restart_app up_app` 仅打印命令，无解析期副作用 |
| Git 范围 | `git diff --check` 通过；相对 MAC_BASE_SHA 的受保护目录及 Web CSS 无改动 |

部署 Python 隔离用例包含 SQLite 备份完整性与损坏拒绝、维护入口的 health/GET 限制、14 个产物 rename 故障点的代码与依赖回滚、dry run 不进入写操作。没有以真实停服代替测试。

## 服务器只读预演

执行 `make up_app DRY_RUN=1`，服务器当前为 `eaa4bd8f0cb82972319290ff3b123025986e8641`，发布候选为 `origin/ai` 的 `09c9db638ff08e4c45f2dee4e0f496d2fdc93e19`。API、小说读取、服务归属及任务静止检查通过。候选对象尚未在服务器，且缺少绑定此 SHA 的验证记录，输出 `verified=false`；不宣称可部署。

服务器 Git SSH 无可用主机信任记录，部署器在确认 origin 属于指定公开 fork 后，通过同一仓库的 HTTPS 读取/fetch。没有改变服务器 origin、主机密钥或网络暴露面。

本轮未运行真实 up_app；没有 fetch 到服务器、创建远端部署目录/锁、更新源码、迁移、停服或开放端口。

## 实施决定与已知边界

- 使用 `createBrowserRouter` 保留真实路径并支持文档离开 blocker；普通 BrowserRouter 缺少所需上下文。
- Mac 不导入 Web main.tsx/index.css。书架、运行记录、设置为独立视图；其他业务页通过 Mac 容器、独立主题和组件标记呈现，复用其业务操作合同。视觉一致性按 acceptance.md 逐项验收。
- 自动 dirty/save 覆盖章节、短篇正文、创建想法、手动建书、卷章规划、提示词、模型路由；其余可编辑页明确要求在本页保存并确认离开，不谎报自动保存。详见 route-parity.md。
- 本机数据库首版仅接入仓库内已存在的 SQLite；不自动新建、迁移或处理 PostgreSQL。数据库或任务状态无法完整验证时保留服务并报错。
- Node 26 缺预编译 SQLite 且源码编译出现 V8 API 不兼容；使用机器已有 Node 22 重建依赖成功。启动器以内存 DB 探测兼容性；直接启动原 ts-node-dev 服务入口，避免原 dev 脚本隐式数据库同步。
- 红色关闭隐藏窗口并保留 WebView，Dock 重开；⌘Q/stop_app 正常退出。新窗口失败且拒绝关闭时保留全套辅助服务，不再打开另一窗口。
- SSH supervisor 自动重连传输，不重放写请求；辅助日志每流最多 5×10 MiB。
- 部署采用 `.runtime/desktop_mac-deploy/<时间>-<SHA>/` 批次目录；有 preflight/quiesced 两次快照和事务恢复记录。普通 up_app 不覆盖持久数据、不执行迁移。
- 临时验证日志位于 /tmp；长期规则保存在 wiki，交接证据以此表和 Git 提交为准。没有公开打包或发布。

## Beta 集成范围

main 基线 `2b33ff04a3c6b56be61d57579ef6b9bc9bcd27ed`；Mac 基线继承 main 尚未包含的 10 个 ai 提交（服务器运维、长节奏段章节额度、角色出场计划及相应文档）。这些不是本次新增后端修改。已补充 server build 和上述 27 项针对性回归；服务器实际更新仍需发布候选自己的验证记录。

`git ls-remote --heads origin beta` 返回空，未发现远端 beta；本地也无该分支。从已核对 main 创建本地 beta，合并工程提交 `9a699824`，集成提交为 `295a4c03`。main 与 ai 各有一个等价的技能说明提交，历史并非直接祖先关系；合并无冲突，`git diff codex/mac-desktop..beta` 为空，产物对应的源树完全相同。因此复用上述 Mac/Web/Windows renderer 构建及针对性检查，不重复昂贵构建。

提交后的代理断流处理单独运行 transport 3 项通过；仅空白和文档更新不使其他检查失效。README 最新更新与完整发布历史同步为 2026-11-06 的 Mac 源码预览说明；wiki 已记录长期边界。集成记录提交仅更新进度文档，没有额外用户可见行为，不重复添加发布说明。

当前交付分支为本地 beta。功能分支 `codex/mac-desktop` 保留等待 UI 反馈；main 保持 `2b33ff04`，未推送、未发布、未部署。用户验收步骤见 acceptance.md；收到反馈后在功能分支修正，再进入 beta。


## 启动问题修复与实机信号验证（2026-11-06）

用户首次运行暴露的主因是 SSH 别名身份比较缺陷；dev_app 同时缺少本地配置和数据库。只读确认 15173 的 `/usr/bin/ssh` 使用 `my-server`，`ssh -G` 将其解析为 `root@152.136.155.200:22`，转发目标为服务器 `127.0.0.1:18080`。补充精确 argv 与解析后身份匹配，不取消未知进程保护。

实际启动复验还发现并修正了三个运行契约缺口：focus 回复缺少身份字段、launchd 的 xpcproxy 过渡 PID 被过早记录，以及原生窗口先于 Vite HTTP 就绪而首次加载失败。补充对应回归验证。

用户明确选择新建独立空测试库后，创建 `.runtime/desktop_mac/local/test.sqlite` 和私有 `server/.env`，均为忽略的本机运行数据。创建前确认目标不存在，初始化仅作用于全新空 SQLite；没有迁移或改写已有小说库。当前 Prisma CLI 对不存在的 SQLite 报空 Schema engine error；底层只读探测确认是 P1003，先独占创建空 SQLite 文件后再初始化成功。完整性检查为 ok、Novel 数量为 0。首次后端启动仅补齐其原有内置创作素材。模型密钥未从服务器导入，RAG 暂按未配置检索服务关闭。

验证结果：

- 实际 `make app` 返回 `started/remote`，原生 rendererReady、HTTP/API 健康通过；重复执行返回 `focused`。
- 实际 `make dev_app` 返回 `started/local`，本机 API 3000、Vite 15174 和原生 rendererReady 通过；重复执行返回 `focused`。
- 修复后 `make stop_app` 返回 `stopped` 且 retained 为空；重复停止成功。自有 API/Vite/窗口已退出，原有 borrowed 隧道 PID 15678 保留且 health 为 200。
- Node 针对性测试 29 项通过，日志 `/tmp/mac-startup-tests.log`；两种实际启动日志分别为 `/tmp/mac-app-startup-check.log`、`/tmp/mac-dev-startup-check.log`。原生 Swift 在上述启动检查中重新编译通过。
- Web/client/server 源码和依赖锁文件此次均未改动，复用前一阶段的构建证据；未重复 Web/Windows 全量构建。
- 此次仅验证启动、聚焦、退出和就绪信号，没有截图或页面编辑操作；视觉、输入法和真实 AI 创作仍待用户验收。没有执行部署或推送。

验证期间曾将新建 helper 的身份误记为 xpcproxy；修复后，先保存 `.runtime/desktop_mac/state.before-identity-recovery.json`，核对该 helper 的 PID、启动时间、launchd 标签/目录/完整参数，再只修正本次自有进程的身份记录并正常退出。未强杀或停止借用通道。


## 导航与离开提醒修复（2026-11-06）

基线为本地 beta `94f7b975`，修复分支 `codex/mac-navigation-fix`。用户反馈的两个现象分别来自静态路由 manualReview 永久拦截，以及跨页面沿用 selectedNovelId。前者与真实编辑状态无关，后者使全局工具错误展示旧小说章节。

处理范围：

- 删除按路由永久确认的规则，只让注册编辑器的 dirty/busy 控制路由切换和原生退出；保存成功不再追加页面确认。覆盖表明确标记未接入统一保护的表单，仍需页内保存，不宣称已保护所有输入。
- 以当前路由统一决定主菜单选中、标题、列表内容及展开按钮。书架/对话/导演记录/状态筛选/项目/设置分类分别读取或展示自身内容；只有作品页面显示章节。进入章节编辑默认折叠，可主动展开；全局菜单不读取之前小说的章节。
- 运行记录状态进入 URL，侧栏、页内筛选及历史导航同步；列表仍只读。隐藏的侧栏不接受键盘焦点，移动抽屉与桌面折叠分别处理。
- 参考 `/Users/likai/go/src/write/wukong/web/src/app/AppShell.jsx` 的 view/hasLibrary 合同及 NavigationSidebar 的选中逻辑；已在用户指定目录核实参考源码，没有修改 wukong。

验证：

- `node --test desktop_mac/tests/navigation.test.mjs`：6 项通过，涵盖干净页面导航/原生退出、有修改时取消及保存、保存失败/忙碌、各菜单侧栏隔离、只读筛选和历史返回、章节目录展开及取消导航；日志 `/tmp/mac-navigation-tests.log`。这是 Node/JSDOM 隔离组件测试，API 与原生桥为模拟，无真实业务写入。
- 直接执行已安装的 TypeScript `tsc -p desktop_mac/tsconfig.json --noEmit` 通过；Vite renderer 生产构建通过。日志 `/tmp/mac-navigation-typecheck.log`、`/tmp/mac-navigation-build.log`。初次 pnpm 包装命令受其自身版本签名联网校验限制，因此验证使用同一已安装编译器入口，没有把包装命令失败记为类型错误。正常网络权限下 `pnpm --version` 已确认返回 10.6.0。
- Mac 显式声明 JSDOM 测试依赖，复用锁文件已有 27.4.0 包与快照；已核对声明和锁文件一致，`pnpm --filter @ai-novel/desktop-mac install --lockfile-only --offline --frozen-lockfile --ignore-scripts` 通过，其他 workspace 的依赖版本不变。
- 未改 client、server、shared、旧 desktop 源码；原生壳、进程与部署脚本未变，复用上一阶段启动/聚焦/退出及生命周期测试证据，不重复构建原生壳或全量 Web/Windows。
- 未执行浏览器、截图或人工 UI 验证，未重启用户正在使用的窗口，未访问或改动本机/服务器小说数据。界面验收步骤已补入 acceptance.md；服务器模式需 `make restart_app` 重建后查看。

## Wukong 视觉细节对齐（2026-11-06）

从本地 beta `b4e22927` 建立 `codex/mac-visual-alignment`。用户明确要求结合运行中的 wukong 与源码优化，因此本阶段执行了原生窗口截图及只读交互检查。经用户单独授权，Luna 子代理只读比较样式；主代理复核完整 CSS 级联，特别补齐 `demo.css` 的灵感列表覆盖。

范围为 Mac renderer、针对性测试及文档：两行工具栏布局、16px/1.5px 图标、244px 浅灰中栏、32px 搜索框、浅蓝选中与细蓝指示条、外侧 16px 顶角、UI 字重与写作字体回退。中栏可搜索已加载条目，切换功能清空查询；书架工作区搜索限制最大宽度。`client/`、`server/`、`shared/`、旧 `desktop/`、原生壳和生命周期代码均无本轮改动。

验证与边界：

- Mac TypeScript 检查通过，日志 `/tmp/mac-visual-typecheck.log`；Node/JSDOM 组件回归 7 项通过，日志 `/tmp/mac-visual-tests.log`，新增搜索/清空/章节序号用例，既有保存保护与菜单回归通过。
- 实际 `make app` 完成 Vite 与原生编译并返回 `started/remote`，运行构建 `e9750d330ff92494720c14d1f18ff36ee7438205bdccf2685e860944f6157663`；日志 `/tmp/mac-visual-launch.log`。未单独重复全量 Web、Windows、后端或打包验证，这些源码未改。
- 与运行中的 wukong 灵感页对照，观察新版书架和设置页；验证中栏搜索空结果、切换分类自动清空、普通导航无确认、折叠后圆角转移、展开及更多菜单/Escape。最终窗口保留在服务器模式书架，搜索为空。
- 初次 `make restart_app` 对旧构建的退出请求超时并保留窗口，未强制结束应用。随后通过原生应用菜单正常退出；发现旧专用界面代理仍占用 15175，核实完整命令、PID、仓库和 launchd 归属后仅卸载该代理，再正常启动新版。该次超时原因未在本阶段确定，不能将其记为 restart 回归通过；保留 `/tmp/mac-visual-restart.log` 作为现场记录。
- 实机操作限于书架与设置概览的浏览、搜索和布局切换；未编辑正文、改变设置、发起 AI 生成或部署服务器，既有 borrowed SSH 通道保留。正文输入法、窄窗及全部复杂业务页面仍需用户验收。
- 视觉的长期维护规则已补入 wiki 和 mac.md；README 与发布记录同步用户可见变化。本阶段通过后进入本地 beta，尚不晋级 main 或推送发布。

## 业务页面视觉与交互检查（2026-11-06）

基线为本地 beta `47872b8c`，工作分支 `codex/mac-page-polish`。用户明确要求逐个点击相关菜单及按钮；经本轮具体授权，两个 Luna 子代理分别只读检查章节编辑与其他业务页的样式缺口，主代理修改并操作原生窗口复核。参考为运行中的 wukong 及其正文、列表、工具栏源码。

实现限于 Mac renderer、针对性测试和文档：章节独立页面及导演内全屏编辑层适配文楷、段距、正文宽度和紧凑分栏；创作中枢的会话、输入区和资料区按可用空间布局；外层目录按工作台分别记忆收展。补齐资产库、设置、漫画、普通弹窗和图标按钮的样式覆盖，设置去掉重复导航，运行记录进度条使用 Mac 色彩。取消目录网格/透明度及菜单选中动画，避免后台窗口保留旧选中或空白栏。

实际交互覆盖：

| 页面 | 本轮操作与观察 |
| --- | --- |
| 章节编辑 | 独立路由、导演内全屏编辑；左右栏收起及恢复；查找栏输入查询并关闭；设置、版本弹窗打开关闭；正文未输入或保存 |
| 导演 | 历史记录、书内目录、卷及节奏段、章节阅读；导演台收展、世界地图、角色关系图入口；跟进中心空态 |
| 创作中枢 | 默认收起外层目录、主动展开并恢复；输入区可见、右侧资料滚动区域、运行调试详情；未绑定小说或发送内容 |
| 资料 | 书籍分析列表及新建拆书弹窗；市场雷达三个标签；知识库创作资料、索引与任务 |
| 素材与工具 | 题材、故事模式、世界设定、角色素材；标题工坊的自由工坊和标题库；写作风格、提示词工作台、写作规则入口 |
| 改编 | 短剧入口及来源向导；漫画列表、已有项目、分话大纲/角色/场景/格子图/导出标签；未生成图片或创建项目 |
| 设置与基础入口 | 六个设置分类逐项导航；模型路由、导演设置、知识库与写法、维护页面布局；新建、书架、帮助、运行记录及记录选择 |

代码与构建证据：

- 本轮 `tsc -p desktop_mac/tsconfig.json --noEmit` 通过；`node --test desktop_mac/tests/navigation.test.mjs` 8 项通过，新增工作台收展偏好隔离用例。后续只改 CSS 与文档，复用该类型/导航检查，不重复执行。
- 最终 `make app` 完成 Vite renderer 生产构建、Swift 编译及本机签名，返回 `started/remote`；构建指纹 `70d4d934f34b0fafecab09255803260efff09bebd3583d519c3fbe5de3e2daeb`，日志 `/tmp/mac-page-polish-complete-launch.log`。对最终构建复核章节段距、菜单选中、漫画分区、记录进度条及新建输入区，窗口保留在创作中枢。
- `git diff --check` 通过；`client/`、`server/`、`shared/`、旧 `desktop/`、依赖锁及原生/生命周期实现无本轮改动。未重复全量 Web/Windows/后端测试，未部署或公开打包。工作中出现的无关未跟踪目录 `ani/` 保留并排除提交。

限制与现场记录：

- 两次 `make restart_app` 在旧窗口正常退出请求上超时并保留旧服务；日志 `/tmp/mac-page-polish-restart.log`、`/tmp/mac-page-polish-final-restart.log`。之后通过聚焦和原生退出正常关闭，确认旧进程退出再 `make app` 启动；未强杀、删除状态或停止 borrowed SSH。此问题仍不能记为重启回归通过，本轮没有更改退出协议。
- 操作不包括正文编辑/保存、替换、生成小说或图片、恢复任务、修改模型配置、删除或归档；章节页面自带自动分析及模型路由页面的自动检测会按原业务逻辑运行，因此不宣称无任何 AI 调用。
- 知识库中已有索引失败记录仍可见，未修改其后台逻辑。窄窗、中文输入法、字号/布局偏好更改、真实写入保存及完整 AI 创作链留给测试作品验收；本轮不是全功能或所有窗口尺寸的通过证明。
- Wiki 已补充 portal 编辑层、Plate 段落、图标点击区、目录所有权和可用画布布局的长期维护规则，README 与发布历史同步用户可见结果。按本地 feature → beta 流程集成；main、远端和服务器不在本轮发布范围。

## 服务器模式的桌面依赖（2026-11-07）

- 基线为 `ai` 的 `91b6c993`。验证覆盖 `make app` 和服务器模式重启在构建、聚焦与关闭旧窗口前的依赖检查。
- 使用真实 pnpm 和隔离的离线工作区复现缺失或损坏的 Vite 命令、缺少客户端依赖、切换锁定版本及冻结安装失败。在 `NODE_ENV=production` 下，依赖、生命周期、构建输入和运行适配器的 18 项测试全部通过。
- 在本机运行 `make app` 返回远程模式的 `started`，再次运行返回 `focused`。依赖齐全时两次均跳过安装。

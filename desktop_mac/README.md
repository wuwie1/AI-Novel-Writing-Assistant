# Mac 桌面版

Swift / AppKit / WKWebView 原生窗口，加载本机构建的独立 React 界面。布局、颜色、字体取自 wukong；Web 与 Windows 使用原有入口。首版面向 Apple Silicon、macOS 14 及以上；当前编译机器为 macOS 27.2，其他系统的实际操作尚待验收。

## 启动

需要 Xcode Command Line Tools、Node 22（建议）与仓库指定的 pnpm、Python 3、当前用户的图形登录会话；服务器模式另需能免交互登录 `root@152.136.155.200` 的 SSH 配置。SSH 主机密钥必须事先核实；脚本不会关闭主机密钥检查。

在仓库根目录执行以下命令即可连接服务器。

```bash
make app
```

启动时会检查本机桌面依赖，缺失或与当前分支不一致时按锁文件补齐，再打开窗口。安装失败时可在终端查看 pnpm 的具体原因，处理后重新运行同一命令。用 `make list` 查看命令，`make stop_app` 退出，`make restart_app` 按上次请求的模式重启。

用浏览器访问远端时，运行 `make ssh_server`，打开终端显示的小说助手或 Qdrant 管理页地址。任一隧道中断时可再次运行同一命令恢复，执行 `make stop_app` 后也可继续使用浏览器。[本地通道与端口](../infra/server/README.md#本地通道)

使用本机测试后端时，先准备 `server/.env`、本机数据库与后端依赖。

```bash
pnpm --filter @ai-novel/desktop-mac... --filter @ai-novel/server... install --frozen-lockfile
make dev_app
```

要明确选择本机模式重启，可运行 `make restart_app APP_MODE=local`。

本机后端启动前用内存数据库检查 Node 与 SQLite 原生依赖是否兼容；依次检查当前 Node 和 Homebrew 的 Node 22/24，可用 `MAC_SERVER_NODE=/absolute/path/node` 指定。当前机器 Node 26 与锁定的 SQLite 依赖不兼容，已用本机 Node 22 重建依赖。安装和重建也应使用同一 Node；脚本不自动升级依赖。缺少 Prisma Client 时先运行 `pnpm --filter @ai-novel/server prisma:generate`（仅生成客户端）。

`make app` 使用本机构建的 Mac 界面，经本机代理、SSH 隧道访问服务器的 `127.0.0.1:18080`。服务器已有 API 映射，无需公开业务端口。`make dev_app` 使用 Vite 和本机 API；直接启动已有 TypeScript 服务入口，避开原开发脚本中的自动数据库同步；不会自动创建数据库、迁移或清空数据。

红色关闭按钮隐藏窗口，Dock 可重新打开；`⌘Q` 和 `stop_app` 退出应用。窗口位置和上次页面按后端身份隔离保存。SSH 通道断开后会重连，生成和保存请求不会自动重放。

已有 SSH 通道使用别名（例如 `my-server`）时，会解析实际主机、账户、SSH 端口与连接配置再判断能否复用；转发端口和目的地也须一致。复用的通道始终保留借用归属。

同模式重复启动聚焦已有窗口。重启会先准备当前版本的构建产物，再请求保存并退出。保存失败或取消退出时保留现有窗口。只停止经归属验证的自有进程。借用的 API、隧道以及服务器服务会继续运行。本机 API 存在活跃任务或状态不能完整确认时继续保留，重复 `stop_app` 可再次检查。

如果终端提示“旧版窗口的页面未就绪”，从 Dock 打开 AI Novel，先在页面内保存或复制仍可见的草稿，按 ⌘Q 退出，再运行原命令。对于新窗口，页面仍在加载时会弹出原生退出确认。保存、生成或其他确认进行中时，按终端提示回到窗口处理。

界面和 Swift 窗口分别缓存。源码、配置和工具链匹配时会复用已验证的产物；本机开发模式通过 Vite 加载界面。终端和 `.logs/desktop_mac/lifecycle.log` 会按命令名和 PID 显示缓存结果、等待退出、服务注销、连接和页面就绪等阶段的耗时。有草稿需要处理时，窗口会回到前台提示保存。

## 导航与保存

列表栏跟随当前功能：书架显示作品，创作中枢显示对话，导演显示创作记录，运行记录显示状态筛选，设置显示分类；进入作品后显示该作品章节。资料与写作工具显示同类入口，短剧与漫画显示项目列表。

列表上方可搜索当前已加载的作品、章节、对话、项目或分类；切换功能后清空搜索。章节可按标题或序号查找。顶部的分栏按钮可折叠列表，把空间留给正文。

离开时只对编辑器登记的未保存内容或正在执行的保存/生成进行保护；普通浏览不要求确认。其他表单需使用页内保存，具体覆盖范围见 [页面覆盖](docs/route-parity.md)。

## 本机测试环境

`make dev_app` 要求已有本机 `server/.env` 和测试库。缺少时需先明确选择新建空库或接入已有库；启动命令本身不自动初始化、同步 schema 或复制服务器数据。新建库仅允许在确认不存在的独立路径初始化，不能对已有小说库照搬初始化命令。

本机配置至少包括 `HOST=127.0.0.1`、`ALLOW_LAN=false`、`AI_NOVEL_DATABASE_MODE=sqlite` 和指向已准备库的绝对 `DATABASE_URL=file:/...`。首次空库需要单独配置本机模型服务；服务器中的小说和模型密钥不会自动导入。没有配置资料检索服务时可先使用 `RAG_ENABLED=false`。

## 配置

优先级：命令环境变量 > `.runtime/desktop_mac/config.json` > 默认值。复制 [配置示例](config/app.example.json) 后将权限设为 `0600`，不要存放密码或模型密钥。端口必须互不冲突。

| 配置 | 默认值 | 环境变量 |
| --- | --- | --- |
| 本机 API | 3000 | `LOCAL_API_PORT` |
| 开发界面 | 15174 | `DEV_UI_PORT` |
| 构建界面 | 15175 | `APP_UI_PORT` |
| SSH 通道 | 15173 | `TUNNEL_PORT` |
| 本机 Qdrant 管理页 | 16333 | `QDRANT_TUNNEL_PORT` |
| SSH 主机 | root@152.136.155.200 | `SSH_TARGET` |
| 服务器 Web | 18080 | `REMOTE_WEB_PORT` |
| 服务器 Qdrant | 6333 | `REMOTE_QDRANT_PORT` |
| 维护探测 | 18081 | `MAINTENANCE_PROBE_PORT` |
| 服务目录 | /data/write/AI-Novel-Writing-Assistant | `SERVER_DIR` |
| 本地与服务器须匹配的发布分支 | `current`（当前分支） | `DEPLOY_REF` |

配置文件、运行状态和构建放在 `.runtime/desktop_mac/`，日志放在 `.logs/desktop_mac/`，每个输出流单文件最多 10 MiB，最多保留 5 个文件。状态损坏、未知端口或进程身份变化时脚本拒绝猜测和停止进程；先查看错误中的日志、状态与锁路径。不要用批量 `pkill node` 或删除数据库来解决启动问题。

## 更新服务器

从本地发布分支部署已提交的代码并重启服务，可在 Codex 项目聊天里输入“服务器更新”。也可在仓库根目录执行以下命令。

```bash
make server_update
```

`server_update` 默认部署本地干净工作区当前分支的 HEAD。两端的 `origin` 须指向指定 fork，服务器须检出同名发布分支。若在配置中显式设置了 `origin/<分支名>`，该值会额外限定可部署的分支。尚未推送的提交也可部署。服务器缺少候选对象时，本机会通过 SSH 传输增量 Git bundle。

只想查看待部署版本和任务状态时，运行 `make server_update DRY_RUN=1`。若服务器还没有候选对象，兼容性要在正式更新导入 bundle 后才能验证。

正式更新会核对线上版本、前后端和依赖的内容校验值，以及 Node 和 pnpm 版本。首次使用增量部署或更换运行工具链时，命令在 Linux 上完整构建一次，建立校验基线。此后按终端的 `deployment_plan` 选择操作。

| 模式 | 执行内容 |
| --- | --- |
| `restart` | 提交、工具链和产物均一致。检查任务、排空连接，重启 Web 和 API，验收首页、健康接口和小说读取。沿用上次版本的回滚位置。 |
| `incremental` | 只重建受影响的 `client/dist` 或 `server/dist`，在私有构建目录复用已校验的 Linux 依赖，运行回归并替换选中的目录。 |
| `source` | 变更与 Web、后端产物无关。更新源码和发布记录，保留原产物。仅测试输入变更时运行回归。 |
| `full` | 共享包、依赖、全局构建输入变化或缺少既有基线。完整构建并验证新版本。 |

每次执行输出阶段耗时。`remote_total.log` 字段给出本次 `timings.json` 路径，`local_timing` 的 `total` 包含本机预演和 SSH 时间。构建明细在验证记录 `validation.json` 的 `evidence` 中。切换前会临时关闭只读实况订阅并阻止重连，更新完成后自动恢复；实际生成任务和生成连接仍受停服保护。若切换前仍有连接，命令最多等待约 30 秒排空。之后重试同一候选时，只要基线、工具链和待发布的产物仍通过校验，可复用上次成功的构建。

如果 CI 或开发机已为该提交完成完整构建、类型检查和相关测试，可用 `DEPLOY_VALIDATION_FILE=/absolute/path/validation.json` 复用验证。服务器仍安装或复用经校验的 Linux 依赖，生成后端产物、构建前端并执行本机冒烟测试；后端生成使用 `--noCheck`，避免小内存主机重复承担完整类型检查。有记录时构建进程的 Node 堆限制为 2 GiB。没有记录时继续执行完整构建。现有记录须符合以下格式。

```json
{
  "sha": "经过检查的完整40位提交SHA",
  "ref": "origin/<当前分支名>",
  "passed": ["server-build", "client-build", "targeted-tests"],
  "evidence": "对应的构建及测试日志位置"
}
```

记录须来自该提交真实完成的检查。若复用较早检查，须确认构建输入和工具链未变，并在 evidence 中记录原提交、日志和对比依据；不能只改写 SHA。服务器的 `validation.json` 保存外部记录及本机实际执行的步骤和日志。部署和 GitHub 推送是独立操作。schema、迁移、数据库启动兼容代码或数据库依赖变化时，需单独审查升级方案。

更新时先隔离构建并完成预备份，再关闭新 API 请求。两次确认任务空闲且连接已排空后，停服保存最终备份，切换源码、依赖和产物。内部探测通过后恢复正式入口，等该入口也能读取小说列表，再将服务器发布分支快进到本次提交。版本切换保留两份经校验的 SQLite 快照、资产、配置和源码。旧产物按内容保存一份，可从 `backups/preflight/release.json` 找到每个目录的回滚副本。成功回执的 `backup` 给出服务器上的备份路径。

健康检查持续失败时，命令恢复原版本和服务状态。若上一次回滚后服务器停在 detached HEAD，重新运行同一条命令会核对部署清单、事务记录和分支历史。三者一致时可直接重试。遇到来源不明的工作区或中断的事务，按部署文档核对现场。[部署与回滚](../docs/wiki/architecture/mac-desktop.md#部署与回滚)

更新成功后自动清理无引用的历史备份和构建产物，保留当前版本、上一版本所需的恢复资料及验证记录。同版本重启沿用这两版资料，重复重启记录会随后续成功更新清理。删除前会校验保留的备份；校验失败或目录归属不明时保留现场。终端的 `cleanup_complete` 显示回收空间，`cleanup_warning` 表示清理需检查，但服务仍运行成功部署的版本；具体清单见该批次的 `cleanup.json`。手工备份、业务数据和图片不在此自动清理范围内。

## 验证与验收

```bash
pnpm --filter @ai-novel/desktop-mac typecheck
pnpm --filter @ai-novel/desktop-mac test
pnpm --filter @ai-novel/desktop-mac build
```

`build` 编译源码启动使用的 `.app`，不是公开发布、公证或安装包上传。版本从 `desktop/package.json` 派生；不修改旧 Windows 运行路径。

见 [实施进度](docs/progress.md)、[页面覆盖](docs/route-parity.md)、[用户验收](docs/acceptance.md)。代码检查不能证明原生窗口、输入法、实际 AI 生成和视觉一致性已验收。

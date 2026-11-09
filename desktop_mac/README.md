# Mac 桌面版

Swift / AppKit / WKWebView 原生窗口，加载本机构建的独立 React 界面。布局、颜色、字体取自 wukong；Web 与 Windows 使用原有入口。首版面向 Apple Silicon、macOS 14 及以上；当前编译机器为 macOS 27.2，其他系统的实际操作尚待验收。

## 启动

需要 Xcode Command Line Tools、Node 22（建议）与仓库指定的 pnpm、Python 3、当前用户的图形登录会话；服务器模式另需能免交互登录 `root@152.136.155.200` 的 SSH 配置。SSH 主机密钥必须事先核实；脚本不会关闭主机密钥检查。

在仓库根目录执行以下命令即可连接服务器。

```bash
make app
```

启动时会检查本机桌面依赖，缺失或与当前分支不一致时按锁文件补齐，再打开窗口。安装失败时可在终端查看 pnpm 的具体原因，处理后重新运行同一命令。用 `make list` 查看命令，`make stop_app` 退出，`make restart_app` 按上次请求的模式重启。

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
| SSH 主机 | root@152.136.155.200 | `SSH_TARGET` |
| 服务器 Web | 18080 | `REMOTE_WEB_PORT` |
| 维护探测 | 18081 | `MAINTENANCE_PROBE_PORT` |
| 服务目录 | /data/write/AI-Novel-Writing-Assistant | `SERVER_DIR` |
| 发布线 | origin/ai | `DEPLOY_REF` |

配置文件、运行状态和构建放在 `.runtime/desktop_mac/`，日志放在 `.logs/desktop_mac/`，每个输出流单文件最多 10 MiB，最多保留 5 个文件。状态损坏、未知端口或进程身份变化时脚本拒绝猜测和停止进程；先查看错误中的日志、状态与锁路径。不要用批量 `pkill node` 或删除数据库来解决启动问题。

## 更新服务器

从本地发布分支部署已提交的代码并重启服务，可在 Codex 项目聊天里输入“服务器更新”。也可在仓库根目录执行以下命令。

```bash
make server_update DRY_RUN=1
make server_update DEPLOY_VALIDATION_FILE=/absolute/path/validation.json
```

`server_update` 锁定当前干净工作区的 HEAD，要求本地和服务器位于配置的发布分支。服务器缺少候选对象时，经 SSH 传输从服务器基线到该提交的 Git bundle。版本相同时可直接运行 `make server_update`，仍会重启并检查 API 和网页服务。切换版本所需的验证记录格式见下文。

要部署 fork 远端发布分支的版本，可使用 `up_app`。

```bash
make up_app DRY_RUN=1
make up_app DEPLOY_VALIDATION_FILE=/absolute/path/validation.json
```

预演只读检查远端发布 SHA、服务与数据位置、兼容性和任务静止状态；不会 fetch、创建远端目录/锁、构建或停服。候选 Git 对象不在服务器时会说明尚未验证，不能把预演输出当成部署通过。

目标仓库的 origin 必须匹配指定 fork。`up_app` 通过该 fork 的 HTTPS 地址查询并抓取发布分支，`server_update` 通过现有 SSH 连接传输本地候选。

真实更新只允许当前发布分支的快进，候选 SHA 需要验证记录。例如：

```json
{
  "sha": "经过检查的完整40位提交SHA",
  "ref": "origin/ai",
  "passed": ["server-build", "client-build", "targeted-tests"],
  "evidence": "对应的构建及测试日志位置"
}
```

记录必须来自该提交真实完成的检查，不应照抄示例声明成功。命令不推送代码、不改变发布分支、不运行数据库迁移。schema、迁移、数据库启动兼容代码或数据库依赖变化时拒绝普通更新，需单独审查升级方案。

更新时先隔离构建并完成预备份，再关闭新 API 请求。两次确认任务空闲且连接已排空后，停服保存最终备份，快进源码，替换依赖和产物。服务通过健康检查后恢复对外入口。两次 SQLite 备份均校验完整性，资产、配置、源码和旧依赖也会保留。服务器在 `.runtime/desktop_mac-deploy/` 下为每次更新保留独立目录，成功回执的 `backup` 给出本次备份路径。

失败回滚只恢复源码和依赖/产物，绝不还原或覆盖数据库。回滚源码可能停在 detached HEAD；先核对事务记录和旧 SHA，再恢复发布分支。异常中断会保留 `transaction.json`，下一次更新拒绝覆盖未完成事务；人工恢复步骤见 [部署边界](../docs/wiki/architecture/mac-desktop.md)。

## 验证与验收

```bash
pnpm --filter @ai-novel/desktop-mac typecheck
pnpm --filter @ai-novel/desktop-mac test
pnpm --filter @ai-novel/desktop-mac build
```

`build` 编译源码启动使用的 `.app`，不是公开发布、公证或安装包上传。版本从 `desktop/package.json` 派生；不修改旧 Windows 运行路径。

见 [实施进度](docs/progress.md)、[页面覆盖](docs/route-parity.md)、[用户验收](docs/acceptance.md)。代码检查不能证明原生窗口、输入法、实际 AI 生成和视觉一致性已验收。

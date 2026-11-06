# Mac 桌面版

Swift / AppKit / WKWebView 原生窗口，加载本机构建的独立 React 界面。布局、颜色、字体取自 wukong；Web 与 Windows 使用原有入口。首版面向 Apple Silicon、macOS 14 及以上；当前编译机器为 macOS 27.2，其他系统的实际操作尚待验收。

## 启动

需要 Xcode Command Line Tools、Node 22（建议）与仓库指定的 pnpm、Python 3、当前用户的图形登录会话；服务器模式另需能免交互登录 `root@152.136.155.200` 的 SSH 配置。SSH 主机密钥必须事先核实；脚本不会关闭主机密钥检查。

在仓库根目录运行：

```bash
pnpm --filter @ai-novel/desktop-mac... --filter @ai-novel/server... install --frozen-lockfile
make list
make app
# 本机开发测试：需要现有 server/.env 及已准备好的本机数据库
make dev_app
make stop_app
make restart_app
make restart_app APP_MODE=local
```

本机后端启动前用内存数据库检查 Node 与 SQLite 原生依赖是否兼容；依次检查当前 Node 和 Homebrew 的 Node 22/24，可用 `MAC_SERVER_NODE=/absolute/path/node` 指定。当前机器 Node 26 与锁定的 SQLite 依赖不兼容，已用本机 Node 22 重建依赖。安装和重建也应使用同一 Node；脚本不自动升级依赖。缺少 Prisma Client 时先运行 `pnpm --filter @ai-novel/server prisma:generate`（仅生成客户端）。

`make app` 使用本机构建的 Mac 界面，经本机代理、SSH 隧道访问服务器的 `127.0.0.1:18080`。服务器已有 API 映射，无需公开业务端口。`make dev_app` 使用 Vite 和本机 API；直接启动已有 TypeScript 服务入口，避开原开发脚本中的自动数据库同步；不会自动创建数据库、迁移或清空数据。

红色关闭按钮隐藏窗口，Dock 可重新打开；`⌘Q` 和 `stop_app` 退出应用。窗口位置和上次页面按后端身份隔离保存。SSH 通道断开后会重连，生成和保存请求不会自动重放。

同模式重复启动聚焦已有窗口。重启会先构建，再请求保存并退出。保存失败或取消退出时保留现有窗口。只停止经归属验证的自有进程；借用的 API、隧道以及服务器服务不会被 `stop_app` 关闭。本机 API 存在活跃任务或状态不能完整确认时继续保留；重复 `stop_app` 可再次检查。

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

```bash
make up_app DRY_RUN=1
make up_app DEPLOY_VALIDATION_FILE=/absolute/path/validation.json
```

预演只读检查远端发布 SHA、服务与数据位置、兼容性和任务静止状态；不会 fetch、创建远端目录/锁、构建或停服。候选 Git 对象不在服务器时会说明尚未验证，不能把预演输出当成部署通过。

目标仓库的 origin 必须匹配指定 fork。读取候选和 fetch 使用同一公开 fork 的 HTTPS 地址，不修改远端 origin 或 SSH 主机配置。

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

更新流程：隔离构建 → 完整预备份 → 关闭新 API 请求 → 两次任务及连接检查 → 停服并保存最终备份 → 快进源码并事务替换完整依赖/产物 → 只读健康检查 → 恢复入口。备份采用 SQLite backup API 并做完整性和文件校验；资产、配置、源码和旧依赖均保留。备份及日志位于服务器 `.runtime/desktop_mac-deploy/<时间>-<SHA>/`，不会自动清理。

失败回滚只恢复源码和依赖/产物，绝不还原或覆盖数据库。回滚源码可能停在 detached HEAD；先核对事务记录和旧 SHA，再恢复发布分支。异常中断会保留 `transaction.json`，下一次更新拒绝覆盖未完成事务；人工恢复步骤见 [部署边界](../docs/wiki/architecture/mac-desktop.md)。

## 验证与验收

```bash
pnpm --filter @ai-novel/desktop-mac typecheck
pnpm --filter @ai-novel/desktop-mac test
pnpm --filter @ai-novel/desktop-mac build
```

`build` 编译源码启动使用的 `.app`，不是公开发布、公证或安装包上传。版本从 `desktop/package.json` 派生；不修改旧 Windows 运行路径。

见 [实施进度](docs/progress.md)、[页面覆盖](docs/route-parity.md)、[用户验收](docs/acceptance.md)。代码检查不能证明原生窗口、输入法、实际 AI 生成和视觉一致性已验收。

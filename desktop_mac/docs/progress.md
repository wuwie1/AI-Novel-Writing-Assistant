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
| 6 集成验收 | in_progress | 准备本地 beta；不晋级 main、不推送、不上传 |

UI 均为 `user_acceptance_pending`。没有默认运行浏览器、截图、Playwright、原生窗口或真实 AI 生成。工程检查不能代替视觉与操作验收。

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

远端 beta 只读核查和本地集成结果将在集成提交中记录。保留功能分支等待 UI 反馈，相关验收通过前不晋级 main。

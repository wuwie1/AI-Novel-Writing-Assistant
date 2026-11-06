# Mac 桌面运行与呈现边界

## 背景与决定

Mac 用户需要 wukong 风格的原生工作台，同时继续使用现有小说生产服务。因此 Mac 采用独立 Swift/AppKit/WKWebView 与 React renderer；它既不是远程 Web 首页的快捷窗口，也不携带另一套小说业务后端。共享客户端能力通过显式可选入口复用，避免两端逐步出现不同的任务恢复或 AI 决策。

## 模块所有权

- `desktop_mac/native`：窗口、菜单、原生文件交互、单实例 socket、最小消息桥。只允许本机受控 origin；外部网页交给系统浏览器。
- `desktop_mac/renderer`：Mac 外壳、页面呈现、主题和平台适配。所有外观规则限制在 `html[data-app-shell="mac"]`，不导入 Web 全局 CSS。
- `client/src/router/createAppRoutes`：路径和功能开关的单一来源，允许注入 layout/pageOverrides；默认 Web 路由不变。
- `client/src/platform`：可选的文档状态、草稿存储和正文默认排版合同。状态由业务编辑器注册；不得扫描按钮文本或 DOM 来判断保存是否完成。
- `desktop_mac/application/lifecycle`：请求模式、成功模式、构建与进程切换。OS操作通过基础设施适配器；`.runtime/desktop_mac/state.json` 是原子写入的归属记录。
- `desktop_mac/application/deployment`：发布检查、构建、备份和停机事务；不执行迁移或业务命令。

## 连接与输入保护

Mac 界面只请求同源 `/api`。本机代理先验证回环 Host/Origin，再流式转发到固定本机API或SSH通道；不重放写请求、不汇聚SSE响应、不记录正文。远端API没有独立认证边界，因此必须保持服务器回环监听及SSH访问，不能为了桌面连接改为公网监听。

本地与服务器模式，以及不同后端身份，使用不同 WKWebView 数据存储与草稿前缀。主题也使用 Mac 专属键。正文草稿继续使用现有保存基线/版本冲突合同；服务器版本变动不能直接覆盖未保存输入。

原生桥协议版本1：rendererReady、requestSave、requestClose、closeDecision。退出/重载必须等 renderer 允许；保存失败、忙碌、取消或超时不退出。Mac 使用 `createBrowserRouter` 保持浏览器路径，并使用其导航 blocker；普通 `BrowserRouter` 不提供该 blocker 的 data-router 上下文，不能直接替换。

红色关闭按钮仅隐藏现有窗口和 WebView；Dock 重开不重载。窗口位置、上次路由和持久草稿按后端身份隔离。屏幕变化/唤醒只校正可见范围；WebContent 异常由用户选择重新打开，不能无提示重载。

文档保护覆盖范围以 `desktop_mac/docs/route-parity.md` 为准。新增状态编辑器需注册明确的 dirty/busy/save/discard 能力；不要把只修改了外观的页面误认为已具备退出保护。

## 生命周期安全边界

启动先验证依赖、配置和新构建，再请求旧窗口退出。单仓库只有一个活动桌面模式；requestedMode 和 runningMode 分开记录，失败后可重试目标模式。辅助进程由当前图形会话 launchd 托管，终端退出不影响窗口。稳定 PID 的 supervisor 负责日志轮转及 SSH 有界退避重连；其他角色失败不无限重启。

本机服务直接运行原 ts-node-dev 入口，不能调用会隐式 `prisma db push` 的 `server dev`。Node 选择只加载 Prisma 导出并打开内存 SQLite 验证 ABI，不导入后端 bootstrap。启动时将已校验的数据库绝对路径传入服务，避免继承环境变量改变数据源。

新窗口启动后如果健康检查失败，必须先走同一个正常关闭协议；取消或超时则保留整套进程及身份记录，不能拆掉窗口依赖或再打开回滚窗口。重启及回滚全过程持有同一生命周期锁。

### 启动身份与就绪顺序

- SSH 的命令行目的地址可能是用户配置的别名。借用已有隧道时读取进程真实 argv（只取 argc 项，不输出环境变量），验证其 `/usr/bin/ssh` 可执行文件、精确 `-L` 转发，并用 `ssh -G` 对比主机、用户、端口与连接身份配置。不能用 `command.includes(host)` 证明或否定目标身份。未知选项/不支持的代理命令按归属不明处理，不能停止该进程。
- `launchctl print` 返回 PID 时，该 PID 可能仍在执行 `xpcproxy`。必须等真实 argv 等于本次提交的 ProgramArguments，才能记录完整命令与启动时间；后续停止仍严格检查身份，不放宽为只看 PID。
- helper 进程存活不等于页面已能加载。先等待界面 HTTP 健康和 API 转发，再创建 WKWebView；尤其 Vite 冷启动不能和原生首次导航竞速。恢复旧构建也遵守同一顺序。
- native 的 focus 回复需要带回与 status 相同的 repo/mode/backendIdentity，供重复启动核对身份；只返回 `ok` 不足以证明聚焦了目标窗口。

发停止信号前核对仓库、角色、模式、PID启动时间和完整命令/launchd归属，避免PID复用。borrowed API/隧道永不停止。owned本机API须完成只读持久任务/租约/重试检查，覆盖不足就保留，关窗口不等于取消作品生产。

## 部署与回滚

默认发布线 `origin/ai` 与现有私有服务一致；Mac功能仍按feature→beta→main验收，不会由up_app暗中发布本地未推送功能。验证记录必须绑定发布SHA并注明日志证据位置；目标只能是当前部署的后代。普通部署拒绝数据库schema、迁移、启动兼容层及数据库依赖变化。

锁顺序：本机生命周期→本机部署→远端deploy.lock→远端service-control.lock。持有服务锁时直接调用经过WorkingDirectory归属校验的systemd服务，不嵌套调用会再次加锁的control.sh。

候选在服务器隔离目录构建；完整依赖和shared/server/client产物按固定清单切换。构建环境不携带生产.env。preflight与quiesced两份数据库备份使用SQLite backup API，执行integrity_check，文件清单记录size与SHA256；资产、配置、Git bundle、旧依赖也保留。备份目录0700，秘密文件0600。

维护期正常18080的API请求503，保留精确health与静态页；18081仅服务器回环GET/HEAD探测。两次检查间隔5秒，检查所有登记的持久队列、租约与重试，以及13000上的既有连接；未知状态或连接仍存在时拒绝停服。后台仅内存执行、又没有持久记录的工作仍依靠连接检查，因此不能承诺零中断热更新。

失败时按事务记录恢复完整旧依赖/产物、`git switch --detach <oldSHA>`恢复源码，再恢复原Nginx和服务状态。绝不hard reset、删除式同步或数据库还原。回滚后detached HEAD是明确的待核对状态，不伪装为正常发布分支。

### 异常中断的人工恢复

1. 阅读该批次transaction.json与backups/*/manifest.json，核对文件大小及SHA256，确认两个服务的归属和当前状态。不要删除锁/回滚槽来跳过检查。
2. 若phase未complete/rolled_back/aborted，先检查实际目录和pending操作：root为当前槽、candidate为新产物槽、rollback为旧产物槽。rename是原子操作；事务记录在每次rename之前和之后写入。
3. 保持API维护入口，确认没有活跃任务及连接后停既有服务。将已安装的新产物移回candidate；将rollback中旧目录逐项移回原位。不能删除有来源不明内容的目录。
4. 源码无未提交修改时非强制切到记录的old SHA；不操作数据库。恢复preflight配置归档中的原Nginx，先nginx -t，再启动原先运行的服务并检查API、网页、小说读取。
5. 确认维护探测端口消失，记录人工恢复结果。核对发布分支再进行下一次部署。未知情况保持现场，不自动重试切换。

## 相关文档

- [私有服务器部署](server-deployment.md)
- [Mac使用与配置](../../../desktop_mac/README.md)
- [页面覆盖与验收](../../../desktop_mac/docs/route-parity.md)
- [执行计划](../../../mac.md)

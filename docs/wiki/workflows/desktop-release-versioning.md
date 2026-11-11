# 桌面版本号与发布标识规则

## Background

桌面客户端有三处会暴露版本信息：界面顶部的当前版本、Electron 打包产物的应用版本、GitHub Release 的发布 tag。如果这些信息分别维护，用户截图、安装包文件名和自动更新判断会很容易出现不一致。

## Current Rule

- `desktop/package.json` 的 `version` 是桌面客户端唯一版本源。
- 前端网页开发态从 Vite 注入的 `VITE_APP_VERSION` 读取该版本，桌面运行态优先读取 Electron runtime 提供的 `appVersion`。
- 正式发布 tag 必须是 `vX.Y.Z`，并且 `X.Y.Z` 必须等于 `desktop/package.json` 的 `version`。
- 不在 UI、README 或发布脚本中硬编码另一个客户端版本号。
- GitHub 桌面发布 workflow 必须使用 Node 24 运行时和 Node 24 代际的官方 action，不再依赖 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` 去强制旧 Node 20 action。
- 桌面更新状态以 Electron runtime 投影为唯一事实来源；工作区顶部入口、更新弹窗、启动页和系统设置只负责以不同密度展示同一份状态，不各自推断更新结果。
- 工作区顶部版本号是日常更新入口。发现新版本、下载中或等待重启时，入口必须直接显示对应状态；系统设置保留完整详情，但不能作为唯一入口。
- 面向用户的更新状态、错误说明和操作按钮使用中文；底层错误详情写入桌面日志，不把英文异常原文直接暴露给用户。

## Release Steps

1. 发新版桌面包前，先运行 `pnpm release:desktop:bump X.Y.Z` 更新 `desktop/package.json`。
2. 更新用户可见 release notes 和 README 最新更新，说明该版本面向用户的变化。
3. 合入 `main` 后运行 `node scripts/trigger-desktop-release.cjs --dry-run`，确认工作区、分支、tag、类型检查和测试都通过。dry-run 也执行检查，但不创建 tag 或 push。相同干净提交已有本地通过记录时会复用该记录；需要重新验证时添加 `--force-tests`。
4. 只使用与 `desktop/package.json` 对齐的 `vX.Y.Z` tag 触发正式 GitHub Release。

## 发布检查与拒绝规则

`scripts/desktop-release/guard.cjs` 是发布验证门面。创建 tag／push 前运行类型检查、隔离测试库迁移、服务端与前端完整测试、桌面编译及桌面／发版脚本契约测试。测试使用独立临时目录和 SQLite 数据库，不使用作者数据库或应用数据目录；失败时保留输出目录用于诊断。

通过检查不等于长期授权。检查前后读取 HEAD、版本与工作区，期间有代码、版本或提交变化必须重新检查。唯一可复用的本地证据是 `.tmp/desktop-release/<SHA>.json` 中同 SHA、同桌面版本的完整通过记录，且当前工作区必须干净；记录只用于避免 dry-run、实际打 tag 与本地上传之间重复跑同一套检查。实际重跑前（包括使用 `--force-tests`）先清除同 SHA 的旧记录，只在整套检查通过后写入新记录，避免失败后的上传复用过期结果。

正式上传再次核对版本 tag 指向当前 HEAD，且提交属于 main；GitHub 必须提供匹配的 tag ref。不能将旧 SHA 的成功结果、任意环境布尔值、其他分支的验证或不干净工作区当作本次通过证据。

本地上传还须读取 origin 的已推送 tag（注解 tag 取 peeled commit）并与本次 HEAD 比较，避免发布器在远端缺少 tag 时替旧 main 自动创建发布标识。

`run-electron-builder.cjs` 默认添加 `--publish never`，避免 CI 环境隐式上传。显式 `--publish`、`--publish=...` 与 `-p` 共用同一验证入口，失败不调用上传；重复 publish 参数被拒绝。两种既有发布脚本都经过此入口，不能另建绕过守卫的上传路径。

发布 workflow 仅允许 push 的版本 tag 进入上传任务。手动 workflow_dispatch 的 `target=mac` 从所选分支只构建 Apple Silicon（arm64）DMG，面向当前苹果芯片 Mac 的安装试用，避免重复构建不需要的 Intel 产物。以 Actions artifact 提供下载，名称绑定桌面版本、架构和完整提交 SHA，保留 14 天并附带 SHA-256 校验文件；`target=windows` 执行既有检查与目录打包。手动 Mac 任务只有 `contents: read`，不注入发布凭据，始终显式使用 `--publish never`。这是分支产物验证与安装试用入口，不能把它当作正式 GitHub Release 或绕过 main／版本 tag 守卫。正式发布的目标架构另由发布任务维护。构建使用已提交的图标；品牌图标应在开发时生成、审核并提交，避免发布检查期间改写受版本控制的素材。发布说明更新脚本也必须拒绝与 package 版本不符的 tag。

## 平台与原生运行时

正式发布时，Windows 保留 x64 NSIS 和便携包；Mac 通过 macos-latest 的独立 x64/arm64 任务产生内含 ad-hoc 签名应用的 DMG，运行时禁用自动更新并使用 icns 图标；Linux 通过 ubuntu-latest 产生 x64 AppImage 并使用 PNG 图标。Mac 用户通过下载新版安装包升级，不能依赖需要 Developer ID 签名的自动更新链。

Mac 的完整性签名与 Apple 身份认证是两个边界。缺少 Developer ID 证书时仍必须用 `identity: "-"` 对重打包的应用做 ad-hoc 签名，不能用 `identity: null` 完全跳过；否则 Electron 的 linker 签名无法封装改名后的应用和新增资源，Apple Silicon 可能报“应用已损坏”。`forceCodeSigning` 禁止静默退回无签名，afterSign 在制作安装包前执行系统的深度、严格签名验证；手动任务在上传 artifact 前也执行一次独立校验，避免跳过签名时遗漏 hook。签名只证明包内内容一致，不代表获得 Apple 信任；未做公证的下载包可能仍需用户确认。未来接入 Developer ID 与公证时必须保留完整性校验，不能把临时签名通过描述为公证成功。

桌面构建显式固定 SQLite，避免开发者的 PostgreSQL 环境影响生成客户端。每个 afterPack 验证最终包中 better-sqlite3 的 PE/Mach-O/ELF 架构及 Prisma SQLite schema；原生模块由 electron-builder 针对当前 Electron 版本和目标架构重建，不能直接复用宿主 Node 的 SQLite 二进制。生成的 Prisma 客户端、WASM 运行时和迁移目录仍由原 staging 入口复制，不自行拼装另一份客户端。

包内验证与职责归属见 [打包模块边界](../../../desktop/scripts/packaging/README.md)。配置使用 [electron-builder 平台选项](https://www.electron.build/mac/)；可选二进制安装使用 [pnpm supportedArchitectures](https://pnpm.io/settings#supportedarchitectures)。

原生重编译的 buildPath 和 projectRootPath 必须同时指向 staging。electron-builder 默认会使用 workspaceRoot 扫描依赖，仅脱离 staging 硬链接仍可能改写源码 SQLite 的 ABI，表现为打包后 Node 测试报 Electron NODE_MODULE_VERSION。beforePack 通过既有 @electron/rebuild 限定范围，并以 npmRebuild=false 禁止默认重编译，保留正常依赖收集；本地验证须确认源码二进制散列保持不变且 Node 可加载。

## Mac 安装包默认连接

此处指 `desktop/` 的 Electron 安装包；`desktop_mac/` 的 Swift 工作台有独立的启动与连接规则。本仓库的 Mac 安装包面向已有 Web 服务的使用场景：双击后打开 `http://127.0.0.1:15173`，API 使用同一地址下的 `/api`，业务数据由该服务负责。`127.0.0.1` 指当前 Mac；连接远端服务器时，SSH 通道须由使用者提前建立，Electron 不负责建立或关闭通道。

默认值由 `electron-builder.config.cjs` 的 `mac.extendInfo.LSEnvironment` 写入应用 Info.plist：服务模式为 `external`，端口为 `15173`，renderer URL 为 `http://127.0.0.1:15173`。配置在签名前生成，不能为改地址而修改已签名包。按照 [Apple Launch Services 规则](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html)，该环境用于 Finder/Dock 等系统启动入口，直接运行包内二进制时不生效；命令行调试需显式传入三项环境变量。builder 浅合并会替换整个 `LSEnvironment`，所以须同时保留 Electron 的 `MallocNanoZone=0`。

网页地址和 API 地址需要同时配置。只改 API 端口仍会加载包内 `file://` 页面；它产生的 `Origin: null` 不属于普通 Web 后端默认允许的来源。加载同一服务的网页还可让前端与后端版本一致，不应为此放宽服务器 CORS。客户端从 preload 读取 API 地址；外部模式沿用显式配置的访问令牌，没有令牌时不生成本地随机凭据。

外部模式先在限时健康检查通过后加载网页；服务不可用或页面加载失败时显示中文连接说明。不要自动退回内置服务，否则用户可能误以为服务器上的小说丢失，或把新内容写入另一份数据库。桌面包仍携带原有 managed/SQLite 能力，但此入口不启动它；既有本地数据不迁移、不删除，外部连接也不把服务器数据复制到本地库。Windows/Linux 的安装启动与源码开发流程不采用这组 Mac 包配置。

验收应使用重新构建的安装包，通过 Finder/Dock 启动，并分别检查通道可用、通道未启动和网页加载失败的情况。源码 `pnpm dev:desktop` 或直接启动旧版 `.app` 不能证明新包的默认连接有效。完整签名校验仍由既有打包 hook 执行。

## 工作区依赖与部署快照

桌面包通过 `pnpm deploy --prod` 使用注入的 `@ai-novel/server`，而源码运行使用 server importer。新增服务端生产依赖时，必须同步检查锁文件的 `server` importer 和 `snapshots` 中 `@ai-novel/server@file:server(...)` 的依赖集合；仅在 importer 和 packages 中出现新库，仍可能通过 frozen install，却在桌面部署时遗漏该库。

`stage-desktop.cjs` 在部署、Prisma 运行时整理后逐项解析服务端生产依赖，并要求解析结果位于部署目录内，防止借用源码工作区的依赖掩盖漏包。出现 Electron 的 `production dependency not found` 时，先核对注入快照，不应临时复制单个依赖或升级无关依赖。修复后使用新的临时部署目录验证闭包，再通过 GitHub 执行完整打包。

## Failure Modes

- 如果界面顶部显示版本和安装包文件名不一致，先检查打包所用 commit 的 `desktop/package.json`，不要在前端组件里补一个临时版本。
- 如果 GitHub Release tag 已存在，不能复用同一个版本重新上传；应继续 bump 到新的 `X.Y.Z`。
- 如果发版前只更新 release notes 但没有 bump 桌面版本，自动更新链路会把新包识别成旧版本，必须先修正版本源再发布。
- 如果 GitHub Actions 提示某个 action 仍在使用 Node 20，应优先升级该 action 的 major 版本，而不是重新加入强制运行时环境变量。
- 如果 Mac 提示“应用已损坏”，先核对下载 SHA-256、CPU 架构及 `codesign --verify --deep --strict`。下载校验一致但出现 `code has no resources but signature indicates they must be present` 时，应修复打包签名并重新验证；不能仅凭 Actions 成功断言可安装，也不能把清除 quarantine 或关闭 Gatekeeper 当作签名修复。签名通过后的 `spctl` 拒绝可能仍来自缺少 Developer ID／公证，应单独说明，不与文件损坏混淆。

## Related Modules

- `client/vite.config.ts`：把桌面版本注入网页开发态和普通前端构建。
- `client/src/lib/constants.ts`：统一导出前端可用的 `APP_VERSION`。
- `client/src/components/layout/desktopUpdaterPresentation.ts`：统一更新状态、安装形态和通道的用户文案。
- `client/src/components/layout/DesktopUpdatePanel.tsx`：供顶部弹窗与系统设置复用的更新操作面板。
- `desktop/src/main.ts`：桌面运行态把 Electron `app.getVersion()` 注入 renderer。
- `desktop/src/runtime/updater.ts`：检查、下载和安装状态的事实来源。
- `scripts/bump-desktop-version.cjs` 与 `scripts/trigger-desktop-release.cjs`：版本推进与正式发布 tag 校验。

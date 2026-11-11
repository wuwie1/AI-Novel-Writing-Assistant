# 桌面打包边界

`build-desktop.cjs` 为全部构建步骤固定 SQLite 配置，只生成客户端和编译代码，不执行迁移。不要根据开发者的 PostgreSQL 环境生成桌面 Prisma client。`stage-desktop.cjs` 继续拥有依赖部署、Prisma 生成目录内嵌和原生包物理副本，避免 Electron 重编译修改源码工作区的硬链接。

electron-builder 为每个目标架构重编译 better-sqlite3，所有 `.node` 文件保持 asarUnpack。Prisma 7 使用生成客户端及 SQLite adapter；运行时的本地 SQLite 能力来自 better-sqlite3。`verify-native-runtime.cjs` 在每个 afterPack 检查 PE/Mach-O/ELF 的目标架构、内嵌 Prisma client 和 SQLite schema，架构错误或漏包必须阻止生成可发布产物。

`rebuild-native.cjs` 在 beforePack 通过既有 @electron/rebuild 将 buildPath 与 projectRootPath 都固定到 staging；npmRebuild=false 禁止默认重编译。仅设置 appDir 仍会让默认重编译扫描 workspaceRoot，把源码 Node 使用的 SQLite 替换为 Electron ABI。不能以 beforeBuild 返回 false 来替代，这会让 builder 将依赖视为外部管理并跳过依赖收集。验证打包时须比较源码原生二进制散列并确认 Node 仍可加载 SQLite；staging 的物理副本和受限重编译缺一不可。

正式发布时，Mac 以独立 x64/arm64 job 构建 DMG，不合并成 universal 包；应用使用 ad-hoc 签名，暂不做 Apple 公证，关闭客户端自动更新。Linux 以 x64 构建 AppImage。pnpm 同时安装当前 OS 的 x64/arm64 可选依赖，让 sharp 等按运行架构选择本地二进制。Windows 保留 NSIS/portable、签名规则和 NSIS 模板补丁；跨平台构建不使用 NSIS 模板。

Mac 的 `identity: "-"` 与 `forceCodeSigning: true` 保证重新封装后的应用拥有完整的签名。不能使用 `identity: null` 跳过签名：Electron 原始可执行文件的 linker 签名没有封装新应用资源，Apple Silicon 安装后可能提示“已损坏”。保留 electron-builder 的 Hardened Runtime 和默认 Electron entitlements（含 JIT、动态库加载权限）。`verify-mac-signature.cjs` 在 afterSign 使用系统 `codesign --verify --deep --strict` 检查主应用和嵌套代码，失败即阻止后续产物生成；手动打包在上传前再次检查应用，防止签名阶段被跳过。

ad-hoc 签名只校验内容完整性，不提供 Apple Developer ID 身份或公证。下载后首次打开仍可能被 Gatekeeper 拦截；用户核实来源后可按 macOS“系统设置 → 隐私与安全性 → 仍要打开”的提示确认。不要将全局关闭 Gatekeeper 或自动删除 quarantine 作为安装流程。面向免手动放行的分发，需要另行配置 Developer ID 证书和 Apple 公证，并验证新包。

需要指定分支的 Apple Silicon Mac 安装包时，在 GitHub Actions 的 `Desktop Release` 选择目标分支，手动运行并将 `target` 设为 `mac`（默认）。该入口只构建 arm64；构建完成后从该运行的 Artifacts 下载 `mac-dmg-<版本>-arm64-<提交>`，解压取得 DMG 与 SHA-256 校验文件；产物保存 14 天。版本来自 `desktop/package.json`。手动打包只使用仓库读取权限和 `--publish never`，不会创建 GitHub Release 或触发自动更新。选择 `windows` 则运行既有 Windows 目录打包验证。

Mac 安装包通过 `mac.extendInfo.LSEnvironment` 在签名前写入默认连接：`AI_NOVEL_DESKTOP_SERVER_MODE=external`、`AI_NOVEL_SERVER_PORT=15173`、`AI_NOVEL_DESKTOP_RENDERER_URL=http://127.0.0.1:15173`。Finder/Dock 启动时读取这些变量，网页和 API 都使用该 Web 服务；使用者须先启动服务或 SSH 通道。这个入口不启动内置后端，也不自动建立通道。保留 Electron 的 `MallocNanoZone=0`，因为 builder 对 `extendInfo` 使用浅合并。Windows/Linux 和源码开发启动仍使用各自既有配置。直接运行 `.app/Contents/MacOS/` 下的可执行文件不经过 Launch Services，须自行传入上述变量。不能修改已签名应用的 Info.plist；修改默认地址后应重新构建并安装。

启动边界、数据归属和诊断规则见 [Mac 安装包默认连接](../../../docs/wiki/workflows/desktop-release-versioning.md#mac-安装包默认连接)。打包契约测试通过 builder 的实际 plist 合并路径验证配置；启动测试验证外部健康检查、网页与 API 地址一致、连接失败提示及不创建本地后端或随机令牌。

增加平台时同时更新 builder 目标、窗口图标、workflow 和原生架构验证。Windows 本机目录打包不能替代 Mac/Linux runner 的实际构建与启动验收。

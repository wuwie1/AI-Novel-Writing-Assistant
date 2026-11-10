# Linux 服务器部署

本目录负责服务器进程管理、网页代理和本地 SSH 通道，不负责业务代码、数据库重置或桌面打包。适用于带 systemd 的 Linux；当前配置使用独立 SQLite 数据库。

## 运行布局

| 位置 | 用途 |
| --- | --- |
| `.runtime/node/` | 校验过的 Node.js 发行包（符合根目录 engines） |
| `.runtime/pnpm/` | 仓库指定版本的 pnpm |
| `.runtime/nginx/` | Nginx 可执行文件、mime.types 和临时目录 |
| `server/.env` | 服务器环境配置，保留在服务器，不随源码覆盖 |
| `data/novel.db` | 服务器独立 SQLite 数据库，连同 WAL/SHM 受保护 |
| `server/storage/` | 图片等持久化资产 |
| `logs/server.log` | API 标准输出和错误日志 |
| `logs/nginx-access.log`、`logs/nginx-error.log` | 网页与代理访问/错误日志 |
| `.logs/` | 应用自身诊断日志、构建日志及本机通道日志 |

网页入口为服务器 `127.0.0.1:18080`，API 为 `127.0.0.1:13000`。Nginx 将 `/api/` 原样转发，关闭代理缓冲以支持 AI 流式输出；前端用相对 `/api` 路径，SSH 通道只需映射一个网页端口。

## 首次安装

1. 仅上传版本控制中的源码和部署脚本，不上传开发机 `.env`、数据库、`node_modules` 或运行日志。禁止使用删除式同步覆盖持久化目录。
2. 将 Node.js 安装到 `.runtime/node`；从官方发行源下载并核验 SHA-256。使用仓库 `packageManager` 指定的 pnpm。将 Nginx 二进制放到 `.runtime/nginx/usr/sbin/nginx`，mime.types 放到 `.runtime/nginx/etc/nginx/mime.types`。Ubuntu 可用 `apt-get download nginx nginx-common` 加 `dpkg-deb -x` 提取发行包，避免启动系统默认的公开站点。
3. 配置运行环境并构建：

```bash
export PATH="$PWD/.runtime/node/bin:$PWD/.runtime/pnpm/node_modules/.bin:$PATH"
export CI=true NODE_OPTIONS=--max-old-space-size=3072
ulimit -c 0
pnpm --filter @ai-novel/server... --filter @ai-novel/client... install --frozen-lockfile
pnpm --filter @ai-novel/shared build
# 工作区启用了依赖注入，构建后同步 shared 的输出。
pnpm --filter @ai-novel/server... --filter @ai-novel/client... install --offline --frozen-lockfile
AI_NOVEL_DATABASE_MODE=sqlite pnpm --filter @ai-novel/server prisma:generate
pnpm --filter @ai-novel/server build
pnpm --filter @ai-novel/client build
```

若原生 SQLite 模块没有适配的预编译包，安装编译工具和 Python 后再构建依赖。完整服务端类型编译需要超过 2 GB 的 Node 堆；小内存服务器须预留交换空间、串行构建，或在足够内存的构建机生成产物。构建可重定向到 `.logs/deploy-build.log`，不需要启动开发服务器。

4. 首次创建 `server/.env`（将绝对路径替换为实际部署根目录）：

```dotenv
NODE_ENV=production
AI_NOVEL_RUNTIME=web
AI_NOVEL_DATABASE_MODE=sqlite
DATABASE_URL=file:/data/write/AI-Novel-Writing-Assistant/data/novel.db
HOST=127.0.0.1
PORT=13000
ALLOW_LAN=false
CORS_ORIGIN=http://127.0.0.1:15173,http://localhost:15173
DIRECTOR_NEXT_ENABLED=true
RAG_ENABLED=false
IMAGE_STORAGE_DRIVER=local
API_JSON_LIMIT=20mb
```

模型密钥在页面中配置。知识库检索可在配置 Qdrant 和 Embedding 模型后启用。不要复制本地开发机的密钥或数据库来隐式迁移用户数据。

5. 对**全新空库**应用正式迁移。Prisma CLI 的配置不自动读取 `.env`，显式提供同一个数据库 URL：

```bash
mkdir -p data
DATABASE_URL="file:$PWD/data/novel.db" AI_NOVEL_DATABASE_MODE=sqlite \
  pnpm --filter @ai-novel/server prisma:deploy
```

Web 运行不会执行桌面端的启动迁移，因此不能跳过此步骤。已有库升级必须先备份并验证，审查迁移影响；涉及删除或重建数据时还需要明确批准。不要运行 reset 或带数据丢失许可的 db push。

6. 数据目录中的文件归专用账户所有，再安装并启动服务：

```bash
sudo bash infra/server/install-systemd.sh
sudo chown -R ai-novel:ai-novel data server/storage .logs
./start.sh
```

安装器只生成本部署的 systemd、Nginx 和 logrotate 配置；不会安装依赖、执行迁移或启动服务。固定服务名只支持每台主机一份此配置，安装器会拒绝覆盖其他部署目录的同名服务。服务自动随系统启动，异常退出后由 systemd 重启；显式停止会保持停止，直到再次启动或服务器重启。

## 日常控制

在服务器仓库根目录执行：

```bash
./start.sh                         # 幂等启动，等待网页和 API 健康检查
./restart.sh                       # 重启并等待就绪
./stop.sh                          # 停止网页和 API，保留数据和日志
bash infra/server/control.sh status
tail -F logs/server.log logs/nginx-error.log
```

日志不随服务重启清空。systemd 生命周期诊断使用 `journalctl -u ai-novel-api -u ai-novel-web`。运行日志由系统 logrotate 每日检查，保留 14 份归档，超过 50 MB 时在下次检查轮转；应用自身 `.logs` 使用项目的日志保留规则。`copytruncate` 保持写入句柄有效，轮转瞬间的并发日志存在极短丢失窗口；需要完整审计时应另接日志收集服务。

## 本地通道

在本机仓库根目录运行 `make ssh_server`。命令检查独立 SSH 隧道、远端网页和 API。通畅时直接显示浏览器访问地址，连接中断时自动建立或恢复。退出桌面后，浏览器仍可使用这个地址。

默认地址为 `http://127.0.0.1:15173/`。如果桌面先占用了该端口，浏览器会获得另一个独立地址，默认配置下为 `http://127.0.0.1:15176/`。下次执行命令会沿用这个地址。SSH 目标和端口沿用 `make app` 的配置。未指定 SSH 目标时，也会读取独立通道保存的服务器地址。需要指定 SSH 别名或端口时，可运行 `make ssh_server SSH_TARGET=my-server TUNNEL_PORT=15200`。

本机需可免交互 SSH 登录目标主机，并安装 autossh 和 lsof。直接使用通道脚本时，可将目标保存为本机忽略文件：

```bash
mkdir -p .runtime/tunnel
chmod 700 .runtime/tunnel
printf '%s\n' 'user@your-server' > .runtime/tunnel/target
bash infra/server/tunnel.sh start
```

通道在当前电脑会话中后台运行，日志在本机 `.logs/tunnel.log`。电脑重启后可重新运行 `make ssh_server`。

```bash
bash infra/server/tunnel.sh status
bash infra/server/tunnel.sh restart
bash infra/server/tunnel.sh stop
```

可用 `AI_NOVEL_SSH_TARGET`、`AI_NOVEL_LOCAL_PORT`、`AI_NOVEL_REMOTE_PORT` 覆盖目标和端口；控制非默认端口时，stop/status 也需提供相同本地端口。SSH 保留正常主机密钥校验，且转发仅绑定本机 `127.0.0.1`。

## 更新与排查

- 更新前记录部署提交、检查磁盘空间并备份数据库和资产。运行中的 SQLite 用 SQLite backup API 获取一致快照，验证 `PRAGMA integrity_check`；不要只复制正在写入的单个 `.db`。
- 源码、依赖和构建产物可以重建；`data`、`server/storage`、`server/.env` 必须保留。应先完成构建，再安排服务重启；迁移和恢复不能隐藏在 start/restart 脚本里。
- 健康接口成功只代表进程可访问。还要读小说列表等数据库接口，确认数据访问正常；实际 AI 生成需用户配置模型后验收。
- 页面可访问而 AI 输出断断续续时，先检查 `/api` 代理是否缓冲。出现 502 时查看 API 进程和 `logs/server.log`；仅本地无法访问时查看通道日志。
- 升级 Node.js 或 Nginx 时核验发行源和校验和，并检查运行账户权限；不要改用 Vite 开发服务器作为生产入口。

.DEFAULT_GOAL := list
.PHONY: list dev_app app stop_app restart_app ssh_server server_update

export APP_MODE LOCAL_API_PORT DEV_UI_PORT APP_UI_PORT TUNNEL_PORT SSH_TARGET
export REMOTE_WEB_PORT MAINTENANCE_PROBE_PORT SERVER_DIR DEPLOY_REF DRY_RUN DEPLOY_VALIDATION_FILE
export MAC_APP_MODE MAC_RENDERER_OUT_DIR MAC_SERVER_NODE

## list — 列出 Mac 桌面命令及配置说明
list:
	@awk '/^## / { sub(/^## /, ""); print }' Makefile
	@printf '\n配置：\n  APP_MODE=local|remote — restart_app 的连接模式\n  SSH_TARGET, TUNNEL_PORT, REMOTE_WEB_PORT — SSH 目标和 Web 隧道两端端口\n  SERVER_DIR, DEPLOY_REF — 远端部署目录与版本（默认 DEPLOY_REF=origin/ai）\n  DRY_RUN=1 — 只读预演 server_update\n  DEPLOY_VALIDATION_FILE — 复用该提交已有的构建和测试记录（可选）\n  MAC_SERVER_NODE — 本机后端 Node 绝对路径（可选）\n'

## dev_app — 启动 Mac 桌面，连接本机测试后端
dev_app:
	@node desktop_mac/scripts/mac.mjs dev_app

## app — 启动 Mac 桌面，通过 SSH 连接服务器后端
app:
	@node desktop_mac/scripts/mac.mjs app

## stop_app — 正常退出桌面，关闭经归属验证的辅助进程
stop_app:
	@node desktop_mac/scripts/mac.mjs stop_app

## restart_app — 准备或复用构建产物，再按最近请求的模式重启桌面
restart_app:
	@node desktop_mac/scripts/mac.mjs restart_app

## ssh_server — 检查并恢复独立 Web 隧道，显示浏览器访问地址
ssh_server:
	@node infra/server/tunnel/ensure.mjs

## server_update — 将当前部署分支的本地提交更新到服务器，并重启 API 和网页服务
server_update:
	@node desktop_mac/scripts/mac.mjs server_update

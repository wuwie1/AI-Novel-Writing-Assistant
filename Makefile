.DEFAULT_GOAL := list
.PHONY: list dev_app app stop_app restart_app up_app

export APP_MODE LOCAL_API_PORT DEV_UI_PORT APP_UI_PORT TUNNEL_PORT SSH_TARGET
export REMOTE_WEB_PORT MAINTENANCE_PROBE_PORT SERVER_DIR DEPLOY_REF DRY_RUN DEPLOY_VALIDATION_FILE
export MAC_APP_MODE MAC_RENDERER_OUT_DIR MAC_SERVER_NODE

## list — 列出 Mac 桌面命令及配置说明
list:
	@awk '/^## / { sub(/^## /, ""); print }' Makefile
	@printf '\n配置：\n  APP_MODE=local|remote — restart_app 的连接模式\n  SSH_TARGET, SERVER_DIR, DEPLOY_REF — 远端部署目标（默认 DEPLOY_REF=origin/ai）\n  DRY_RUN=1 — 只读预演 up_app\n  DEPLOY_VALIDATION_FILE — 候选 SHA 的验证记录\n  MAC_SERVER_NODE — 本机后端 Node 绝对路径（可选）\n'

## dev_app — 启动 Mac 桌面，连接本机测试后端
dev_app:
	@node desktop_mac/scripts/mac.mjs dev_app

## app — 启动 Mac 桌面，通过 SSH 连接服务器后端
app:
	@node desktop_mac/scripts/mac.mjs app

## stop_app — 正常退出桌面，关闭经归属验证的辅助进程
stop_app:
	@node desktop_mac/scripts/mac.mjs stop_app

## restart_app — 先构建，再按最近请求的模式重启桌面
restart_app:
	@node desktop_mac/scripts/mac.mjs restart_app

## up_app — 更新并重启服务器后端；DRY_RUN=1 可只读预演
up_app:
	@node desktop_mac/scripts/mac.mjs up_app

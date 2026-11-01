#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
ACTION=${1:-status}
case "$ACTION" in start|restart|stop|status) ;; *) echo 'Usage: control.sh start|restart|stop|status' >&2; exit 2 ;; esac
if [[ $(uname -s) != Linux ]]; then
  echo '请在部署服务器上执行此命令；本地访问使用 infra/server/tunnel.sh。' >&2
  exit 1
fi
if [[ $EUID -ne 0 && $ACTION != status ]]; then
  exec sudo bash "$0" "$ACTION"
fi
for unit in ai-novel-api ai-novel-web; do
  if [[ $(systemctl show "$unit" -p WorkingDirectory --value) != "$ROOT/server" && $unit == ai-novel-api ]] ||
     [[ $(systemctl show "$unit" -p WorkingDirectory --value) != "$ROOT" && $unit == ai-novel-web ]]; then
    echo "${unit} 未安装或属于其他目录。先运行 infra/server/install-systemd.sh。" >&2
    exit 1
  fi
done
if [[ $ACTION == status ]]; then
  exec systemctl --no-pager --full status ai-novel-api ai-novel-web
fi
mkdir -p "$ROOT/.runtime"
exec 9>"$ROOT/.runtime/service-control.lock"
flock -w 180 9
if [[ $ACTION == stop ]]; then
  systemctl stop ai-novel-web ai-novel-api
  echo "服务已停止。数据和日志保留在 ${ROOT}。"
  exit 0
fi
test -f "$ROOT/server/dist/app.js"
test -f "$ROOT/client/dist/index.html"
test -f "$ROOT/server/.env"
runuser -u ai-novel -- "$ROOT/.runtime/nginx/usr/sbin/nginx" -t -e "$ROOT/logs/nginx-error.log" -p "$ROOT/.runtime/nginx/" -c "$ROOT/.runtime/nginx.conf"
systemctl "$ACTION" ai-novel-api ai-novel-web
for ((attempt=0; attempt<60; attempt++)); do
  if curl -fsS --max-time 2 http://127.0.0.1:18080/api/health >/dev/null 2>&1 &&
     curl -fsS --max-time 2 http://127.0.0.1:18080/ >/dev/null 2>&1; then
    echo "服务已在后台运行：http://127.0.0.1:18080"
    echo "运行日志：$ROOT/logs/server.log"
    echo "访问日志：$ROOT/logs/nginx-access.log"
    exit 0
  fi
  sleep 2
done
echo "服务未通过健康检查，请检查 $ROOT/logs/server.log 和 $ROOT/logs/nginx-error.log。" >&2
systemctl --no-pager --full status ai-novel-api ai-novel-web || true
exit 1

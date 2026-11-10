#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
ACTION=${1:-start}
SSH_TARGET=${AI_NOVEL_SSH_TARGET:-}
LOCAL_PORT=${AI_NOVEL_LOCAL_PORT:-15173}
REMOTE_PORT=${AI_NOVEL_REMOTE_PORT:-18080}
STATE="$ROOT/.runtime/tunnel"
LOG="$ROOT/.logs/tunnel.log"
case "$ACTION" in start|stop|restart|status|pid) ;; *) echo 'Usage: tunnel.sh start|stop|restart|status|pid' >&2; exit 2 ;; esac
for port in "$LOCAL_PORT" "$REMOTE_PORT"; do
  [[ $port =~ ^[0-9]+$ && $port -ge 1024 && $port -le 65535 ]] || { echo '端口需在 1024–65535 之间。' >&2; exit 2; }
done
umask 077
mkdir -p "$STATE" "$(dirname "$LOG")"
PID_FILE="$STATE/$LOCAL_PORT.pid"
manager_pid() {
  [[ -f $PID_FILE ]] || return 1
  local pid command process_name
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
  [[ $pid =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  process_name=$(ps -p "$pid" -o comm=) || return 1
  command=$(ps -ww -p "$pid" -o command=) || return 1
  [[ ${process_name##*/} == autossh && $command == *"127.0.0.1:$LOCAL_PORT:127.0.0.1:"* ]] || return 1
  # The open log follows a renamed checkout and identifies its manager even if
  # the recorded SSH -E path no longer exists. A reused PID may belong elsewhere.
  if command -v lsof >/dev/null; then
    lsof -a -p "$pid" "$LOG" >/dev/null 2>&1 || return 1
  fi
  printf '%s\n' "$pid"
}
is_running() { manager_pid >/dev/null; }
stop_tunnel() {
  local pid
  if pid=$(manager_pid); then
    if ! kill -TERM "$pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null; then return 1; fi
    for ((attempt=0; attempt<50; attempt++)); do
      if [[ $(manager_pid || true) != "$pid" ]]; then
        echo "本地通道已停止：$LOCAL_PORT"
        return 0
      fi
      sleep 0.2
    done
    echo '通道仍在停止中，请查看进程状态。' >&2
    return 1
  fi
  echo '本地通道未运行。'
}
case "$ACTION" in
  pid) manager_pid; exit 0 ;;
  status) if is_running; then echo "通道运行中：http://127.0.0.1:$LOCAL_PORT"; else echo '通道未运行。'; exit 1; fi; exit 0 ;;
  stop) stop_tunnel; exit 0 ;;
  restart) stop_tunnel ;;
esac
if is_running; then
  echo "通道已运行：http://127.0.0.1:$LOCAL_PORT"
  exit 0
fi
if [[ -z $SSH_TARGET && -f $STATE/target ]]; then
  SSH_TARGET=$(cat "$STATE/target")
fi
[[ -n $SSH_TARGET && $SSH_TARGET != -* && $SSH_TARGET != *[[:space:]]* ]] || {
  echo '请设置 AI_NOVEL_SSH_TARGET=user@host，或保存到 .runtime/tunnel/target。' >&2
  exit 2
}
command -v autossh >/dev/null || { echo '请先安装 autossh（macOS：brew install autossh）。' >&2; exit 1; }
if command -v lsof >/dev/null && lsof -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "本地端口 $LOCAL_PORT 被其他进程占用，请设置 AI_NOVEL_LOCAL_PORT。" >&2
  exit 1
fi
export AUTOSSH_PIDFILE="$PID_FILE" AUTOSSH_LOGFILE="$LOG" AUTOSSH_GATETIME=0 AUTOSSH_POLL=30
# Keep the forwarding identity early in autossh's process title for PID validation.
autossh -M 0 -f -N -T -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" -E "$LOG" \
  -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 -o ControlMaster=no -o ControlPath=none "$SSH_TARGET"
for ((attempt=0; attempt<20; attempt++)); do
  if is_running && curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$LOCAL_PORT/api/health" >/dev/null 2>&1; then
    echo "本地通道已就绪：http://127.0.0.1:$LOCAL_PORT"
    echo "通道日志：$LOG"
    exit 0
  fi
  sleep 1
done
echo "通道尚未通过健康检查；autossh 将自动重连。请检查 ${LOG}。" >&2
exit 1

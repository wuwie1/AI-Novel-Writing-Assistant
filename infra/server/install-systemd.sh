#!/usr/bin/env bash
# Installs process supervision only. Does not build, migrate, or modify application data.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ $EUID -eq 0 ]] || { echo '请使用 root 或 sudo 安装后台服务。' >&2; exit 1; }
[[ $ROOT =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo '部署路径只支持字母、数字、下划线、横线和斜线。' >&2; exit 1; }
test -x "$ROOT/.runtime/node/bin/node"
test -x "$ROOT/.runtime/nginx/usr/sbin/nginx"
test -f "$ROOT/server/.env"
test -f "$ROOT/server/dist/app.js"
test -f "$ROOT/client/dist/index.html"
for unit in ai-novel-api ai-novel-web; do
  existing=$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)
  if [[ -n $existing && $existing != "$ROOT" && $existing != "$ROOT/server" ]]; then
    echo "$unit 属于其他部署：$existing" >&2
    exit 1
  fi
done
if ! id ai-novel >/dev/null 2>&1; then
  useradd --system --home-dir "$ROOT" --no-create-home --shell /usr/sbin/nologin ai-novel
fi
install -d -o ai-novel -g ai-novel -m 750 "$ROOT/data" "$ROOT/logs" "$ROOT/.logs" "$ROOT/server/storage"
install -d -o ai-novel -g ai-novel -m 750 "$ROOT/.runtime/nginx/tmp"
for log in server.log nginx-access.log nginx-error.log; do
  touch "$ROOT/logs/$log"
  chown ai-novel:ai-novel "$ROOT/logs/$log"
  chmod 640 "$ROOT/logs/$log"
done
chown root:ai-novel "$ROOT/server/.env"
chmod 640 "$ROOT/server/.env"
sed "s|@ROOT@|$ROOT|g" "$ROOT/infra/server/nginx.conf.template" > "$ROOT/.runtime/nginx.conf"
runuser -u ai-novel -- "$ROOT/.runtime/nginx/usr/sbin/nginx" -t -e "$ROOT/logs/nginx-error.log" -p "$ROOT/.runtime/nginx/" -c "$ROOT/.runtime/nginx.conf"
cat > /etc/systemd/system/ai-novel-api.service <<EOF
[Unit]
Description=AI Novel API
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
User=ai-novel
Group=ai-novel
WorkingDirectory=$ROOT/server
Environment=NODE_ENV=production
Environment=PATH=$ROOT/.runtime/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$ROOT/.runtime/node/bin/node $ROOT/server/dist/app.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$ROOT/data $ROOT/logs $ROOT/.logs $ROOT/server/storage
StandardOutput=append:$ROOT/logs/server.log
StandardError=append:$ROOT/logs/server.log

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/ai-novel-web.service <<EOF
[Unit]
Description=AI Novel Web
After=network.target ai-novel-api.service
Wants=ai-novel-api.service

[Service]
Type=simple
User=ai-novel
Group=ai-novel
WorkingDirectory=$ROOT
ExecStart=$ROOT/.runtime/nginx/usr/sbin/nginx -e $ROOT/logs/nginx-error.log -p $ROOT/.runtime/nginx/ -c $ROOT/.runtime/nginx.conf -g "daemon off;"
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
KillSignal=SIGQUIT
TimeoutStopSec=60
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$ROOT/logs $ROOT/.runtime/nginx/tmp
StandardOutput=append:$ROOT/logs/nginx-error.log
StandardError=append:$ROOT/logs/nginx-error.log

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/logrotate.d/ai-novel <<EOF
$ROOT/logs/*.log {
    daily
    maxsize 50M
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su ai-novel ai-novel
}
EOF
systemd-analyze verify /etc/systemd/system/ai-novel-api.service /etc/systemd/system/ai-novel-web.service
systemctl daemon-reload
systemctl enable ai-novel-api ai-novel-web
echo '后台服务已安装并启用开机启动。运行 ./start.sh 启动。'

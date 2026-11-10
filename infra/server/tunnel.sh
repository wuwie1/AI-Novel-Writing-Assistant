#!/usr/bin/env bash
set -euo pipefail
DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == pid ]]; then
  exec bash "$DIR/tunnel/forward.sh" pid
fi
exec node "$DIR/tunnel/ensure.mjs" "${1:-start}"

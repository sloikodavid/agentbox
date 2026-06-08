#!/usr/bin/env bash
set -euo pipefail

exec /usr/local/bin/code-server \
  --bind-addr "0.0.0.0:${PORT:-8080}" \
  --disable-update-check \
  /home/user

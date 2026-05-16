#!/usr/bin/env bash
set -euo pipefail

exec /usr/local/bin/code-server \
	/home/user/Desktop \
	--bind-addr "0.0.0.0:${PORT:-8080}" \
	--user-data-dir /home/user/.local/share/code-server \
	--disable-update-check

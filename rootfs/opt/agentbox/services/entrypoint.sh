#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/agentbox /run/code-server /var/log/supervisor
node /opt/agentbox/rootfs.ts restore
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf

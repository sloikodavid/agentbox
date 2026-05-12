#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/agentbox /run/code-server /var/log/supervisor
chown user:user /run/code-server
node /opt/agentbox/rootfs.ts restore
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf

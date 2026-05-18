#!/usr/bin/env bash
set -euo pipefail

/opt/agentbox/bin/persistd apply
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf

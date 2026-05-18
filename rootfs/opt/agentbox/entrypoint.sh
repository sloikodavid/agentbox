#!/usr/bin/env bash
set -euo pipefail

/opt/agentbox/bin/persistd restore
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf

#!/usr/bin/env bash
set -euo pipefail

mkdir -p /run/agentbox /run/code-server /var/log/supervisor
chown user:user /run/code-server
/opt/agentbox/bin/persistd restore
workspace_path="$(node --input-type=module -e 'import { parseConfig } from "/opt/agentbox/config.ts"; process.stdout.write(parseConfig(process.env, { loadTlsFiles: false }).workspacePath);')"
if [[ ! -e "$workspace_path" ]]; then
	mkdir -p -- "$workspace_path"
	chown user:user -- "$workspace_path"
fi
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf

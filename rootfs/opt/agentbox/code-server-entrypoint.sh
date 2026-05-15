#!/usr/bin/env bash
set -euo pipefail

node /opt/agentbox/code-server.ts --prepare-launch
exec /run/code-server/launch.sh

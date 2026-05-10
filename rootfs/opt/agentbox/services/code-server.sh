#!/usr/bin/env bash
set -euo pipefail

args=(
  /home/user/Desktop
  --auth none
  --bind-addr 127.0.0.1:13337
  --disable-update-check
)

if [[ "${AGENTBOX_BASE_PATH:-/}" != "/" && -n "${AGENTBOX_BASE_PATH:-}" ]]; then
  path="${AGENTBOX_BASE_PATH}"
  [[ "$path" == /* ]] || path="/$path"
  path="${path%/}"
  args+=(--abs-proxy-base-path "$path")
fi

proxy_domain="$(
  node --input-type=module <<'JS'
const value = process.env.AGENTBOX_PORT_TEMPLATE_URL?.trim();
if (!value || value.startsWith("./") || value.startsWith("/")) {
	process.exit(0);
}
try {
	const url = new URL(value);
	const prefix = "{{port}}.";
	if (url.hostname.startsWith(prefix)) {
		console.log(url.hostname.slice(prefix.length));
	}
} catch {
	process.exit(0);
}
JS
)"
if [[ -n "$proxy_domain" ]]; then
  args+=(--proxy-domain "$proxy_domain")
fi

# `PORT` configures the public Agentbox gateway. code-server has its own
# fixed loopback listener behind that gateway, so clear the public port env to
# avoid code-server rebinding it.
unset PORT
export VSCODE_PROXY_URI="${AGENTBOX_PORT_TEMPLATE_URL:-./proxy/{{port}}}"
exec /usr/local/bin/code-server "${args[@]}"

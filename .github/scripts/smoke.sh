#!/usr/bin/env bash
set -Eeuo pipefail

: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${VOLUME_NAME:?VOLUME_NAME is required}"

# Runtime settings. CI provides the image/container/volume names above. The
# defaults keep the script runnable by hand when debugging.
readonly SMOKE_PORT="${SMOKE_PORT:-8080}"
readonly SMOKE_HEALTH_URL="${SMOKE_HEALTH_URL:-http://127.0.0.1:${SMOKE_PORT}/healthz}"
readonly SMOKE_READINESS_URL="${SMOKE_READINESS_URL:-${SMOKE_HEALTH_URL}}"
readonly SMOKE_HEALTH_ATTEMPTS=120
readonly SMOKE_READINESS_ATTEMPTS=180
readonly SMOKE_EXEC_ATTEMPTS=30
readonly SMOKE_PASSWORD="${SMOKE_PASSWORD:-smoke-password}"

# Logging and cleanup.
log() {
  printf '[smoke] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is missing: $1" >&2
    exit 127
  fi
}

require_host_tools() {
  require_command curl
  require_command docker
  require_command python3
}

# Keep each run isolated, even when a previous CI attempt left resources behind.
cleanup_resources() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
}

trap cleanup_resources EXIT
cleanup_resources

dump_container_logs() {
  docker ps -a >&2 || true
  docker logs "$CONTAINER_NAME" >&2 || true
}

on_failure() {
  local line="$1"
  echo "Smoke failed at line $line" >&2
  dump_container_logs
}

trap 'on_failure "$LINENO"' ERR

# Assertion and retry helpers.
assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"

  if ! grep -Fqi "$needle" <<<"$haystack"; then
    echo "Expected $label to contain: $needle" >&2
    echo "$haystack" >&2
    return 1
  fi
}

assert_container_running() {
  local state
  state="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$state" != "true" ]]; then
    echo "Container $CONTAINER_NAME is not running" >&2
    dump_container_logs
    return 1
  fi
}

curl_with_retries() {
  local url="$1"
  local attempts="$2"
  shift 2

  for _ in $(seq 1 "$attempts"); do
    assert_container_running
    if curl -kfsSL "$@" "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out fetching $url" >&2
  dump_container_logs
  return 1
}

wait_for_url() {
  curl_with_retries "$1" "$2" -o /dev/null
}

fetch_text() {
  local url="$1"
  local attempts="$2"
  shift 2
  curl_with_retries "$url" "$attempts" "$@"
}

# Authenticated HTTP helpers.
login_agentbox() {
  local base_url="$1"
  local cookie_jar="$2"
  rm -f "$cookie_jar"

  # Load the login page first so code-server can issue its auth/session cookie.
  fetch_text "${base_url}/login" "$SMOKE_READINESS_ATTEMPTS" -c "$cookie_jar" -b "$cookie_jar" >/dev/null
  curl_with_retries "${base_url}/login" "$SMOKE_READINESS_ATTEMPTS" \
    -c "$cookie_jar" \
    -b "$cookie_jar" \
    -o /dev/null \
    --data-urlencode "password=${SMOKE_PASSWORD}" \
    --data-urlencode "base=." \
    --data-urlencode "href=${base_url}/login"
}

fetch_authed_text() {
  local url="$1"
  local attempts="$2"
  local cookie_jar="$3"
  fetch_text "$url" "$attempts" -b "$cookie_jar"
}

# Docker command helpers.
wait_for_exec() {
  local attempts="$1"
  shift

  for _ in $(seq 1 "$attempts"); do
    assert_container_running
    if docker exec "$CONTAINER_NAME" "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for command in $CONTAINER_NAME: $*" >&2
  dump_container_logs
  return 1
}

wait_for_container_file() {
  local path="$1"
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f "$1"' sh "$path"
}

wait_for_container_path_absent() {
  local path="$1"
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test ! -e "$1"' sh "$path"
}

assert_container_path_stays_absent() {
  local path="$1"
  local seconds="${2:-5}"

  for _ in $(seq 1 "$seconds"); do
    assert_container_running
    docker exec "$CONTAINER_NAME" sh -lc 'test ! -e "$1"' sh "$path"
    sleep 1
  done
}

run_default_container() {
  log "starting default container"
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${SMOKE_PORT}:${SMOKE_PORT}" \
    -e "PORT=${SMOKE_PORT}" \
    -e "PASSWORD=${SMOKE_PASSWORD}" \
    -v "$VOLUME_NAME:/data" \
    "$IMAGE_TAG" >/dev/null
}

assert_websocket_upgrade() {
  local cookie_jar="$1"

  # curl cannot complete a WebSocket handshake assertion on its own. This sends
  # the minimum authenticated HTTP upgrade request and verifies the response.
  SMOKE_WEBSOCKET_PORT="$SMOKE_PORT" SMOKE_COOKIE_JAR="$cookie_jar" python3 - <<'PY'
import base64
import hashlib
import os
import socket

port = int(os.environ["SMOKE_WEBSOCKET_PORT"])
cookies = []
with open(os.environ["SMOKE_COOKIE_JAR"], encoding="utf-8") as cookie_file:
    for line in cookie_file:
        if line.startswith("#") or not line.strip():
            continue
        fields = line.rstrip("\n").split("\t")
        if len(fields) >= 7:
            cookies.append(f"{fields[5]}={fields[6]}")
cookie_header = "; ".join(cookies)
key = base64.b64encode(os.urandom(16)).decode("ascii")
request = (
    "GET /websocket-smoke HTTP/1.1\r\n"
    f"Host: 127.0.0.1:{port}\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    f"Cookie: {cookie_header}\r\n"
    f"Sec-WebSocket-Key: {key}\r\n"
    "Sec-WebSocket-Version: 13\r\n\r\n"
)
response = b""
with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
    connection.settimeout(5)
    connection.sendall(request.encode("ascii"))
    while b"\r\n\r\n" not in response:
        chunk = connection.recv(4096)
        if not chunk:
            break
        response += chunk

text = response.decode("latin1")
lines = text.split("\r\n")
headers = {}
for line in lines[1:]:
    if ":" in line:
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()

expected_accept = base64.b64encode(
    hashlib.sha1(
        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
    ).digest()
).decode("ascii")
assert lines and lines[0].startswith("HTTP/1.1 101"), text
assert headers.get("upgrade", "").lower() == "websocket", text
assert "upgrade" in [
    part.strip().lower() for part in headers.get("connection", "").split(",")
], text
assert headers.get("sec-websocket-accept") == expected_accept, text
PY
}

# Smoke scenario 1: the image boots, serves code-server, and supports auth.
assert_web_app_smoke() {
  log "checking web app startup, auth, and code-server"
  wait_for_url "$SMOKE_HEALTH_URL" "$SMOKE_HEALTH_ATTEMPTS"
  if [[ "$SMOKE_READINESS_URL" != "$SMOKE_HEALTH_URL" ]]; then
    wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  fi

  local cookie_jar
  cookie_jar="$(mktemp)"
  login_agentbox "http://127.0.0.1:${SMOKE_PORT}" "$cookie_jar"

  local root_page
  root_page="$(fetch_authed_text "http://127.0.0.1:${SMOKE_PORT}/" "$SMOKE_READINESS_ATTEMPTS" "$cookie_jar")"
  assert_contains "default root page" "$root_page" "code-server"

  assert_websocket_upgrade "$cookie_jar"
  rm -f "$cookie_jar"
  docker exec "$CONTAINER_NAME" sudo -u user sudo -n true
  docker exec "$CONTAINER_NAME" sudo -u user code --version >/dev/null 2>&1
}

# Smoke scenario 2: persistd records filesystem changes and applies them on boot.
assert_persistd_applies_changes() {
  log "checking persistd applies filesystem changes"

  log "checking persistd layout and command surface"
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -x /opt/persistd/bin/persistd'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test ! -e /opt/persistd/bin/persistd-baseline'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /opt/persistd/baseline.sqlite'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /data/persistd/.internal/state.sqlite'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /run/persistd/ready'
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /run/persistd/restore-failed'
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /run/persistd/watch-failed'
  docker exec "$CONTAINER_NAME" sh -lc '/opt/persistd/bin/persistd status --json | jq -e ".ready == true and .baselineValid == true"' >/dev/null
  docker exec "$CONTAINER_NAME" sh -lc '/opt/persistd/bin/persistd doctor --json | jq -e ".rebuiltPublicIndex == true"' >/dev/null
  docker exec "$CONTAINER_NAME" sh -lc '/opt/persistd/bin/persistd prune --json | jq -e ".removed | type == \"array\""' >/dev/null

  log "creating files that should be applied after restart"
  docker exec "$CONTAINER_NAME" \
    sudo -u user sh -lc 'printf hello > /home/user/Desktop/smoke.txt'
  docker exec "$CONTAINER_NAME" sh -lc 'printf restored > /custom-restore'
  docker exec "$CONTAINER_NAME" sh -lc 'mkdir -p /foo123 && printf nested > /foo123/nested.txt'

  log "waiting for persistd to record changed filesystem state"
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /data/persistd/config.json'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -d /data/persistd/changed'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -d /data/persistd/removed'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /data/persistd/metadata.jsonl'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /data/persistd/.internal/lock'
  wait_for_container_file /data/persistd/changed/home/user/Desktop/smoke.txt
  wait_for_container_file /data/persistd/changed/custom-restore
  wait_for_container_file /data/persistd/changed/foo123/nested.txt

  log "restarting container and checking changed files are applied"
  docker restart "$CONTAINER_NAME" >/dev/null
  wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /home/user/Desktop/smoke.txt)" = hello'
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /custom-restore)" = restored'
  docker exec "$CONTAINER_NAME" sh -lc 'test -d /foo123'
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /foo123/nested.txt)" = nested'

  log "removing a file and checking the removal is applied"
  docker exec "$CONTAINER_NAME" sh -lc 'rm /custom-restore'
  wait_for_container_path_absent /data/persistd/changed/custom-restore
  docker restart "$CONTAINER_NAME" >/dev/null
  wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /custom-restore'

  log "recreating container with the same volume and checking changes are applied"
  docker rm -f "$CONTAINER_NAME" >/dev/null
  run_default_container
  wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /home/user/Desktop/smoke.txt)" = hello'
  docker exec "$CONTAINER_NAME" sh -lc 'test -d /foo123'

  log "checking image-file deletion and tombstone removal"
  docker exec "$CONTAINER_NAME" sh -lc 'rm /usr/share/applications/agentbox.desktop'
  wait_for_container_file /data/persistd/removed/usr/share/applications/agentbox.desktop
  docker rm -f "$CONTAINER_NAME" >/dev/null
  run_default_container
  wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /usr/share/applications/agentbox.desktop'
  docker exec "$CONTAINER_NAME" sh -lc 'rm -f /data/persistd/removed/usr/share/applications/agentbox.desktop'
  docker rm -f "$CONTAINER_NAME" >/dev/null
  run_default_container
  wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test -f /usr/share/applications/agentbox.desktop'

  log "checking baseline-equal changes do not remain in changed"
  docker exec "$CONTAINER_NAME" sh -lc 'cp /etc/mailcap /tmp/mailcap.baseline && printf changed > /etc/mailcap'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -e /data/persistd/changed/etc/mailcap'
  docker exec "$CONTAINER_NAME" sh -lc 'cat /tmp/mailcap.baseline > /etc/mailcap'
  wait_for_container_path_absent /data/persistd/changed/etc/mailcap

  log "checking touched large baseline file does not create changed payload"
  local large
  large="$(docker exec "$CONTAINER_NAME" sh -lc 'find /opt/code-server/current -xdev -type f -size +1M | head -n1')"
  test -n "$large"
  docker exec "$CONTAINER_NAME" sh -lc 'touch "$1"' sh "$large"
  assert_container_path_stays_absent "/data/persistd/changed/${large#/}" 5

  log "checking custom exclusions are ignored and not pruned"
  docker exec "$CONTAINER_NAME" sh -lc 'tmp="$(mktemp)"; jq ".exclusions += [\"/excluded-smoke\"]" /data/persistd/config.json > "$tmp"; mv "$tmp" /data/persistd/config.json'
  docker restart "$CONTAINER_NAME" >/dev/null
  wait_for_url "$SMOKE_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'mkdir -p /excluded-smoke && printf ignored > /excluded-smoke/file'
  assert_container_path_stays_absent /data/persistd/changed/excluded-smoke/file 5
  docker exec "$CONTAINER_NAME" sh -lc 'mkdir -p /data/persistd/changed/excluded-smoke /data/persistd/removed/excluded-smoke && printf dormant > /data/persistd/changed/excluded-smoke/dormant && : > /data/persistd/removed/excluded-smoke/tombstone'
  docker exec "$CONTAINER_NAME" /opt/persistd/bin/persistd prune --json >/dev/null
  docker exec "$CONTAINER_NAME" sh -lc 'test -f /data/persistd/changed/excluded-smoke/dormant'
  docker exec "$CONTAINER_NAME" sh -lc 'test -f /data/persistd/removed/excluded-smoke/tombstone'
}

# Main smoke flow.
require_host_tools
docker volume create "$VOLUME_NAME" >/dev/null

run_default_container
assert_web_app_smoke
assert_persistd_applies_changes

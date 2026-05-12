#!/usr/bin/env bash
set -euo pipefail

: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${CUSTOM_VOLUME_NAME:?CUSTOM_VOLUME_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${TLS_VOLUME_NAME:?TLS_VOLUME_NAME is required}"
: "${VOLUME_NAME:?VOLUME_NAME is required}"

readonly SMOKE_DEFAULT_PORT="${SMOKE_DEFAULT_PORT:-8080}"
readonly SMOKE_CUSTOM_PORT="${SMOKE_CUSTOM_PORT:-9090}"
readonly SMOKE_TLS_PORT="${SMOKE_TLS_PORT:-9443}"
readonly SMOKE_DEFAULT_HEALTH_URL="http://127.0.0.1:${SMOKE_DEFAULT_PORT}/healthz"
readonly SMOKE_DEFAULT_READINESS_URL="${SMOKE_DEFAULT_HEALTH_URL}/readiness"
readonly SMOKE_CUSTOM_BASE_URL="http://127.0.0.1:${SMOKE_CUSTOM_PORT}/agentbox"
readonly SMOKE_TLS_BASE_URL="https://127.0.0.1:${SMOKE_TLS_PORT}/secure"
readonly SMOKE_HEALTH_ATTEMPTS=120
readonly SMOKE_READINESS_ATTEMPTS=180
readonly SMOKE_EXEC_ATTEMPTS=30
readonly SMOKE_PORT_PROXY_ATTEMPTS=30
readonly SMOKE_PASSWORD="${SMOKE_PASSWORD:-smoke-password}"

log() {
  printf '[smoke] %s\n' "$*"
}

cleanup_resources() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  docker volume rm "$CUSTOM_VOLUME_NAME" >/dev/null 2>&1 || true
  docker volume rm "$TLS_VOLUME_NAME" >/dev/null 2>&1 || true
}

trap cleanup_resources EXIT
cleanup_resources

dump_container_logs() {
  docker ps -a >&2 || true
  docker logs "$CONTAINER_NAME" >&2 || true
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

login_agentbox() {
  local base_url="$1"
  local cookie_jar="$2"
  rm -f "$cookie_jar"
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

run_default_container() {
  log "starting default container"
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${SMOKE_DEFAULT_PORT}:${SMOKE_DEFAULT_PORT}" \
    -e "PORT=${SMOKE_DEFAULT_PORT}" \
    -e "AGENTBOX_PASSWORD=${SMOKE_PASSWORD}" \
    -e AGENTBOX_VOLUME_PATH=/data \
    -v "$VOLUME_NAME:/data" \
    "$IMAGE_TAG" >/dev/null
}

run_custom_container() {
  log "starting custom container"
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${SMOKE_CUSTOM_PORT}:${SMOKE_CUSTOM_PORT}" \
    -e "PORT=${SMOKE_CUSTOM_PORT}" \
    -e "AGENTBOX_PASSWORD=${SMOKE_PASSWORD}" \
    -e AGENTBOX_PUBLIC_URL=https://example.com/agentbox \
    -e AGENTBOX_VOLUME_PATH=/persist \
    -e AGENTBOX_ENABLE_METRICS=1 \
    -e 'AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE=https://{{port}}.ports.example.com' \
    -v "$CUSTOM_VOLUME_NAME:/persist" \
    "$IMAGE_TAG" >/dev/null
}

run_tls_container() {
  log "starting TLS container"
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${SMOKE_TLS_PORT}:${SMOKE_TLS_PORT}" \
    -e "PORT=${SMOKE_TLS_PORT}" \
    -e "AGENTBOX_PASSWORD=${SMOKE_PASSWORD}" \
    -e "AGENTBOX_PUBLIC_URL=https://127.0.0.1:${SMOKE_TLS_PORT}/secure" \
    -e AGENTBOX_TLS_KEY_PATH=/certs/key.pem \
    -e AGENTBOX_TLS_CERT_PATH=/certs/cert.pem \
    -e AGENTBOX_VOLUME_PATH=/tls-data \
    -v "$TLS_VOLUME_NAME:/tls-data" \
    -v "$PWD/tests/fixtures:/certs:ro" \
    "$IMAGE_TAG" >/dev/null
}

assert_websocket_upgrade() {
  local cookie_jar="$1"
  SMOKE_DEFAULT_PORT="$SMOKE_DEFAULT_PORT" SMOKE_COOKIE_JAR="$cookie_jar" python3 - <<'PY'
import base64
import hashlib
import os
import socket

port = int(os.environ["SMOKE_DEFAULT_PORT"])
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

assert_default_container() {
  log "checking default container"
  wait_for_url "$SMOKE_DEFAULT_HEALTH_URL" "$SMOKE_HEALTH_ATTEMPTS"
  wait_for_url "$SMOKE_DEFAULT_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"

  local cookie_jar
  cookie_jar="$(mktemp)"
  login_agentbox "http://127.0.0.1:${SMOKE_DEFAULT_PORT}" "$cookie_jar"

  local root_page
  root_page="$(fetch_authed_text "http://127.0.0.1:${SMOKE_DEFAULT_PORT}/" "$SMOKE_READINESS_ATTEMPTS" "$cookie_jar")"
  grep -qi code-server <<<"$root_page"

  assert_websocket_upgrade "$cookie_jar"
  rm -f "$cookie_jar"
  docker exec "$CONTAINER_NAME" sudo -u user sudo -n true
  docker exec "$CONTAINER_NAME" sudo -u user code --version >/dev/null 2>&1
}

assert_rootfs_persistence() {
  log "checking rootfs persistence"
  docker exec "$CONTAINER_NAME" \
    sudo -u user sh -lc 'printf hello > /home/user/Desktop/smoke.txt'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" \
    sh -lc 'test "$(cat /data/rootfs/files/home/user/Desktop/smoke.txt)" = hello'

  docker exec "$CONTAINER_NAME" sh -lc 'printf restored > /custom-restore'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" \
    sh -lc 'test "$(cat /data/rootfs/files/custom-restore)" = restored'

  docker exec "$CONTAINER_NAME" sh -lc 'printf persisted > /custom-persist'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /data/rootfs/files/custom-persist'

  docker exec "$CONTAINER_NAME" sh -lc 'rm /custom-persist'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" \
    sh -lc 'test -f /data/rootfs/removed-files/custom-persist.__removed__'

  docker restart "$CONTAINER_NAME" >/dev/null
  wait_for_url "$SMOKE_DEFAULT_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /custom-restore)" = restored'
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /custom-persist'

  docker rm -f "$CONTAINER_NAME" >/dev/null
  run_default_container
  wait_for_url "$SMOKE_DEFAULT_READINESS_URL" "$SMOKE_READINESS_ATTEMPTS"
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /custom-restore)" = restored'
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /custom-persist'
}

assert_custom_container() {
  log "checking custom container"
  wait_for_url "${SMOKE_CUSTOM_BASE_URL}/healthz/readiness" "$SMOKE_READINESS_ATTEMPTS"

  local status_response
  status_response="$(fetch_text "${SMOKE_CUSTOM_BASE_URL}/healthz" "$SMOKE_READINESS_ATTEMPTS")"
  grep -q '"ready":true' <<<"$status_response"

  local metrics_response
  metrics_response="$(fetch_text "${SMOKE_CUSTOM_BASE_URL}/metrics" "$SMOKE_READINESS_ATTEMPTS")"
  grep -q 'agentbox_ready 1' <<<"$metrics_response"

  local cookie_jar
  cookie_jar="$(mktemp)"
  login_agentbox "$SMOKE_CUSTOM_BASE_URL" "$cookie_jar"

  local root_page
  root_page="$(fetch_authed_text "${SMOKE_CUSTOM_BASE_URL}/" "$SMOKE_READINESS_ATTEMPTS" "$cookie_jar")"
  grep -qi code-server <<<"$root_page"

  docker exec "$CONTAINER_NAME" sh -lc \
    'pgrep -u user -af "[c]ode-server" | grep -F -- "--proxy-domain {{port}}.ports.example.com"' >/dev/null
  docker exec "$CONTAINER_NAME" sudo -u user sh -lc \
    'pid="$(pgrep -u user -f "[c]ode-server" | head -n1)" &&
      test -n "$pid" &&
      tr "\0" "\n" < "/proc/$pid/environ" |
        grep -F "VSCODE_PROXY_URI=https://{{port}}.ports.example.com"' >/dev/null

  docker exec -d "$CONTAINER_NAME" sudo -u user sh -lc \
    'mkdir -p /tmp/agentbox-port-proxy &&
      printf port-proxy-ok > /tmp/agentbox-port-proxy/smoke.txt &&
      cd /tmp/agentbox-port-proxy &&
      python3 -m http.server 7777 --bind 127.0.0.1'

  for i in $(seq 1 "$SMOKE_PORT_PROXY_ATTEMPTS"); do
    local proxy_response
    proxy_response="$(
      curl -fsS -b "$cookie_jar" \
        "${SMOKE_CUSTOM_BASE_URL}/proxy/7777/smoke.txt" 2>/dev/null || true
    )"
    if [[ "$proxy_response" == "port-proxy-ok" ]]; then
      break
    fi
    if [[ "$i" -eq "$SMOKE_PORT_PROXY_ATTEMPTS" ]]; then
      echo "Timed out waiting for code-server port proxy" >&2
      dump_container_logs
      exit 1
    fi
    sleep 1
  done

  rm -f "$cookie_jar"

  docker exec "$CONTAINER_NAME" sh -lc 'printf custom > /custom-volume-path'
  wait_for_exec "$SMOKE_EXEC_ATTEMPTS" sh -lc 'test -f /persist/rootfs/files/custom-volume-path'
}

assert_tls_container() {
  log "checking TLS container"
  wait_for_url "${SMOKE_TLS_BASE_URL}/healthz/readiness" "$SMOKE_READINESS_ATTEMPTS"

  local health_response
  health_response="$(fetch_text "${SMOKE_TLS_BASE_URL}/healthz" "$SMOKE_READINESS_ATTEMPTS")"
  grep -q '"ready":true' <<<"$health_response"

  local cookie_jar
  cookie_jar="$(mktemp)"
  login_agentbox "$SMOKE_TLS_BASE_URL" "$cookie_jar"

  local root_page
  root_page="$(fetch_authed_text "${SMOKE_TLS_BASE_URL}/" "$SMOKE_READINESS_ATTEMPTS" "$cookie_jar")"
  grep -qi code-server <<<"$root_page"
  rm -f "$cookie_jar"
}

docker volume create "$VOLUME_NAME" >/dev/null
docker volume create "$CUSTOM_VOLUME_NAME" >/dev/null
docker volume create "$TLS_VOLUME_NAME" >/dev/null

run_default_container
assert_default_container
assert_rootfs_persistence

docker rm -f "$CONTAINER_NAME" >/dev/null
run_custom_container
assert_custom_container

docker rm -f "$CONTAINER_NAME" >/dev/null
run_tls_container
assert_tls_container

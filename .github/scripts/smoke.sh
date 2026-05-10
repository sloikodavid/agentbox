#!/usr/bin/env bash
set -euo pipefail

: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${CUSTOM_VOLUME_NAME:?CUSTOM_VOLUME_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${TLS_VOLUME_NAME:?TLS_VOLUME_NAME is required}"
: "${VOLUME_NAME:?VOLUME_NAME is required}"

readonly DEFAULT_PORT=8080
readonly CUSTOM_PORT=9090
readonly TLS_PORT=9443
readonly DEFAULT_HEALTH_URL="http://127.0.0.1:${DEFAULT_PORT}/healthz"
readonly DEFAULT_READINESS_URL="${DEFAULT_HEALTH_URL}/readiness"
readonly CUSTOM_BASE_URL="http://127.0.0.1:${CUSTOM_PORT}/agentbox"
readonly TLS_BASE_URL="https://127.0.0.1:${TLS_PORT}/secure"

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

wait_for_url() {
  local url="$1"
  local attempts="$2"

  for _ in $(seq 1 "$attempts"); do
    assert_container_running
    if curl -kfsS -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $url" >&2
  dump_container_logs
  return 1
}

wait_for_exec() {
  local attempts="$1"
  shift

  for _ in $(seq 1 "$attempts"); do
    assert_container_running
    if docker exec "$CONTAINER_NAME" "$@"; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for command in $CONTAINER_NAME: $*" >&2
  dump_container_logs
  return 1
}

run_default_container() {
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${DEFAULT_PORT}:${DEFAULT_PORT}" \
    -e AGENTBOX_VOLUME_PATH=/data \
    -v "$VOLUME_NAME:/data" \
    "$IMAGE_TAG"
}

run_custom_container() {
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${CUSTOM_PORT}:${CUSTOM_PORT}" \
    -e "PORT=${CUSTOM_PORT}" \
    -e AGENTBOX_BASE_PATH=/agentbox \
    -e AGENTBOX_HEALTH_PATH=/status \
    -e AGENTBOX_URL=https://example.com/agentbox \
    -e AGENTBOX_VOLUME_PATH=/persist \
    -e AGENTBOX_ENABLE_METRICS=1 \
    -e 'AGENTBOX_PORT_TEMPLATE_URL=https://{{port}}.ports.example.com' \
    -v "$CUSTOM_VOLUME_NAME:/persist" \
    "$IMAGE_TAG"
}

run_tls_container() {
  docker run -d --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${TLS_PORT}:${TLS_PORT}" \
    -e "PORT=${TLS_PORT}" \
    -e AGENTBOX_BASE_PATH=/secure \
    -e AGENTBOX_PROTOCOL=https \
    -e AGENTBOX_SSL_KEY=/certs/key.pem \
    -e AGENTBOX_SSL_CERT=/certs/cert.pem \
    -e AGENTBOX_VOLUME_PATH=/tls-data \
    -v "$TLS_VOLUME_NAME:/tls-data" \
    -v "$PWD/tests/fixtures:/certs:ro" \
    "$IMAGE_TAG"
}

assert_websocket_upgrade() {
  python3 - <<'PY'
import base64
import hashlib
import os
import socket

key = base64.b64encode(os.urandom(16)).decode("ascii")
request = (
    "GET /websocket-smoke HTTP/1.1\r\n"
    "Host: 127.0.0.1:8080\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\n"
    "Sec-WebSocket-Version: 13\r\n\r\n"
)
response = b""
with socket.create_connection(("127.0.0.1", 8080), timeout=5) as connection:
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
  wait_for_url "$DEFAULT_HEALTH_URL" 120
  wait_for_url "$DEFAULT_READINESS_URL" 180

  local root_page
  root_page="$(curl -fsS "http://127.0.0.1:${DEFAULT_PORT}/")"
  grep -qi code-server <<<"$root_page"

  assert_websocket_upgrade
  docker exec "$CONTAINER_NAME" sudo -u user sudo -n true
  docker exec "$CONTAINER_NAME" sudo -u user code --version
}

assert_rootfs_persistence() {
  docker exec "$CONTAINER_NAME" \
    sudo -u user sh -lc 'printf hello > /home/user/Desktop/smoke.txt'
  wait_for_exec 30 \
    sh -lc 'test "$(cat /data/rootfs/files/home/user/Desktop/smoke.txt)" = hello'

  docker exec "$CONTAINER_NAME" sh -lc 'printf restored > /custom-restore'
  wait_for_exec 30 \
    sh -lc 'test "$(cat /data/rootfs/files/custom-restore)" = restored'

  docker exec "$CONTAINER_NAME" sh -lc 'printf persisted > /custom-persist'
  wait_for_exec 30 sh -lc 'test -f /data/rootfs/files/custom-persist'

  docker exec "$CONTAINER_NAME" sh -lc 'rm /custom-persist'
  wait_for_exec 30 \
    sh -lc 'test -f /data/rootfs/removed-files/custom-persist.__removed__'

  docker restart "$CONTAINER_NAME"
  wait_for_url "$DEFAULT_READINESS_URL" 180
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /custom-restore)" = restored'
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /custom-persist'

  docker rm -f "$CONTAINER_NAME"
  run_default_container
  wait_for_url "$DEFAULT_READINESS_URL" 180
  docker exec "$CONTAINER_NAME" sh -lc 'test "$(cat /custom-restore)" = restored'
  docker exec "$CONTAINER_NAME" sh -lc 'test ! -e /custom-persist'
}

assert_custom_container() {
  wait_for_url "${CUSTOM_BASE_URL}/status/readiness" 180

  local status_response
  status_response="$(curl -fsS "${CUSTOM_BASE_URL}/status")"
  grep -q '"ready":true' <<<"$status_response"

  local metrics_response
  metrics_response="$(curl -fsS "${CUSTOM_BASE_URL}/metrics")"
  grep -q 'agentbox_ready 1' <<<"$metrics_response"

  local root_page
  root_page="$(curl -fsS "${CUSTOM_BASE_URL}/")"
  grep -qi code-server <<<"$root_page"

  docker exec "$CONTAINER_NAME" sh -lc \
    'pgrep -u user -af "[c]ode-server" | grep -F -- "--proxy-domain ports.example.com"'
  docker exec "$CONTAINER_NAME" sh -lc \
    'pid="$(pgrep -u user -f "[c]ode-server" | head -n1)" &&
      test -n "$pid" &&
      tr "\0" "\n" < "/proc/$pid/environ" |
        grep -F "VSCODE_PROXY_URI=https://{{port}}.ports.example.com"'

  docker exec -d "$CONTAINER_NAME" sudo -u user sh -lc \
    'mkdir -p /tmp/agentbox-port-proxy &&
      printf port-proxy-ok > /tmp/agentbox-port-proxy/smoke.txt &&
      cd /tmp/agentbox-port-proxy &&
      python3 -m http.server 7777 --bind 127.0.0.1'

  for i in $(seq 1 30); do
    local proxy_response
    proxy_response="$(
      curl -fsS -H 'Host: 7777.ports.example.com' \
        "http://127.0.0.1:${CUSTOM_PORT}/smoke.txt" || true
    )"
    if [[ "$proxy_response" == "port-proxy-ok" ]]; then
      break
    fi
    if [[ "$i" -eq 30 ]]; then
      echo "Timed out waiting for code-server port proxy" >&2
      dump_container_logs
      exit 1
    fi
    sleep 1
  done

  docker exec "$CONTAINER_NAME" sh -lc 'printf custom > /custom-volume-path'
  wait_for_exec 30 sh -lc 'test -f /persist/rootfs/files/custom-volume-path'
}

assert_tls_container() {
  wait_for_url "${TLS_BASE_URL}/healthz/readiness" 180

  local health_response
  health_response="$(curl -kfsS "${TLS_BASE_URL}/healthz")"
  grep -q '"ready":true' <<<"$health_response"

  local root_page
  root_page="$(curl -kfsS "${TLS_BASE_URL}/")"
  grep -qi code-server <<<"$root_page"
}

docker volume create "$VOLUME_NAME"
docker volume create "$CUSTOM_VOLUME_NAME"
docker volume create "$TLS_VOLUME_NAME"

run_default_container
assert_default_container
assert_rootfs_persistence

docker rm -f "$CONTAINER_NAME"
run_custom_container
assert_custom_container

docker rm -f "$CONTAINER_NAME"
run_tls_container
assert_tls_container

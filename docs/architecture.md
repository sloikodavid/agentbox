# Agentbox architecture

## Product contract

Agentbox is a self-hostable image that feels like a persistent VPS with a browser workspace. The user owns the mutable root filesystem and gets passwordless sudo inside the authenticated workspace. Agentbox owns the control plane needed to boot, persist, and proxy that workspace.

## Public surface

The image exposes one public listener: `PORT`. Agentbox-owned configuration uses `AGENTBOX_*`; `PORT` stays unprefixed because it is platform-standard.

`AGENTBOX_PUBLIC_URL` is the public URL for the gateway. Its pathname is derived internally as `baseUrlPath`; there is no separate public path variable.

`AGENTBOX_PUBLIC_PROXY_URL_TEMPLATE` is the URL template used for code-server previews. If its hostname contains `{{port}}`, Agentbox derives `proxyHostnameTemplate` for hostname-based preview routing.

`AGENTBOX_WORKSPACE_PATH` is the absolute path opened by code-server at startup. It defaults to `/home/user/Desktop`.

`AGENTBOX_DISABLE_METRICS` controls the gateway `/metrics` endpoint. It defaults to `true`.

The default code-server user settings disable telemetry and Workspace Trust for a VPS-like editing experience. Agentbox exposes selected code-server policy toggles with Agentbox-owned names: `AGENTBOX_DISABLE_FILE_DOWNLOADS` and `AGENTBOX_DISABLE_FILE_UPLOADS`.

## Gateway

The gateway is a thin front door. It owns:

- public `PORT` listener.
- optional TLS termination from configured cert/key files.
- health, readiness, and optional metrics disabled by default.
- persistence and code-server readiness checks.
- exact `baseUrlPath` stripping.
- HTTP and WebSocket forwarding to code-server.
- forwarded host/proto/prefix headers needed by code-server.

The gateway does not own workspace auth, login UI, public app ingress, tunnels, or port publishing state.

## code-server substrate

code-server runs on a fixed loopback port behind the gateway. It owns workspace auth, sessions, logout, WebSocket auth, and private previews such as `/proxy/<port>` and hostname-based proxying.

Users configure Agentbox, not code-server directly. Agentbox maps intentional config into the code-server child process and prevents public `PORT` or upstream code-server env vars from accidentally controlling it.

## Persistence

Agentbox persists user and system changes broadly so the container behaves like a VPS. This includes home files, package installs, system tweaks, and user-created app files.

Agentbox control-plane and volatile runtime paths regenerate from the image and are not persisted. Exclusions include `/opt/agentbox`, `/opt/code-server`, `/etc/supervisor`, `/proc`, `/sys`, `/dev`, `/run`, `/tmp`, Docker-injected host files, lock/cache paths, and the mounted volume path itself.

## Auth configuration

Workspace auth uses code-server mechanics.

```env
AGENTBOX_AUTH=password|none
AGENTBOX_PASSWORD=...
AGENTBOX_HASHED_PASSWORD=...
```

`AGENTBOX_AUTH=password` is the default and requires exactly one of `AGENTBOX_PASSWORD` or `AGENTBOX_HASHED_PASSWORD`. `AGENTBOX_AUTH=none` is an explicit escape hatch for deployments with trusted external access control.

## Private previews vs public ingress

code-server port previews are private workspace previews. They are not a public webhook product surface.

Public webhooks and public apps use standard deployment tools outside the image: platform routing, a reverse proxy, tunnels, or managed cloud infrastructure. Agentbox does not include a custom public ingress endpoint or a port-publishing CLI.

## Deployment modes

The no-compose image is the product core and should run directly on Docker-capable platforms. Compose/Caddy or other reverse-proxy recipes may exist as VPS deployment examples, but they are not required for the image contract.

## Cloud hosted offering

A future cloud offering should run the same Agentbox image with managed infrastructure around it: domains, TLS, routing, sandboxing, backups, abuse controls, and automation. It should not create a divergent in-box product contract.

## What does not belong in the image

The core image should not bake in Caddy, ngrok, cloudflared, Tailscale, a custom ingress router, or cloud-specific behavior as the default product flow.

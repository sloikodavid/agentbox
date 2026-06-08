# Agentbox with Caddy

This example runs Agentbox behind Caddy with automatic HTTPS.

## Prerequisites

- a Linux host with Docker Compose;
- a domain or subdomain pointing at the host;
- inbound TCP ports `80` and `443` open.

## Run

```bash
# edit Caddyfile and replace example.com with your domain
# optionally uncomment the PASSWORD environment to pre-register
docker compose up -d
```

Open `https://<your-domain>`.

On first visit, register the initial Agentbox password in the browser if you didn't already set the `PASSWORD` environment variable. To pin a
specific image version, edit `compose.yml` and replace the `agentbox` image tag
with the version or digest you want to run.

Agentbox does not wrap code-server settings with `AGENTBOX_*` variables. Set
code-server variables directly in the `agentbox.environment` block when you need
them; for example, uncomment the `PASSWORD` environment variable in `compose.yml` to use an
environment-managed password instead of first-visit registration.

Agentbox state is stored in the `agentbox_data` Docker volume. Caddy certificate
state is stored in `caddy_data` and `caddy_config`.

## Upgrade

```bash
docker compose pull
docker compose up -d
```

Back up `agentbox_data` before major upgrades.

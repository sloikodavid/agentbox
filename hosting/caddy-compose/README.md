# Composery with Caddy

This example runs Composery behind Caddy with automatic HTTPS.

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

On first visit, register the initial Composery password in the browser if you didn't already set the `PASSWORD` environment variable. To pin a
specific image version, edit `compose.yml` and replace the `composery` image tag
with the version or digest you want to run.

Composery does not wrap code-server settings with `COMPOSERY_*` variables. Set
code-server variables directly in the `composery.environment` block when you need
them; for example, uncomment the `PASSWORD` environment variable in `compose.yml` to use an
environment-managed password instead of first-visit registration.

Composery state is stored in the `composery_data` Docker volume. Caddy certificate
state is stored in `caddy_data` and `caddy_config`.

## Upgrade

```bash
docker compose pull
docker compose up -d
```

Back up `composery_data` before major upgrades.

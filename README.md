# Agentbox

Agentbox is a persistent, VPS-like Linux appliance with code-server in the browser.
It runs as one container, but `persistd` stores root filesystem changes on a single
mounted `/data` volume so installed packages, edited config, CLI state, projects,
and user files survive restarts and image upgrades.

## Quick Start

```bash
docker compose up --build
```

Open `http://localhost:8080` and sign in with the password from `compose.yml`.
For local development the default password is `12345`; change it before exposing
the container to a network.

## Self-Hosting

For a real domain and automatic HTTPS, use the Caddy example:

```bash
cd hosting/docker-caddy
# edit Caddyfile and replace agentbox.example.com with your domain
docker compose up -d
```

See [docs/self-hosting.md](docs/self-hosting.md) for deployment targets,
operational notes, and the persistence contract.

On first visit, the browser registration flow creates the initial password. If
you deliberately want an environment-managed password instead, set code-server's
standard `PASSWORD` or `HASHED_PASSWORD` variable in Compose.

Agentbox does not define `AGENTBOX_*` runtime wrappers around code-server
settings. Use code-server environment variables directly.

## Deployment Shape

Agentbox currently needs:

- one Agentbox container;
- one persistent volume mounted at `/data`;
- one HTTP edge, usually Caddy, nginx, Traefik, or a platform proxy;
- root inside the container so `persistd` can rebuild the filesystem on boot.

The production cloud repo deploys this shape on Hetzner VPSes with Docker Compose
and Caddy.

Do not run multiple Agentbox containers against the same `/data` volume. `persistd`
is a single-writer filesystem delta daemon.

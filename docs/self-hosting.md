# Self-Hosting Composery

Composery should feel like a small Debian-style VPS in a browser: users can install
packages, edit system files, build projects, and keep that state across restarts.
The runtime is still a container, so persistence depends on mounting one durable
volume at `/data`.

## Recommended VPS Setup

The closest match to the production cloud runtime is:

- a Docker-capable Linux VPS, such as Hetzner Cloud CX/CPX or DigitalOcean;
- DNS `A` and `AAAA` records pointing at the VPS;
- inbound ports `80` and `443` open;
- Docker Compose;
- Caddy in front of Composery for automatic HTTPS.

Use [hosting/caddy-compose](../hosting/caddy-compose/) for this setup.

## Deployment Targets

| Target                                | Status            | Notes                                                                                                                                                                  |
| ------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose on one VPS             | Supported         | Best default for indie/self-hosted use. Use the Caddy example for HTTPS.                                                                                               |
| Hetzner CX/CPX VPS                    | Production target | This is the production cloud target in (Composery Cloud)[https://composery.io/pricing].                                                                                                               |
| DigitalOcean Droplet or similar VPS   | Supported         | Same Compose/Caddy shape as Hetzner.                                                                                                                                   |
| Railway, Render, Fly, or similar PaaS | Supported         | Mount a writable persistent disk at `/data`, run a single instance per volume, and check `persistd status --json` after boot. Provider-specific setup is still manual. |
| Kubernetes                            | Manual            | Use one replica, a PVC mounted at `/data`, and an ingress/proxy. Do not scale one Composery instance horizontally against the same PVC.                                 |

## Provider Notes

### VPS Providers

Use [hosting/caddy-compose](../hosting/caddy-compose/) on a Droplet, Hetzner VPS,
or similar host:

1. Point DNS at the server.
2. Open inbound `80` and `443`.
3. Install Docker Compose.
4. Copy the example, edit `Caddyfile`, and run `docker compose up -d`.

This matches the runtime shape used by Composery Cloud.

### Render

Deploy the Composery image as a Docker-backed web service, attach a persistent
disk mounted at `/data`, and set `PORT=8080`.

Use the browser registration flow to create the initial password. Set `PASSWORD`
or `HASHED_PASSWORD` only if you want the password managed by environment
variables instead.

Render provides the public HTTPS edge, so do not use the Caddy example there.
Without a persistent disk mounted at `/data`, filesystem changes will not survive
redeploys.

### Railway

Deploy the Composery image, attach a Railway volume with mount path `/data`, and
route the public HTTP domain to target port `8080`.

Use the browser registration flow to create the initial password. Set `PASSWORD`
or `HASHED_PASSWORD` only if you want the password managed by environment
variables instead.

Railway volumes are mounted at runtime, so persistence should be verified after
the service starts with `persistd status --json`.

### Fly.io

Use one Machine with one volume mounted at `/data`. Fly volumes are local to the
Machine, so do not scale one Composery instance to multiple Machines unless each
Machine is treated as a separate box with its own volume.

### Kubernetes

Use a single replica, a `PersistentVolumeClaim` mounted at `/data`, and an
Ingress or Gateway for TLS. Composery is not currently a horizontally scalable
Kubernetes app because `persistd` is a single-writer daemon for one root
filesystem delta.

## code-server Environment Variables

Composery does not define `COMPOSERY_*` runtime wrappers around code-server
settings. Set code-server environment variables directly in Compose or in your
hosting provider's environment-variable UI.

Most useful for self-hosting:

| Variable                    | Use                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD`                  | Sets a plaintext code-server password and skips first-visit registration.                                                                |
| `HASHED_PASSWORD`           | Sets an argon2 hashed password and takes precedence over `PASSWORD`. Escape `$` as `$$` in Docker Compose values.                        |
| `PORT`                      | Changes code-server's listen port. Also update Caddy, `expose`, health checks, or platform routing if you change it from `8080`.         |
| `VSCODE_PROXY_URI`          | Controls links in the Ports panel, for example `https://{{port}}.dev.example.com`. The default path proxy works without setting this.    |
| `CS_DISABLE_FILE_DOWNLOADS` | Set to `1` or `true` to block browser file downloads.                                                                                    |
| `CS_DISABLE_PROXY`          | Set to `1` or `true` to disable code-server's port proxy routes.                                                                         |
| `EXTENSIONS_GALLERY`        | Points code-server at a custom VS Code Extension Gallery API using the JSON shape expected by VS Code `product.json`.                    |
| `LOG_LEVEL`                 | Sets code-server logging to `trace`, `debug`, `info`, `warn`, or `error`.                                                                |
| `GITHUB_TOKEN`              | Supplies code-server's GitHub auth token. Treat it as a secret; code-server removes it from the child-process environment after startup. |

Accepted by code-server but usually less important for Composery:

| Variable                                                 | Use                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CODE_SERVER_CONFIG`                                     | Overrides the code-server YAML config path.                                                                 |
| `CODE_SERVER_HOST`                                       | Overrides the bind host. Avoid setting this unless you understand the container networking impact.          |
| `CODE_SERVER_COOKIE_SUFFIX`                              | Adds a cookie suffix, useful when sharing a parent domain across multiple code-server instances.            |
| `CODE_SERVER_RECONNECTION_GRACE_TIME`                    | Overrides reconnection grace time in seconds.                                                               |
| `CODE_SERVER_IDLE_TIMEOUT_SECONDS`                       | Asks code-server to exit after an idle period. Supervisor currently restarts code-server, so use with care. |
| `CS_DISABLE_GETTING_STARTED_OVERRIDE`                    | Set to `1` or `true` to disable code-server's Getting Started override.                                     |
| `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` | Sets an outbound HTTP(S) proxy for code-server update and extension-related requests.                       |

## Persistence Contract

`persistd` compares the live root filesystem against an image baseline and writes
only user deltas to `/data/persistd`.

Persisted:

- regular files and directories;
- symlinks;
- hardlinks when the volume supports them;
- mode bits, ownership, and mtimes;
- xattrs, ACLs, and file capabilities where supported;
- FIFOs and device-node metadata where supported;
- package manager state under paths such as `/usr`, `/etc`, and `/var/lib/dpkg`.

Excluded by default:

- `/data`;
- `/run`, `/var/run`, `/proc`, `/sys`, `/dev`, and `/tmp`;
- `/opt/persistd` and `/opt/composery`;
- resolver and hostname files: `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`.

The active config lives at `/data/persistd/config.json`. Self-hosters may edit the
exclusion list. Invalid exclusion paths are rejected at startup.

## Operations

Useful commands inside the container:

```bash
sudo /opt/persistd/bin/persistd status
sudo /opt/persistd/bin/persistd status --json
sudo /opt/persistd/bin/persistd doctor
sudo /opt/persistd/bin/persistd prune
```

Readiness is exposed through `/run/persistd/ready` and code-server's `/healthz`
route. If `persistd apply` fails during boot, code-server does not become ready.

## Security

Composery is intentionally root-capable inside the container because it is meant to
feel like a mutable Linux system. Treat the browser password and reverse proxy as
the security boundary for self-hosted use:

- use HTTPS;
- register a strong password, or set `PASSWORD`/`HASHED_PASSWORD` for environment-managed credentials;
- keep the image updated;
- do not expose port `8080` directly when using a public Caddy/nginx/Traefik edge;
- back up the named Docker volume or the mounted `/data` disk.

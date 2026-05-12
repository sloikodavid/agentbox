# code-server customizations

## Current mode

patch-stack

## Upstream

repo: https://github.com/coder/code-server
version-source: Dockerfile `CODE_SERVER_VERSION` / `CODE_SERVER_COMMIT`
artifact-source: upstream release tarballs for now

## Local layout

- `patches/`: source patches applied to code-server or vendored VS Code.
- `overlay/`: files copied over the extracted release tree.

## Rules

- Keep auth/session/proxy mechanics in code-server.
- Keep Agentbox rootfs/runtime/supervisor behavior outside code-server.
- Replace front-facing Agentbox UI only; do not blind-replace internal names.
- Prefer overlay for static files.
- Prefer patches for source changes.
- Revisit a fork when patch stack becomes broad or gateway is collapsed.

## Patch list

| File                                   | Purpose                                                     | Upstream area      | Revisit trigger                        |
| -------------------------------------- | ----------------------------------------------------------- | ------------------ | -------------------------------------- |
| `overlay/src/browser/pages/login.html` | Minimal Agentbox login page using upstream login mechanics. | Browser login page | Login route/template changes upstream. |

## Update checklist

1. Update upstream version/checksums.
2. Apply overlay/patches.
3. Run unit tests.
4. Run smoke tests for auth, proxy, websocket, publicUrlPath, readiness.
5. If patches are broad/conflicting, revisit fork.

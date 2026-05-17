# code-server customizations

## Current mode

patch-stack

## Upstream

repo: https://github.com/coder/code-server
version-source: Dockerfile `CODE_SERVER_VERSION` / `CODE_SERVER_COMMIT`
artifact-source: upstream release tarballs for now

## Local layout

- `patches/`: source patches applied to code-server or vendored VS Code during the image build.
- `overlay/`: files copied over the extracted release tree.

## Rules

- Keep auth/session/proxy mechanics in code-server.
- Keep container runtime/supervisor behavior outside code-server.
- Replace front-facing Agentbox UI only; do not blind-replace internal names.
- Prefer overlay for static files.
- Prefer patches for source changes.
- Revisit a fork when patch stack becomes broad.

## Patch list

| File                                                                    | Purpose                                                                                                                            | Upstream area          | Revisit trigger                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `overlay/src/browser/pages/login.html`                                  | Minimal Agentbox login page using upstream login mechanics.                                                                        | Browser login page     | Login route/template changes upstream.                                           |
| `overlay/lib/vscode/out/vs/code/browser/workbench/workbench-mobile.css` | Contains the mobile workbench viewport, stable dialog width guards, narrow quick-input guards, coarse-pointer touch guards, popup bounds, and preference editor overflow handling. | VS Code workbench CSS  | Workbench part class, widget class, or bundled workbench path changes upstream.    |
| `overlay/lib/vscode/out/vs/code/browser/workbench/workbench-mobile.js`  | Keeps side bars and the panel from crowding each other, clamps panel width, forces modal editors to stay maximized with viewport-bounded shells and compact headers on mobile, lets Back dismiss VS Code overlays, releases touchpad pinch wheel events, and bridges horizontal touch or wheel drags for narrow preference SplitViews and keybindings. | VS Code workbench DOM  | Side bar, panel, transient overlay class names, modal editor class names, preference SplitView class names, keybindings table class names, or browser wheel routing changes upstream. |
| `patches/0001-gate-code-server-on-persistd-readiness.patch`             | Extends `/healthz` with persistd readiness and serves the startup page until persistd is ready.                                    | Node routes            | Health route or route registration changes upstream.                             |
| `patches/0002-load-workbench-mobile.patch`                              | Loads the Agentbox mobile workbench stylesheet and script from the VS Code workbench page.                                        | VS Code workbench HTML | Workbench HTML template path or asset loading changes upstream.                   |

## Update checklist

1. Update upstream version/checksums.
2. Apply overlay/patches.
3. Run unit tests.
4. Run smoke tests for auth, proxy, websocket, and persistd readiness.
5. If patches are broad/conflicting, revisit fork.

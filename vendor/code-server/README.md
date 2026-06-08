# code-server customizations

## Current mode

patch-stack

## Upstream

repo: https://github.com/coder/code-server
version-source: Dockerfile `CODE_SERVER_VERSION` / `CODE_SERVER_COMMIT`
artifact-source: source build during Docker image build

## Local layout

- `patches/`: code-server source diffs appended to code-server's own quilt stack before the standalone release build; ordered by `patches/series`.
- `overlay/`: files copied over the built release tree.

## Patch ordering

Keep `patches/series`. Quilt uses it as the canonical patch order, and it makes ordering explicit even when filenames are descriptive instead of numbered.

Patch filenames should stay short and descriptive. Add new diffs to `series` in the order they must apply.

## Rules

- Keep auth/session/proxy mechanics in code-server.
- Keep container runtime/supervisor behavior outside code-server.
- Replace front-facing Composery UI only; do not blind-replace internal names.
- Prefer overlay for static files.
- Prefer patches for source changes.
- Revisit a fork when patch stack becomes broad.

## Patch list

| File                                                                    | Purpose                                                                                                                            | Upstream area          | Revisit trigger                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `overlay/src/browser/pages/login.html`                                  | Minimal Composery login page using upstream login mechanics and password-manager-compatible fields.                                 | Browser login page     | Login route/template changes upstream.                                           |
| `overlay/src/browser/pages/register.html`                               | Minimal first-run password creation page for unmanaged password-auth installs.                                                     | Browser auth pages     | Password setup route/template changes.                                           |
| `overlay/src/browser/pages/reset-password.html`                         | Minimal authenticated password reset page for config-managed password-auth installs.                                               | Browser auth pages     | Password reset route/template changes.                                           |
| `overlay/src/browser/pages/auth.js`                                      | Shared auth-page behavior for hidden return URL fields, initial input-state sync, Monaco-style focus state, and Enter submission. | Browser auth pages     | Auth markup or class changes upstream.                            |
| `overlay/src/browser/pages/login.css`                                   | Shared auth page layout, Monaco input/button styling, stable error row, and accessibility-only hiding for autocomplete username fields. | Browser auth pages     | Auth markup or class changes upstream.                                           |
| `overlay/src/browser/pages/global.css`                                  | Shared black-and-white browser page baseline using system colors and default controls.                                             | Browser pages          | Browser page template or shared page class changes upstream.                      |
| `overlay/src/browser/pages/error.html`                                  | Minimal Composery error page using upstream error route mechanics.                                                                  | Browser error page     | Error route/template changes upstream.                                           |
| `overlay/src/browser/pages/error.css`                                   | Plain centered error page alignment.                                                                                                | Browser error page     | Error markup or class changes upstream.                                          |
| `overlay/lib/vscode/out/vs/code/browser/workbench/workbench-mobile.css` | Contains the mobile workbench viewport, stable dialog width guards, narrow quick-input guards, coarse-pointer touch guards, popup bounds, and preference editor overflow handling. | VS Code workbench CSS  | Workbench part class, widget class, or bundled workbench path changes upstream.    |
| `overlay/lib/vscode/out/vs/code/browser/workbench/workbench-mobile.js`  | Keeps side bars and the panel from crowding each other, clamps panel width, forces modal editors to stay maximized with viewport-bounded shells and compact headers on mobile, lets Back dismiss VS Code overlays, releases touchpad pinch wheel events, and bridges horizontal touch or wheel drags for narrow preference SplitViews and keybindings. | VS Code workbench DOM  | Side bar, panel, transient overlay class names, modal editor class names, preference SplitView class names, keybindings table class names, or browser wheel routing changes upstream. |
| `patches/auth-flow.diff`                                                | Adds first-run registration, reset-password routes, login error redirects, and the race-safe first-claim flow for password auth. | Node auth source       | Login routing, config auth, or password lifecycle changes upstream.               |
| `patches/no-generated-password.diff`                                    | Stops generating a default password in the config bootstrap so first-run setup can happen through the browser flow. | Node config bootstrap  | Default config generation or password bootstrap behavior changes upstream.         |
| `patches/persistd-readiness.diff`                                       | Gates the app on persistd readiness, extends `/healthz`, and serves a minimal neutral startup page until the workspace is ready. | Node readiness source  | Health route or request gating changes upstream.                                  |
| `patches/browser-friendly-url.diff`                                     | Reuses code-server's browser-address normalization to log the access URL cleanly on startup. | Node startup source    | Startup logging or browser open address handling changes upstream.                 |
| `patches/workbench-auth-actions.diff`                                   | Adds Reset Password alongside the existing Sign Out seam and keeps the workbench auth navigation path consistent. | VS Code/web source     | CodeServerClient, product config generation, or auth command integration changes upstream. |
| `patches/markdown-preview-loopback-callback-bridge.diff`                           | Routes only suspicious Markdown preview HTTP(S) links with explicit loopback callback targets back through VS Code's opener path and makes that preview-side handoff null-safe so the trusted-domains guard can warn instead of letting the webview bypass or crash. | Markdown preview webview | Markdown preview link handling, `openLink` messaging, preview link resolution, or preview bundle paths change upstream. |
| `patches/trusted-domains-loopback-callback-guard.diff`                  | Intercepts external HTTP(S) links whose explicit callback or redirect targets point at loopback addresses inside the trusted-domains validator, shows a sticky native warning toast with Open Anyway / Copy actions, and avoids sending browser-only workspaces into broken localhost OAuth flows. | VS Code/web source     | Trusted-domains validation, notification prompts, or external link policy changes upstream. |
| `patches/workbench-cache.diff`                                          | Revalidates workbench assets instead of serving them as effectively immutable and forces service-worker updates to bypass the browser cache. | VS Code/web source     | Static asset cache policy or service-worker registration changes upstream.         |
| `patches/workbench-mobile.diff`                                         | Loads the mobile workbench stylesheet and script from the workbench HTML entrypoint. | VS Code workbench HTML | Workbench HTML template path or asset loading changes upstream.                   |

## Update checklist

1. Update upstream version/commit.
2. Apply overlay/patches.
3. Run unit tests.
4. Run smoke tests for auth, proxy, websocket, and persistd readiness.
5. If patches are broad/conflicting, revisit fork.

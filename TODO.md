# To-do

## Short-term

`Agentbox is starting` proceeding to the next step when done, so user doesn't have to manually refresh.

Ensure versions in the Dockerfile are stable, and renovate is properly set up to respect that stability.

## Long-term

- Mirror the exact upstream release tarballs used by `Dockerfile` in a project-controlled location, such as an Agentbox GitHub release or GHCR artifact:
  - `code-server-<version>-linux-amd64.tar.gz`.
  - `code-server-<version>-linux-arm64.tar.gz`.
- Add CI automation to mirror new code-server assets after Renovate opens or merges a code-server update?

- Add shortcuts.

- Figure out auth and proxy/network configuration that allows for webhooks.
  - Image responsibility:
    - one public ingress on PORT.
    - auth/session boundary.
    - configure code-server's built-in port proxy for local services.
    - preserve host headers so code-server proxy domains work.
    - keep health, metrics, and future API under AGENTBOX_BASE_PATH.
  - Cloud hosted offering responsibility:
    - easy domains and TLS.
    - wildcard DNS/TLS for AGENTBOX_PORT_TEMPLATE_URL.
    - nicer identity/access UX.
    - relay/tunnel behavior.
    - zero-ops port URL onboarding.

- UI mobile support.

- Figure out the API including Shortcuts.
  - Copy URL button for shortcuts - uses a Webhook for command shortcuts and passes payload.

- File/folder/workspace/shortcut sharing?

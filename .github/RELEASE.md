# Release

Agentbox releases are Docker image releases published to GHCR.

GitHub always shows a **Use workflow from** dropdown when manually running a workflow. Leave it set to `main`. That dropdown chooses which branch's workflow file to run.

The workflow has one input: `ref`.

- `ref: main` creates a stable release.
- Any other `ref` creates a preview release.

A ref can be a branch name, tag, or commit SHA. For a branch, use the branch name, for example `fix/docker-startup`. For an exact commit, use the commit SHA, for example `3c5677d5ec6d1aaf77c8644a2997693a8aeffb9a`.

## Preview release

Preview releases are for testing a branch or exact commit without publishing `latest` or creating a GitHub Release.

1. Go to **Actions** -> **release** -> **Run workflow**.
2. Leave **Use workflow from** set to `main`.
3. Set `ref` to the branch, tag, or commit SHA to build.

A preview release publishes:

- `ghcr.io/sloikodavid/agentbox:preview-<ref>`.
- `ghcr.io/sloikodavid/agentbox:sha-<short-sha>`.

The `preview-<ref>` tag is mutable: running another preview release for the same branch overwrites it. The `sha-<short-sha>` tag points to the exact commit that was built.

Preview releases may be public if the GHCR package is public. Do not publish secrets or sensitive code in preview builds.

## Stable release

The package version is the release source of truth.

1. Open a PR that updates `package.json` to the new version, for example `0.1.0`.
2. Merge the PR to `main` after CI is green.
3. Go to **Actions** -> **release** -> **Run workflow**.
4. Leave **Use workflow from** set to `main`.
5. Leave `ref` as `main`.

The workflow verifies that it is building the current `main`, reads `package.json.version`, publishes the image, scans it, and creates the GitHub Release tag `v<version>`.

A stable release publishes:

- `ghcr.io/sloikodavid/agentbox:<version>`.
- `ghcr.io/sloikodavid/agentbox:<major>.<minor>`.
- `ghcr.io/sloikodavid/agentbox:latest`.
- `ghcr.io/sloikodavid/agentbox:sha-<short-sha>`.

Release images are scanned with Trivy and fail on `CRITICAL` or `HIGH` vulnerabilities.

Do not create GitHub Releases or `v*` tags manually. The release workflow owns stable release tags.

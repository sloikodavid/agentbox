# Node major is pinned by code-server (engines + VS Code remote/.npmrc target), whose
# native modules are built for this ABI. The builder and runtime must share it, so it
# lives in one ARG; bump both together when code-server moves to a new Node major.
ARG NODE_IMAGE=node:22-trixie-slim@sha256:e637ac91fb4f2f40761d217c5d48c41a05edf0b65eb9c34e72c27cce55af9e65

# Build patched code-server from source.
FROM ${NODE_IMAGE} AS code-server-builder

# renovate: datasource=custom.code-server-tags depName=coder/code-server versioning=semver
ARG CODE_SERVER_VERSION=4.118.0
ARG CODE_SERVER_COMMIT=871f1d904834ee78db1c4585e2f14f65c119374a
ARG CODE_SERVER_REPOSITORY=https://github.com/coder/code-server.git

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    git-lfs \
    jq \
    libkrb5-dev \
    libsecret-1-dev \
    libx11-dev \
    libxkbfile-dev \
    patch \
    pkg-config \
    python-is-python3 \
    quilt \
    rsync \
    unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src/code-server

# Fetch code-server and VS Code.
RUN git clone --branch "v${CODE_SERVER_VERSION}" --depth 1 "${CODE_SERVER_REPOSITORY}" . \
  && test "$(git rev-parse HEAD)" = "${CODE_SERVER_COMMIT}" \
  && git submodule update --init --depth 1

# Install dependencies before local diffs so patch-only changes keep this layer cached.
RUN npm ci

# Add local code-server source diffs before building the standalone release.
COPY vendor/code-server/patches/ /tmp/code-server-patches/
RUN while IFS= read -r patch_name || [ -n "${patch_name}" ]; do \
    case "${patch_name}" in ""|\#*) continue ;; esac; \
    cp "/tmp/code-server-patches/${patch_name}" "patches/${patch_name}"; \
    printf '%s\n' "${patch_name}" >> patches/series; \
  done < /tmp/code-server-patches/series \
  && quilt push -a \
  && rm -rf /tmp/code-server-patches

# Build the standalone release.
RUN npm run build \
  && VERSION="${CODE_SERVER_VERSION}" npm run build:vscode \
  && KEEP_MODULES=1 npm run release

# Overlay Agentbox browser assets onto the built release.
COPY vendor/code-server/overlay/ /src/code-server/release/
RUN XDG_CONFIG_HOME=/tmp/code-server-config /src/code-server/release/bin/code-server --version --json > /tmp/code-server.version.json \
  && node -e 'const fs = require("node:fs"); const line = fs.readFileSync("/tmp/code-server.version.json", "utf8").split(/\n/).find((entry) => entry.trim().startsWith("{")); if (!line) { throw new Error("code-server version JSON was not found"); } const actual = JSON.parse(line); if (actual.codeServer !== process.argv[1] || actual.commit !== process.argv[2]) { throw new Error(`code-server version mismatch: ${JSON.stringify(actual)}`); }' \
    "${CODE_SERVER_VERSION}" \
    "${CODE_SERVER_COMMIT}" \
  && printf 'version=%s\ncommit=%s\nsource=%s\n' \
    "${CODE_SERVER_VERSION}" \
    "${CODE_SERVER_COMMIT}" \
    "${CODE_SERVER_REPOSITORY}" \
    > /src/code-server/release/.agentbox-upstream \
  && rm -rf /tmp/code-server.version.json /tmp/code-server-config

# Build persistd. cargo-chef caches the dependency compile so source-only edits skip it.
FROM rust:1.96.0-slim-trixie@sha256:26abcef3d79b8d890c4ceb17093154573e1f6479cf6dd7c1450043b8458350f6 AS persistd-chef
# renovate: datasource=crate depName=cargo-chef
ARG CARGO_CHEF_VERSION=0.1.77
RUN cargo install cargo-chef --version "${CARGO_CHEF_VERSION}" --locked
WORKDIR /src/persistd

FROM persistd-chef AS persistd-planner
COPY packages/persistd/ .
RUN cargo chef prepare --recipe-path /recipe.json

FROM persistd-chef AS persistd-builder
COPY --from=persistd-planner /recipe.json /recipe.json
RUN cargo chef cook --release --recipe-path /recipe.json
COPY packages/persistd/ .
RUN cargo build --release --locked --bin persistd \
  && install -D target/release/persistd /out/persistd

# Assemble the runtime image.
FROM ${NODE_IMAGE} AS runtime

ARG AGENTBOX_BUILD_VERSION=unknown
ARG AGENTBOX_BUILD_REVISION=unknown
ARG AGENTBOX_BUILD_SOURCE=https://github.com/sloikodavid/agentbox

LABEL org.opencontainers.image.title="Agentbox" \
  org.opencontainers.image.description="A persistent VPS-like Linux appliance with code-server in the browser." \
  org.opencontainers.image.source="${AGENTBOX_BUILD_SOURCE}" \
  org.opencontainers.image.revision="${AGENTBOX_BUILD_REVISION}" \
  org.opencontainers.image.version="${AGENTBOX_BUILD_VERSION}" \
  org.opencontainers.image.licenses="Apache-2.0"

# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.3.13
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=11.0.9

ENV AGENTBOX_BUILD_VERSION="${AGENTBOX_BUILD_VERSION}" \
  AGENTBOX_BUILD_REVISION="${AGENTBOX_BUILD_REVISION}" \
  AGENTBOX_BUILD_SOURCE="${AGENTBOX_BUILD_SOURCE}" \
  BROWSER="/opt/code-server/current/lib/vscode/bin/helpers/browser.sh" \
  EDITOR="code --wait" \
  GIT_EDITOR="code --wait" \
  KUBE_EDITOR="code --wait" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  VISUAL="code --wait"

# APT lists are kept (not deleted) so `sudo apt install` works out of the box in this
# VPS-like appliance; `apt update` refreshes them, and persistd persists any changes.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    desktop-file-utils \
    git \
    jq \
    less \
    libfile-mimeinfo-perl \
    mailcap \
    nano \
    openssh-client \
    procps \
    python3 \
    ripgrep \
    shared-mime-info \
    sudo \
    supervisor \
    tar \
    unzip \
    vim-tiny \
    wget \
    xdg-user-dirs \
    xdg-utils \
    xz-utils \
    zip

RUN npm install --global \
    "bun@${BUN_VERSION}" \
    "pnpm@${PNPM_VERSION}" \
  && npm cache clean --force

RUN groupmod --new-name user node \
  && usermod --login user --home /home/user --move-home node \
  && mkdir -p /home/user

COPY --from=code-server-builder /src/code-server/release /opt/code-server/current
COPY --from=persistd-builder /out/persistd /opt/persistd/bin/persistd
COPY rootfs/ /

RUN find /home/user -name .gitkeep -type f -delete \
  && mkdir -p /data \
  && chown -R user:user /home/user \
  && chmod 0440 /etc/sudoers.d/user \
  && chmod +x /opt/agentbox/entrypoint.sh \
  && chmod +x /opt/agentbox/code-server.sh \
  && ln -sf /opt/code-server/current/lib/vscode/bin/remote-cli/code-server /usr/local/bin/code \
  && ln -sf /opt/code-server/current/bin/code-server /usr/local/bin/code-server \
  && update-desktop-database /usr/share/applications \
  && update-mime-database /usr/share/mime \
  && /opt/persistd/bin/persistd __generate-baseline --root / --output /opt/persistd/baseline.sqlite

# No USER directive: persistd needs root to rebuild the filesystem on boot; supervisor
# drops to the unprivileged `user` for code-server. Root is intentional.
EXPOSE 8080

# Liveness against code-server's auth-exempt /healthz; ${PORT:-8080} follows a PORT override.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-8080}/healthz" > /dev/null || exit 1

ENTRYPOINT ["/opt/agentbox/entrypoint.sh"]

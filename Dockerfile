# Build patched code-server from source.
FROM node:22-trixie-slim@sha256:e637ac91fb4f2f40761d217c5d48c41a05edf0b65eb9c34e72c27cce55af9e65 AS code-server-builder

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

# Build persistd.
FROM rust:1.95.0-trixie AS persistd-builder

WORKDIR /src

COPY packages/persistd/ packages/persistd/

RUN cargo build --release --locked --manifest-path packages/persistd/Cargo.toml --bins \
  && mkdir -p /out \
  && cp packages/persistd/target/release/persistd /out/persistd \
  && cp packages/persistd/target/release/persistd-baseline /out/persistd-baseline

# Assemble the runtime image.
FROM node:26.1.0-trixie-slim@sha256:424cafd2a035ed2b2d74acc3142b68b426fb62a47742c80a75e7117db02d6b30 AS runtime

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
  EDITOR="code --wait" \
  GIT_EDITOR="code --wait" \
  KUBE_EDITOR="code --wait" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  VISUAL="code --wait"

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
    rsync \
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
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
    "bun@${BUN_VERSION}" \
    "pnpm@${PNPM_VERSION}" \
  && npm cache clean --force

RUN groupmod --new-name user node \
  && usermod --login user --home /home/user --move-home node \
  && mkdir -p /home/user

COPY --from=code-server-builder /src/code-server/release /opt/code-server/current
COPY --from=persistd-builder /out/persistd /opt/persistd/bin/persistd
COPY --from=persistd-builder /out/persistd-baseline /opt/persistd/bin/persistd-baseline
COPY rootfs/ /

RUN find / -xdev -name .gitkeep -type f -delete \
  && mkdir -p /data \
  && mkdir -p /opt/persistd \
  && chown -R user:user /home/user \
  && chmod 0440 /etc/sudoers.d/user \
  && chmod +x /opt/agentbox/entrypoint.sh \
  && chmod +x /opt/agentbox/code-server.sh \
  && ln -sf /opt/code-server/current/lib/vscode/bin/remote-cli/code-server /usr/local/bin/code \
  && ln -sf /opt/code-server/current/bin/code-server /usr/local/bin/code-server \
  && update-desktop-database /usr/share/applications \
  && update-mime-database /usr/share/mime \
  && /opt/persistd/bin/persistd-baseline --root / --output /opt/persistd/baseline.sqlite \
  && rm -f /opt/persistd/bin/persistd-baseline

EXPOSE 8080
ENTRYPOINT ["/opt/agentbox/entrypoint.sh"]

FROM node:26.1.0-trixie-slim@sha256:424cafd2a035ed2b2d74acc3142b68b426fb62a47742c80a75e7117db02d6b30 AS code-server-installer

# renovate: datasource=custom.code-server-tags depName=coder/code-server versioning=semver
ARG CODE_SERVER_VERSION=4.118.0
ARG CODE_SERVER_COMMIT=871f1d904834ee78db1c4585e2f14f65c119374a
ARG CODE_SERVER_DOWNLOAD_BASE=https://github.com/coder/code-server/releases/download
# renovate: datasource=custom.code-server-linux-amd64 depName=code-server-linux-amd64 versioning=semver
# code-server-linux-amd64 version=4.118.0
ARG CODE_SERVER_SHA256_AMD64=ab4dee01cacc20eb500c96660477d8ba755f69f402cc9cbab3a8496b4690f2fd
# renovate: datasource=custom.code-server-linux-arm64 depName=code-server-linux-arm64 versioning=semver
# code-server-linux-arm64 version=4.118.0
ARG CODE_SERVER_SHA256_ARM64=70dd29a9bffa1ca7a9578e24106e612ee041192bf6aa5ece964b1af1e3d27c08
ARG DEBIAN_SNAPSHOT=20260510T000000Z
ARG TARGETARCH

# renovate: suite=trixie depName=ca-certificates
ARG CODE_SERVER_INSTALLER_CA_CERTIFICATES_VERSION=20250419
# renovate: suite=trixie depName=curl
ARG CODE_SERVER_INSTALLER_CURL_VERSION=8.14.1-2+deb13u2

RUN printf '%s\n' \
    'Types: deb' \
    "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/" \
    'Suites: trixie trixie-updates' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    '' \
    'Types: deb' \
    "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/" \
    'Suites: trixie-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    > /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates="${CODE_SERVER_INSTALLER_CA_CERTIFICATES_VERSION}" \
    curl="${CODE_SERVER_INSTALLER_CURL_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
    amd64) code_server_arch="amd64"; code_server_sha256="${CODE_SERVER_SHA256_AMD64}" ;; \
    arm64) code_server_arch="arm64"; code_server_sha256="${CODE_SERVER_SHA256_ARM64}" ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL \
    -o /tmp/code-server.tar.gz \
    "${CODE_SERVER_DOWNLOAD_BASE}/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${code_server_arch}.tar.gz" \
  && printf '%s  %s\n' "${code_server_sha256}" /tmp/code-server.tar.gz | sha256sum -c - \
  && mkdir -p /opt/code-server/current \
  && tar -xzf /tmp/code-server.tar.gz --strip-components=1 -C /opt/code-server/current \
  && printf 'version=%s\ncommit=%s\narch=%s\nsha256=%s\n' \
    "${CODE_SERVER_VERSION}" \
    "${CODE_SERVER_COMMIT}" \
    "${code_server_arch}" \
    "${code_server_sha256}" \
    > /opt/code-server/current/.agentbox-upstream \
  && rm /tmp/code-server.tar.gz

FROM node:26.1.0-trixie-slim@sha256:424cafd2a035ed2b2d74acc3142b68b426fb62a47742c80a75e7117db02d6b30 AS runtime

ARG AGENTBOX_BUILD_VERSION=unknown
ARG AGENTBOX_BUILD_REVISION=unknown
ARG AGENTBOX_BUILD_SOURCE=https://github.com/sloikodavid/agentbox
ARG DEBIAN_SNAPSHOT=20260510T000000Z

LABEL org.opencontainers.image.title="Agentbox" \
  org.opencontainers.image.description="A persistent VPS-like Linux appliance with code-server in the browser." \
  org.opencontainers.image.source="${AGENTBOX_BUILD_SOURCE}" \
  org.opencontainers.image.revision="${AGENTBOX_BUILD_REVISION}" \
  org.opencontainers.image.version="${AGENTBOX_BUILD_VERSION}" \
  org.opencontainers.image.licenses="Apache-2.0"

# renovate: suite=trixie depName=bash
ARG BASH_VERSION=5.2.37-2+b8
# renovate: datasource=npm depName=bun
ARG BUN_VERSION=1.3.13
# renovate: suite=trixie depName=ca-certificates
ARG CA_CERTIFICATES_VERSION=20250419
# renovate: suite=trixie depName=curl
ARG CURL_VERSION=8.14.1-2+deb13u2
# renovate: suite=trixie depName=desktop-file-utils
ARG DESKTOP_FILE_UTILS_VERSION=0.28-1
# renovate: suite=trixie depName=git
ARG RUNTIME_GIT_VERSION=1:2.47.3-0+deb13u1
# renovate: suite=trixie depName=jq
ARG JQ_VERSION=1.7.1-6+deb13u1
# renovate: suite=trixie depName=less
ARG LESS_VERSION=668-1
# renovate: suite=trixie depName=libfile-mimeinfo-perl
ARG LIBFILE_MIMEINFO_PERL_VERSION=0.35-1
# renovate: suite=trixie depName=mailcap
ARG MAILCAP_VERSION=3.74
# renovate: suite=trixie depName=nano
ARG NANO_VERSION=8.4-1
# renovate: suite=trixie depName=openssh-client
ARG OPENSSH_CLIENT_VERSION=1:10.0p1-7+deb13u2
# renovate: suite=trixie depName=procps
ARG PROCPS_VERSION=2:4.0.4-9
# renovate: suite=trixie depName=python3
ARG PYTHON3_VERSION=3.13.5-1
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=11.0.9
# renovate: suite=trixie depName=ripgrep
ARG RIPGREP_VERSION=14.1.1-1+b4
# renovate: suite=trixie depName=rsync
ARG RUNTIME_RSYNC_VERSION=3.4.1+ds1-5+deb13u1
# renovate: suite=trixie depName=shared-mime-info
ARG SHARED_MIME_INFO_VERSION=2.4-5+b2
# renovate: suite=trixie depName=sudo
ARG SUDO_VERSION=1.9.16p2-3+deb13u1
# renovate: suite=trixie depName=supervisor
ARG SUPERVISOR_VERSION=4.2.5-3
# renovate: suite=trixie depName=tar
ARG TAR_VERSION=1.35+dfsg-3.1
# renovate: suite=trixie depName=unzip
ARG UNZIP_VERSION=6.0-29
# renovate: suite=trixie depName=vim-tiny
ARG VIM_TINY_VERSION=2:9.1.1230-2
# renovate: suite=trixie depName=wget
ARG WGET_VERSION=1.25.0-2
# renovate: suite=trixie depName=xdg-user-dirs
ARG XDG_USER_DIRS_VERSION=0.18-2
# renovate: suite=trixie depName=xdg-utils
ARG XDG_UTILS_VERSION=1.2.1-2
# renovate: suite=trixie depName=xz-utils
ARG XZ_UTILS_VERSION=5.8.1-1
# renovate: suite=trixie depName=zip
ARG ZIP_VERSION=3.0-15

ENV AGENTBOX_BUILD_VERSION="${AGENTBOX_BUILD_VERSION}" \
  AGENTBOX_BUILD_REVISION="${AGENTBOX_BUILD_REVISION}" \
  AGENTBOX_BUILD_SOURCE="${AGENTBOX_BUILD_SOURCE}" \
  EDITOR="code --wait" \
  GIT_EDITOR="code --wait" \
  KUBE_EDITOR="code --wait" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  VISUAL="code --wait"

RUN printf '%s\n' \
    'Types: deb' \
    "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/" \
    'Suites: trixie trixie-updates' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    '' \
    'Types: deb' \
    "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/" \
    'Suites: trixie-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    > /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash="${BASH_VERSION}" \
    ca-certificates="${CA_CERTIFICATES_VERSION}" \
    curl="${CURL_VERSION}" \
    desktop-file-utils="${DESKTOP_FILE_UTILS_VERSION}" \
    git="${RUNTIME_GIT_VERSION}" \
    jq="${JQ_VERSION}" \
    less="${LESS_VERSION}" \
    libfile-mimeinfo-perl="${LIBFILE_MIMEINFO_PERL_VERSION}" \
    mailcap="${MAILCAP_VERSION}" \
    nano="${NANO_VERSION}" \
    openssh-client="${OPENSSH_CLIENT_VERSION}" \
    procps="${PROCPS_VERSION}" \
    python3="${PYTHON3_VERSION}" \
    ripgrep="${RIPGREP_VERSION}" \
    rsync="${RUNTIME_RSYNC_VERSION}" \
    shared-mime-info="${SHARED_MIME_INFO_VERSION}" \
    sudo="${SUDO_VERSION}" \
    supervisor="${SUPERVISOR_VERSION}" \
    tar="${TAR_VERSION}" \
    unzip="${UNZIP_VERSION}" \
    vim-tiny="${VIM_TINY_VERSION}" \
    wget="${WGET_VERSION}" \
    xdg-user-dirs="${XDG_USER_DIRS_VERSION}" \
    xdg-utils="${XDG_UTILS_VERSION}" \
    xz-utils="${XZ_UTILS_VERSION}" \
    zip="${ZIP_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
    "bun@${BUN_VERSION}" \
    "pnpm@${PNPM_VERSION}" \
  && npm cache clean --force

RUN groupmod --new-name user node \
  && usermod --login user --home /home/user --move-home node \
  && mkdir -p /home/user

COPY --from=code-server-installer /opt/code-server/current /opt/code-server/current
COPY rootfs/ /

RUN find / -xdev -name .gitkeep -type f -delete \
  && mkdir -p /data \
  && chown -R user:user /home/user \
  && chmod 0440 /etc/sudoers.d/user \
  && chmod +x /opt/agentbox/services/entrypoint.sh /opt/agentbox/services/code-server.sh \
  && ln -sf /opt/code-server/current/lib/vscode/bin/remote-cli/code-server /usr/local/bin/code \
  && ln -sf /opt/code-server/current/bin/code-server /usr/local/bin/code-server \
  && update-desktop-database /usr/share/applications \
  && update-mime-database /usr/share/mime

EXPOSE 8080
ENTRYPOINT ["/opt/agentbox/services/entrypoint.sh"]

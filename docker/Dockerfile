# GHOST Protocol agent, one Linux image for Linux, macOS and Windows (Docker Desktop).
# Build from the repo root:  docker build -f docker/Dockerfile -t ghost-protocol:dev .

# --- stage 1: build buzz-mcp from the pinned block/buzz-app commit ---
FROM node:22-bookworm-slim AS buzzmcp
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY adapters/buzz/buzz-mcp.pin adapters/buzz/scripts/build-buzz-mcp.sh /src/adapters/buzz/
RUN mkdir -p /src/adapters/buzz/scripts && mv /src/adapters/buzz/build-buzz-mcp.sh /src/adapters/buzz/scripts/ \
    && corepack enable \
    && BUZZ_MCP_CACHE=/out sh /src/adapters/buzz/scripts/build-buzz-mcp.sh \
    && rm -rf /out/buzz-app /out/pnpm-store

# --- stage 2: the runtime ---
FROM node:22-bookworm-slim
ARG GP_IMAGE_VERSION=dev
# The repository the release pushes this image to (for example
# ghcr.io/<owner>/ghost-protocol): the agent looks there for newer releases.
# Empty in a build of one's own: no release check.
ARG GP_IMAGE_REPO=""
LABEL org.opencontainers.image.title="ghost-protocol" \
      org.opencontainers.image.version="${GP_IMAGE_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash git python3 jq tmux ca-certificates curl procps tini \
    && rm -rf /var/lib/apt/lists/*
# Claude Code: the native build pinned in install/pins.env, checked against its
# sha256 by the installer's own script, outside the data volume (so a new image
# brings its own). The image pins it; an update is a new image tag.
COPY install/pins.env install/install-claude-code.sh /tmp/cc/install/
COPY install/lib/common.sh /tmp/cc/install/lib/
RUN mkdir -p /opt/claude && HOME=/opt/claude bash /tmp/cc/install/install-claude-code.sh --profile vm \
    && ln -s "$(readlink -f /opt/claude/.local/bin/claude)" /usr/local/bin/claude \
    && rm -rf /tmp/cc
# The plugin, read straight from this folder (a directory marketplace).
COPY . /opt/ghost-protocol
RUN cd /opt/ghost-protocol/adapters/buzz && npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && rm -rf /opt/ghost-protocol/.git /opt/ghost-protocol/docker
COPY --from=buzzmcp /out/ /opt/buzz-mcp/
# gp, the image's commands (docker/gp/), with the adapter's dependencies.
COPY docker/gp /opt/gp
RUN ln -s /opt/ghost-protocol/adapters/buzz/node_modules /opt/gp/node_modules \
    && chmod 755 /opt/gp/gp.mjs /opt/gp/gp && ln -s /opt/gp/gp /usr/local/bin/gp
COPY docker/managed-settings.json /etc/claude-code/managed-settings.json
COPY docker/entrypoint.sh /usr/local/bin/gp-entrypoint
RUN chmod 755 /usr/local/bin/gp-entrypoint && echo "${GP_IMAGE_VERSION}" > /etc/gp-image-version \
    && mkdir -p /data && chown node:node /data
# The image pins Claude Code; an update is a new image tag, so no self-update.
# What install/service/start reads, so that docker exec (start --fresh, say)
# sees what the agent's own start sees.
ENV HOME=/data BUZZ_MCP_CACHE=/opt/buzz-mcp GP_ROOT=/opt/ghost-protocol DISABLE_AUTOUPDATER=1 \
    GP_IMAGE_VERSION=${GP_IMAGE_VERSION} GP_IMAGE_REPO=${GP_IMAGE_REPO} GP_CLAUDE=/usr/local/bin/claude GP_PERSONA=/data/.gp/persona.md BUZZ_STATE_DIR=/data/.gp/buzz GP_REMOTE_CONTROL=off
# The image's user is root, for the update helper alone (gp updater), which
# must reach the Docker socket under every Docker. Everything else, the agent
# and every gp command (also under docker exec), runs as node: the entrypoint
# and the gp wrapper drop to it first.
USER root
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gp-entrypoint"]
CMD ["agent"]

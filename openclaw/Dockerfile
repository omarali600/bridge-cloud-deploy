FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Install Bun (for gbrain) + OpenClaw + gbrain
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v1.3.10" \
 && mv /root/.bun /usr/local/.bun \
 && ln -sf /usr/local/.bun/bin/bun /usr/local/bin/bun
RUN npm install -g openclaw
RUN bun install -g github:garrytan/gbrain

# Render mounts persistent disk at /opt/data
# Bootstrap workspaces + agent dirs from image into disk on first start (idempotent)
COPY workspace /opt/data-seed/workspace
COPY workspace-beatrix /opt/data-seed/workspace-beatrix
COPY workspace-basil /opt/data-seed/workspace-basil
COPY workspace-benson /opt/data-seed/workspace-benson
COPY workspace-clem /opt/data-seed/workspace-clem
COPY agents /opt/data-seed/agents
COPY openclaw.json /opt/data-seed/openclaw.json

# Entrypoint: seed disk if empty, then run OpenClaw
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV OPENCLAW_STATE_DIR=/opt/data
ENV OPENCLAW_CONFIG_PATH=/opt/data/openclaw.json
ENV GBRAIN_DISABLE_DIRECT_POOL=1

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]

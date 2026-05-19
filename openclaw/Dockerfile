FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git unzip python3 \
 && rm -rf /var/lib/apt/lists/*

# Install Bun (for gbrain) — system-wide
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v1.3.10" \
 && mv /root/.bun /usr/local/.bun \
 && ln -sf /usr/local/.bun/bin/bun /usr/local/bin/bun

# Install OpenClaw (Node) and gbrain (Bun)
RUN npm install -g openclaw
RUN bun install -g github:garrytan/gbrain
RUN ln -sf /usr/local/.bun/install/global/node_modules/gbrain/src/cli.ts /usr/local/bin/gbrain || true

# Seed bundled state (entrypoint copies to /opt/data on first boot)
COPY workspace /opt/data-seed/workspace
COPY workspace-beatrix /opt/data-seed/workspace-beatrix
COPY workspace-basil /opt/data-seed/workspace-basil
COPY workspace-benson /opt/data-seed/workspace-benson
COPY workspace-clem /opt/data-seed/workspace-clem
COPY agents /opt/data-seed/agents
COPY openclaw.json /opt/data-seed/openclaw.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV OPENCLAW_STATE_DIR=/opt/data
ENV OPENCLAW_CONFIG_PATH=/opt/data/openclaw.json
ENV GBRAIN_DISABLE_DIRECT_POOL=1
ENV PATH=/usr/local/.bun/bin:$PATH

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]

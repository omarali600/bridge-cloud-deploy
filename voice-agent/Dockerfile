FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git unzip python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Bun + gbrain (same pattern as bridge-openclaw — gbrain CLI is
# invoked from the voice agent for brain reads + write-after-call).
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v1.3.10" \
 && mv /root/.bun /usr/local/.bun \
 && ln -sf /usr/local/.bun/bin/bun /usr/local/bin/bun
RUN bun install -g github:garrytan/gbrain \
 && ln -sf /usr/local/.bun/install/global/node_modules/gbrain/src/cli.ts /usr/local/bin/gbrain || true

# Voice agent deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --production

COPY server.mjs ./

# Voice agent listens on this port; Render's external URL maps to it.
ENV VOICE_AGENT_PORT=8080
ENV VOICE_AGENT_HOST=0.0.0.0
ENV VOICE_AGENT_LOG_DIR=/opt/data/logs
ENV GBRAIN_BIN=gbrain
ENV PATH=/usr/local/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH

EXPOSE 8080
CMD ["node", "server.mjs"]

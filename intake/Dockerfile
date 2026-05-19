FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# OpenClaw pinned to match the gateway version used by bridge-openclaw so the
# WS protocol negotiates cleanly when intake invokes Beatrix/Clem sessions.
RUN npm install -g openclaw@2026.4.12

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --production

COPY src ./src
COPY test ./test

ENV STATE_DIR=/opt/data
ENV OPENCLAW_PROFILE_DIR=/opt/data
ENV OPENCLAW_BIN=openclaw

EXPOSE 8080
CMD ["node", "src/daemon.mjs"]

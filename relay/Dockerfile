FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git unzip python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install openclaw 2026.4.12 (must match the gateway version used by
# bridge-openclaw so the WS protocol negotiates cleanly).
RUN npm install -g openclaw@2026.4.12

# Relay deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --production

COPY src ./src

ENV STATE_DIR=/opt/data
ENV OPENCLAW_PROFILE_DIR=/opt/data
ENV OPENCLAW_BIN=openclaw
ENV PATH=/usr/local/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH

EXPOSE 8080
CMD ["node", "src/relay.mjs"]

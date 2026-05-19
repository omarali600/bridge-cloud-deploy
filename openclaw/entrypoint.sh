#!/usr/bin/env bash
set -euo pipefail

# First-boot seed: if /opt/data is empty, copy bundled state
if [ ! -f /opt/data/openclaw.json ]; then
  echo "[entrypoint] First boot: seeding /opt/data from /opt/data-seed"
  cp -R /opt/data-seed/. /opt/data/
fi

# Substitute env-vars into openclaw.json (gateway token)
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  python3 -c "
import json, os
with open('/opt/data/openclaw.json') as f:
    cfg = json.load(f)
cfg.setdefault('gateway', {}).setdefault('auth', {})['mode'] = 'token'
cfg['gateway']['auth']['token'] = os.environ['OPENCLAW_GATEWAY_TOKEN']
with open('/opt/data/openclaw.json', 'w') as f:
    json.dump(cfg, f, indent=2)
" 2>&1 || true
fi

PORT="${PORT:-8080}"
echo "[entrypoint] Starting OpenClaw gateway on :$PORT (bind=lan, behind Render proxy)"
# OpenClaw bind modes: loopback|lan|tailnet|auto|custom — "lan" listens on all interfaces (right for cloud behind proxy)
exec openclaw gateway --port "$PORT" --bind lan

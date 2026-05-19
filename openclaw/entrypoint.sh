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

# Ensure bridge-service device is pre-paired (idempotent merge on every boot).
# Lets external clients holding the bridge-service private key authenticate
# without the manual approval dance. Public key only — private stays in
# ~/.bridge-migration-2026-05-18/secrets/ on the operator's machine.
python3 - <<'PYEOF' 2>&1 || true
import json, os, glob

target_dir = '/opt/data/devices'
target_path = os.path.join(target_dir, 'paired.json')
seed_files = sorted(glob.glob('/opt/data-seed/devices/paired-*.json'))

if not seed_files:
    print('[entrypoint] No seed devices found; skipping device pre-pairing')
    raise SystemExit(0)

os.makedirs(target_dir, exist_ok=True)

if os.path.exists(target_path):
    with open(target_path) as f:
        try:
            target = json.load(f)
            if not isinstance(target, dict):
                target = {}
        except Exception:
            target = {}
else:
    target = {}

added = 0
updated = 0
for sf in seed_files:
    with open(sf) as f:
        seed = json.load(f)
    for dev_id, entry in seed.items():
        if dev_id in target:
            # Upsert: seed is the source of truth for these service identities,
            # so newer seed entries override older ones (e.g., scope or platform
            # changes after a re-deploy). Manually-paired devices that are NOT
            # in the seed are preserved.
            if target[dev_id] != entry:
                target[dev_id] = entry
                updated += 1
                print(f'[entrypoint] updated device {dev_id[:12]}... ({entry.get("clientId", "?")}) from {os.path.basename(sf)}')
            else:
                print(f'[entrypoint] device {dev_id[:12]}... already current (from {os.path.basename(sf)})')
        else:
            target[dev_id] = entry
            added += 1
            print(f'[entrypoint] paired device {dev_id[:12]}... ({entry.get("clientId", "?")}) from {os.path.basename(sf)}')

if added or updated:
    with open(target_path, 'w') as f:
        json.dump(target, f, indent=2)
    print(f'[entrypoint] paired.json: +{added} new, {updated} updated, {len(target)} total')
PYEOF

PORT="${PORT:-8080}"
echo "[entrypoint] Starting OpenClaw gateway on :$PORT (bind=lan, behind Render proxy)"
# OpenClaw bind modes: loopback|lan|tailnet|auto|custom — "lan" listens on all interfaces (right for cloud behind proxy)
exec openclaw gateway --port "$PORT" --bind lan

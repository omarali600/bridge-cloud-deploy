#!/usr/bin/env bash
set -euo pipefail

# First-boot seed: if /opt/data is empty, copy bundled state
if [ ! -f /opt/data/openclaw.json ]; then
  echo "[entrypoint] First boot: seeding /opt/data from /opt/data-seed"
  cp -R /opt/data-seed/. /opt/data/
fi

# --- BRIDGE trust-and-audit substrate: boot wiring -------------------------
# Ensure the audit log volume + permissions config exist before any agent
# acts. The mounted Render disk is /opt/data — audit + permissions live
# inside it so they survive redeploy.
mkdir -p /opt/data/audit /opt/data/undo
if [ ! -f /opt/data/audit/audit.jsonl ]; then
  : > /opt/data/audit/audit.jsonl
fi
if [ ! -f /opt/data/permissions.yaml ] && [ -f /opt/data-seed/permissions.yaml ]; then
  cp /opt/data-seed/permissions.yaml /opt/data/permissions.yaml
  echo "[entrypoint] seeded permissions.yaml from bundle"
fi

# Centralized kill-switch check at boot. If any switch is hot we still
# come up (so audit + digest can run), but we record the posture and
# announce via the audit log so the next weekly digest names what's down.
KILL_SUMMARY=""
for var in BRIDGE_KILL_ALL GBRAIN_KILL_SWITCH \
           BRIDGE_KILL_BRIDGET BRIDGE_KILL_BEATRIX BRIDGE_KILL_CLEM \
           BRIDGE_KILL_BASIL BRIDGE_KILL_BENSON BRIDGE_KILL_VOICE \
           BRIDGE_KILL_INTAKE BRIDGE_KILL_EMAIL BRIDGE_KILL_TELEGRAM \
           BRIDGE_KILL_CALENDAR BRIDGE_KILL_VAULT_WRITE BRIDGE_KILL_OUTBOUND ; do
  val="${!var:-}"
  if [ "$val" = "1" ] || [ "$val" = "true" ]; then
    KILL_SUMMARY="${KILL_SUMMARY:+$KILL_SUMMARY, }$var"
  fi
done

# Append one audit row recording the boot, including kill-switch posture.
node -e "
import('/opt/data/../audit/logger.mjs').catch(() => import('./audit/logger.mjs')).then(mod => {
  const msg = '$KILL_SUMMARY' ? 'Cloud gateway booted with the following kill switches active: $KILL_SUMMARY.' : 'Cloud gateway booted with no kill switches active.';
  mod.logSafe({
    agent: 'system', principal: 'system',
    action_type: 'spawn', surface: 'internal',
    target: 'openclaw-gateway',
    reasoning_summary: msg,
    reversible: false, undo_handle: null,
    result: 'success'
  });
}).catch(e => console.error('[entrypoint] audit boot log failed:', e && e.message ? e.message : e));
" 2>/dev/null || true

# Also surface the posture in the container log so Render's UI shows it.
if [ -n "$KILL_SUMMARY" ]; then
  echo "[entrypoint] KILL SWITCHES HOT: $KILL_SUMMARY"
fi
# --- end BRIDGE trust-and-audit boot wiring -------------------------------

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

# First, gather all dev_ids currently in any seed file
seed_dev_ids = set()
for sf in seed_files:
    with open(sf) as f:
        seed = json.load(f)
    seed_dev_ids.update(seed.keys())

# Sweep stale seed-managed entries that are no longer in any seed file.
# Convention: anything whose clientId starts with "bridge-" was placed by
# this entrypoint; if it's not in the current seed, drop it. Manually-paired
# devices (clientId != "bridge-*") are always preserved.
removed = 0
for dev_id in list(target.keys()):
    entry = target.get(dev_id)
    if not isinstance(entry, dict):
        continue
    cid = entry.get('clientId', '')
    if isinstance(cid, str) and cid.startswith('bridge-') and dev_id not in seed_dev_ids:
        print(f'[entrypoint] removing stale seed-managed device {dev_id[:12]}... ({cid})')
        del target[dev_id]
        removed += 1

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

if added or updated or removed:
    with open(target_path, 'w') as f:
        json.dump(target, f, indent=2)
    print(f'[entrypoint] paired.json: +{added} new, {updated} updated, -{removed} removed, {len(target)} total')
PYEOF

# Refresh per-agent workspace config files (IDENTITY.md, SOUL.md, AGENTS.md,
# USER.md, TOOLS.md, HEARTBEAT.md) from the seed on every boot. These are
# config, not state — keeping them seed-driven means edits in
# bridge-cloud-deploy propagate to live agents on next redeploy. State that
# lives inside workspace-*/<subdirs/> (sessions, memory, etc.) is preserved.
for ws_seed in /opt/data-seed/workspace-*; do
  [ -d "$ws_seed" ] || continue
  ws_name=$(basename "$ws_seed")
  ws_live="/opt/data/$ws_name"
  if [ ! -d "$ws_live" ]; then
    continue  # first-boot seed already copied via cp -R above
  fi
  for md in "$ws_seed"/*.md; do
    [ -f "$md" ] || continue
    cp -f "$md" "$ws_live/$(basename "$md")"
  done
  echo "[entrypoint] refreshed config .md files in $ws_name"
done

PORT="${PORT:-8080}"
echo "[entrypoint] Starting OpenClaw gateway on :$PORT (bind=lan, behind Render proxy)"
# OpenClaw bind modes: loopback|lan|tailnet|auto|custom — "lan" listens on all interfaces (right for cloud behind proxy)
exec openclaw gateway --port "$PORT" --bind lan

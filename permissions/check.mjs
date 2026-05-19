/**
 * BRIDGE cloud permissions checker. Mirrors @bridge/permissions.
 *
 * Reads a YAML config mounted at /opt/data/permissions.yaml (override via
 * BRIDGE_PERMISSIONS env var). If the file is missing or malformed, defaults
 * to advisory-only for every (agent, scope) — safe by construction.
 */

import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_PATH = '/opt/data/permissions.yaml';
const VALID_TIERS = new Set(['advisory', 'delegated', 'autonomous']);

function configPath() {
  return process.env.BRIDGE_PERMISSIONS || DEFAULT_PATH;
}

// Tiny YAML parser for the limited shape we use. The YAML library is too
// heavy for the cloud entry. The config is a flat list of permission rows.
function parseSimpleYaml(text) {
  const lines = text.split('\n');
  const result = { version: 1, default_tier: 'advisory', permissions: [] };
  let current = null;
  let inPermissions = false;

  for (let raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (/^version:/.test(line)) {
      const v = line.split(':')[1].trim();
      result.version = Number(v) || 1;
      continue;
    }
    if (/^default_tier:/.test(line)) {
      const v = line.split(':')[1].trim().replace(/^["']|["']$/g, '');
      if (VALID_TIERS.has(v)) result.default_tier = v;
      continue;
    }
    if (/^permissions:/.test(line)) {
      inPermissions = true;
      continue;
    }
    if (!inPermissions) continue;

    const itemMatch = /^\s*-\s+agent:\s*(.+)$/.exec(line);
    if (itemMatch) {
      if (current) result.permissions.push(current);
      current = { agent: itemMatch[1].trim().replace(/^["']|["']$/g, '') };
      continue;
    }
    if (current) {
      const kvMatch = /^\s+(\w+):\s*(.+)$/.exec(line);
      if (kvMatch) {
        const [, k, vRaw] = kvMatch;
        const v = vRaw.trim().replace(/^["']|["']$/g, '');
        current[k] = v;
      }
    }
  }
  if (current) result.permissions.push(current);

  result.permissions = result.permissions.filter(
    (row) =>
      row.agent &&
      row.scope &&
      VALID_TIERS.has(row.tier)
  );

  return result;
}

let cached = null;
let cachedMtime = 0;

function loadConfig() {
  const path = configPath();
  if (!existsSync(path)) {
    return { version: 1, default_tier: 'advisory', permissions: [] };
  }
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = parseSimpleYaml(text);
    cached = parsed;
    return parsed;
  } catch (err) {
    process.stderr.write(
      `[bridge-permissions] cloud config parse failed: ${err && err.message ? err.message : String(err)}. Defaulting to advisory.\n`
    );
    return { version: 1, default_tier: 'advisory', permissions: [] };
  }
}

export function check(agent, scope, cfg) {
  const config = cfg || loadConfig();
  for (const row of config.permissions) {
    if (row.agent === agent && row.scope === scope) {
      return { tier: row.tier, explicit: true, source: row };
    }
  }
  return { tier: config.default_tier, explicit: false };
}

export function tierFor(agent, scope, cfg) {
  return check(agent, scope, cfg).tier;
}

export function canActAutonomously(agent, scope, cfg) {
  const t = tierFor(agent, scope, cfg);
  return t === 'delegated' || t === 'autonomous';
}

export function isFullyAutonomous(agent, scope, cfg) {
  return tierFor(agent, scope, cfg) === 'autonomous';
}

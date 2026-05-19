/**
 * BRIDGE cloud audit logger.
 *
 * Same schema and surface as the local @bridge/audit package. Lives inside
 * the OpenClaw container and writes to a mounted volume so entries survive
 * redeploy.
 *
 * No dependencies. Plain Node 18+.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = '/opt/data/audit/audit.jsonl';

function auditPath() {
  return process.env.BRIDGE_AUDIT_LOG || DEFAULT_PATH;
}

/**
 * Append one audit entry. Returns the canonical written entry.
 */
export function log(input) {
  const entry = {
    id: input.id || `audit_${Date.now()}_${randomUUID().slice(0, 8)}`,
    timestamp: input.timestamp || new Date().toISOString(),
    agent: input.agent,
    principal: input.principal,
    action_type: input.action_type,
    surface: input.surface,
    target: input.target,
    reasoning_summary: input.reasoning_summary,
    reversible: input.reversible,
    undo_handle: input.undo_handle ?? null,
    result: input.result,
  };
  if (input.error_summary !== undefined) entry.error_summary = input.error_summary;
  if (input.tier !== undefined) entry.tier = input.tier;
  if (input.scope !== undefined) entry.scope = input.scope;

  const path = auditPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  return entry;
}

/**
 * Same as log() but swallows errors. Use in non-critical paths so audit
 * logging cannot break the calling agent.
 */
export function logSafe(input) {
  try {
    return log(input);
  } catch (err) {
    process.stderr.write(
      `[bridge-audit] cloud logger failure: ${err && err.message ? err.message : String(err)}\n`
    );
    return null;
  }
}

/**
 * Stream-filter the audit log. Newest-first.
 */
export function recent(filter = {}) {
  const path = auditPath();
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf8');
  if (!raw) return [];

  const lines = raw.split('\n').filter((l) => l.length > 0);
  const out = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (filter.agent && entry.agent !== filter.agent) continue;
    if (filter.principal && entry.principal !== filter.principal) continue;
    if (filter.action_type && entry.action_type !== filter.action_type) continue;
    if (filter.surface && entry.surface !== filter.surface) continue;
    if (filter.result && entry.result !== filter.result) continue;
    if (filter.since && entry.timestamp < filter.since) continue;
    if (filter.until && entry.timestamp >= filter.until) continue;
    out.push(entry);
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (filter.limit && out.length > filter.limit) return out.slice(0, filter.limit);
  return out;
}

export function withinHours(hours, extra = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  return recent({ ...extra, since });
}

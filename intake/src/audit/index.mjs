/**
 * Audit substrate adapter.
 *
 * Agent C is building the trust-and-audit substrate in parallel. Until their
 * library publishes, this adapter writes JSONL to /opt/data/intake/audit.jsonl.
 * The interface deliberately matches what we expect their library to expose so
 * the swap is one import line.
 *
 * Once Agent C ships:
 *   1. Replace the writeJsonl body below with a call to their library.
 *   2. Run scripts/migrate-audit-to-substrate.mjs to backfill past events.
 *   3. Delete this file's stub implementation.
 *
 * Every event:
 *   {
 *     ts: ISO timestamp,
 *     agent: 'bridget',                       // who took the action
 *     action: 'classify'|'route'|'invoke'|'escalate'|'archive'|'threshold-change'|'admin-test',
 *     target: 'beatrix'|'clem'|'brain'|'omar'|null,
 *     reasoning: 'plain English',             // human-readable why
 *     data: { intakeItemId, classification, ... }
 *   }
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.mjs';

let auditPath = null;
let initialized = false;

export function initAudit({ stateDir }) {
  auditPath = `${stateDir}/intake/audit.jsonl`;
  mkdirSync(dirname(auditPath), { recursive: true });
  initialized = true;
  log(`audit: writing to ${auditPath}`);
}

export function record(event) {
  if (!initialized) {
    log(`audit: not initialized; dropping event ${event.action}`);
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    agent: 'bridget',
    ...event,
  });
  try {
    appendFileSync(auditPath, line + '\n');
  } catch (e) {
    log(`audit: failed to write event: ${e.message}`);
  }
}

/**
 * Read recent audit events. Used by the metrics endpoint and (eventually) by
 * the weekly digest (capability #92).
 */
export function recent({ limit = 100, since = null } = {}) {
  if (!initialized || !existsSync(auditPath)) return [];
  try {
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    let events = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    if (since) {
      const sinceMs = new Date(since).getTime();
      events = events.filter((e) => new Date(e.ts).getTime() >= sinceMs);
    }
    return events.slice(-limit);
  } catch (e) {
    log(`audit: failed to read events: ${e.message}`);
    return [];
  }
}

/**
 * Convenience wrapper exported as `audit` so call sites read like:
 *   audit.log({ action, target, reasoning, data })
 * matching what Agent C's library is expected to expose.
 */
export const audit = { log: record, recent };

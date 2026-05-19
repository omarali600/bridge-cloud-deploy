#!/usr/bin/env node
/**
 * Smoke test for the cloud audit logger. Run inside the container or
 * locally with BRIDGE_AUDIT_LOG pointing at a scratch path.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, recent } from './logger.mjs';

const dir = mkdtempSync(join(tmpdir(), 'bridge-cloud-audit-'));
process.env.BRIDGE_AUDIT_LOG = join(dir, 'audit.jsonl');

try {
  const entry = log({
    agent: 'beatrix',
    principal: 'omar',
    action_type: 'write',
    surface: 'vault',
    target: 'test/sample.md',
    reasoning_summary: 'Wrote a sample audit entry for the smoke test.',
    reversible: true,
    undo_handle: 'u_smoke_test',
    result: 'success',
    tier: 'delegated',
    scope: 'vault-write',
  });

  if (!entry.id || !entry.timestamp) throw new Error('missing id/timestamp');

  const raw = readFileSync(process.env.BRIDGE_AUDIT_LOG, 'utf8');
  const parsed = JSON.parse(raw.trim());
  if (parsed.agent !== 'beatrix') throw new Error('agent mismatch');

  const got = recent({ agent: 'beatrix' });
  if (got.length !== 1) throw new Error(`expected 1, got ${got.length}`);

  console.log('OK cloud audit logger');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

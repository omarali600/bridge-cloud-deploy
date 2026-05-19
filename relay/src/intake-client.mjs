/**
 * Intake client. The relay forwards normalized payloads to the bridge-intake
 * service. Intake classifies + routes + returns the reply text (if any).
 *
 * Set INTAKE_URL to enable forwarding. If unset, the relay falls back to
 * its legacy classify+invoke path (kept around for safety until the cloud
 * intake is verified end-to-end).
 */

import { log } from './log.mjs';

let intakeUrl = null;
let timeoutMs = 120_000;
let adminToken = null;

export function initIntake(opts = {}) {
  intakeUrl = (opts.intakeUrl ?? process.env.INTAKE_URL ?? '').replace(/\/$/, '') || null;
  adminToken = opts.adminToken ?? process.env.INTAKE_ADMIN_TOKEN ?? null;
  if (intakeUrl) {
    log(`intake: forwarding to ${intakeUrl}`);
  } else {
    log('intake: INTAKE_URL not set; relay using legacy direct-classify path');
  }
}

export function intakeEnabled() {
  return intakeUrl !== null;
}

export async function forward(surface, payload) {
  if (!intakeUrl) throw new Error('intake not configured');
  const url = `${intakeUrl}/ingest/${surface}`;
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`intake ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

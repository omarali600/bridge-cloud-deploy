#!/usr/bin/env node
/**
 * End-to-end test against a running intake daemon.
 *
 * Posts each fixture to /ingest/admin-test (which classifies + computes the
 * routing decision WITHOUT actually invoking agents or escalating to Omar)
 * and asserts on the classifier output.
 *
 * Requires:
 *   INTAKE_URL          base URL (e.g., https://bridge-intake.onrender.com or http://localhost:8080)
 *   INTAKE_ADMIN_TOKEN  admin token
 *
 * Each fixture has an `expected` block (assertions). For fixtures without
 * one, this test just runs them and prints the classification for review.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

const INTAKE_URL = (process.env.INTAKE_URL ?? '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.INTAKE_ADMIN_TOKEN ?? '';

if (!INTAKE_URL) {
  console.error('e2e: INTAKE_URL env var required');
  process.exit(2);
}
if (!ADMIN_TOKEN) {
  console.error('e2e: INTAKE_ADMIN_TOKEN env var required');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];

async function classifyFixture(fixture) {
  const res = await fetch(`${INTAKE_URL}/admin/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(fixture),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Per-fixture expectations. Looser than strict equality — checks the
// classification is in the right neighborhood (correct route, urgency tier).
const EXPECTATIONS = {
  'email-crrem-andrea.json': (r) => {
    return r.classification.suggested_route === 'clem'
        && ['normal', 'urgent'].includes(r.classification.urgency)
        && r.classification.domain.startsWith('crrem');
  },
  'telegram-personal.json': (r) => {
    return r.classification.suggested_route === 'beatrix'
        && r.classification.domain === 'personal';
  },
  'voice-memo-crrem.json': (r) => {
    return r.classification.suggested_route === 'clem';
  },
  'calendar-board-meeting.json': (r) => {
    return r.classification.action === 'queue'
        && r.classification.domain === 'admin';
  },
  'photo-receipt.json': (r) => {
    return r.classification.suggested_route === 'beatrix';
  },
  'sharepoint-crrem-doc.json': (r) => {
    return r.classification.suggested_route === 'clem';
  },
  'telegram-urgent-press.json': (r) => {
    // Should escalate to Omar because it's about world-touching reply_to_journalist.
    return r.decision.effective_action === 'escalate'
        || r.classification.suggested_route === 'omar-direct';
  },
};

async function run() {
  console.log(`e2e: testing ${INTAKE_URL}`);
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8'));
    console.log(`\n[${file}]`);
    let result;
    try {
      result = await classifyFixture(fixture);
    } catch (e) {
      console.log(`  ERR  ${e.message}`);
      failed++;
      failures.push({ file, err: e.message });
      continue;
    }
    console.log(`  surface=${result.item.surface} route=${result.classification.suggested_route} urgency=${result.classification.urgency} domain=${result.classification.domain} action=${result.classification.action} effective=${result.decision.effective_action}`);
    console.log(`  reason: ${result.classification.reasoning_summary}`);

    const expectFn = EXPECTATIONS[file];
    if (expectFn) {
      if (expectFn(result)) {
        passed++;
        console.log('  ok   expectation met');
      } else {
        failed++;
        failures.push({ file, result });
        console.log('  FAIL expectation unmet');
      }
    } else {
      console.log('  (no expectation; manual review)');
    }
  }

  console.log(`\n────`);
  console.log(`Passed: ${passed}    Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.file}: ${f.err ?? JSON.stringify(f.result).slice(0, 200)}`);
    process.exit(1);
  }
}

run().catch((e) => { console.error(`e2e: ${e.message}`); process.exit(2); });

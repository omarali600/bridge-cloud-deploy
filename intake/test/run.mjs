#!/usr/bin/env node
/**
 * Offline tests. Exercises:
 *   • Rule-based pre-classifier on every fixture.
 *   • Normalize functions of every surface adapter.
 *   • Threshold decision logic.
 *   • Audit log shape.
 *
 * No network calls. No LLM. No spinning up the daemon. Use test/e2e.mjs for
 * the full-pipeline test against a running cloud (or local) daemon.
 *
 * Run: node test/run.mjs
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preClassify } from '../src/classifier/rules.mjs';
import { decide, initThresholds } from '../src/routing/thresholds.mjs';
import { initAudit, audit } from '../src/audit/index.mjs';

import * as telegramSurface from '../src/surfaces/telegram.mjs';
import * as emailSurface from '../src/surfaces/email.mjs';
import * as calendarSurface from '../src/surfaces/calendar.mjs';
import * as voicememoSurface from '../src/surfaces/voicememo.mjs';
import * as photoSurface from '../src/surfaces/photo.mjs';
import * as sharepointSurface from '../src/surfaces/sharepoint.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, predicate, details) {
  if (predicate) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, details });
    console.log(`  FAIL ${name} — ${details ?? ''}`);
  }
}

function section(title, fn) {
  console.log(`\n== ${title} ==`);
  fn();
}

// ─── setup ───
const tmp = mkdtempSync(join(tmpdir(), 'intake-test-'));
initAudit({ stateDir: tmp });
initThresholds({ stateDir: tmp });

// ─── tests ───

section('rule-based classifier — calendar invite', () => {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'calendar-board-meeting.json'), 'utf-8'));
  const r = preClassify(fixture);
  ok('classifies calendar as admin/queue', r?.domain === 'admin' && r?.action === 'queue', JSON.stringify(r));
  ok('routes to beatrix', r?.suggested_route === 'beatrix', r?.suggested_route);
});

section('rule-based classifier — CRREM SharePoint', () => {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'sharepoint-crrem-doc.json'), 'utf-8'));
  const r = preClassify(fixture);
  ok('classifies as crrem-internal', r?.domain === 'crrem-internal', r?.domain);
  ok('routes to clem', r?.suggested_route === 'clem', r?.suggested_route);
});

section('rule-based classifier — voice memo with CRREM mention', () => {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'voice-memo-crrem.json'), 'utf-8'));
  const r = preClassify(fixture);
  ok('detects CRREM domain', r?.domain === 'crrem-internal', r?.domain);
  ok('routes to clem', r?.suggested_route === 'clem', r?.suggested_route);
});

section('rule-based classifier — receipt photo', () => {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'photo-receipt.json'), 'utf-8'));
  // Inject filename hint so the rule fires (synthetic fixture).
  fixture.content.rawSurfaceMetadata.filename = 'receipt-IMG_5183.jpeg';
  const r = preClassify(fixture);
  ok('detects receipt', r?._source?.includes('receipt'), r?._source);
  ok('routes to beatrix (finance specialist)', r?.suggested_route === 'beatrix', r?.suggested_route);
});

section('rule-based classifier — telegram from non-self (no match)', () => {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'telegram-personal.json'), 'utf-8'));
  fixture.from.identifier = '1234567890'; // not Omar's chat
  const r = preClassify(fixture);
  ok('no rule match (LLM will decide)', r === null, JSON.stringify(r));
});

section('surface adapters — normalize shapes', () => {
  const tg = telegramSurface.normalize({ message: { message_id: 42, chat: { id: 123 }, from: { username: 'tester' }, text: 'hi', date: 1715000000 } });
  ok('telegram normalize includes surface', tg.surface === 'telegram');
  ok('telegram normalize captures text', tg.content.text === 'hi');

  const ws = sharepointSurface.normalize(
    { id: 'doc1', name: 'foo.docx', size: 1024, file: { mimeType: 'app/docx' }, webUrl: 'https://x', parentReference: { path: '/Documents/CRREM' }, lastModifiedBy: { user: { email: 'm@crrem.org', displayName: 'Missy' } } },
    { id: 'drv1' }, { id: 'site1' }
  );
  ok('sharepoint normalize captures path', ws.content.rawSurfaceMetadata.path.includes('CRREM'));

  const vm = voicememoSurface.normalize({ filename: 'memo.m4a', durationSec: 30, recordedAt: '2026-05-20T10:00:00Z', transcript: 'hi' });
  ok('voice memo normalize captures transcript', vm.content.transcript === 'hi');
  ok('voice memo from kind=self', vm.from.kind === 'self');

  const ph = photoSurface.normalize({ filename: 'pic.jpg', takenAt: '2026-05-20T10:00:00Z', visionSummary: 'a cat' });
  ok('photo normalize captures vision summary', ph.content.vision === 'a cat');

  // email normalize from minimal Gmail message
  const em = emailSurface.normalize({
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: '"Test Sender" <test@example.com>' },
        { name: 'Subject', value: 'hello' },
        { name: 'Date', value: 'Tue, 20 May 2026 10:00:00 +0000' },
      ],
      body: { data: Buffer.from('hi there').toString('base64url') },
    },
  });
  ok('email normalize parses sender display', em.from.display === 'Test Sender');
  ok('email normalize captures subject', em.content.subject === 'hello');
  ok('email normalize captures body', em.content.text === 'hi there');

  // calendar normalize
  const cal = calendarSurface.normalize({
    id: 'e1', summary: 'meeting', status: 'confirmed', updated: '2026-05-20T10:00:00Z',
    organizer: { email: 'o@x.com', self: true },
    start: { dateTime: '2026-05-25T14:00:00Z' }, end: { dateTime: '2026-05-25T15:00:00Z' },
    attendees: [{ email: 'a@x.com', responseStatus: 'accepted' }],
  });
  ok('calendar normalize captures subject', cal.content.subject === 'meeting');
  ok('calendar surface set', cal.surface === 'calendar');
});

section('thresholds — defaults', () => {
  const cls = { urgency: 'normal', action: 'handle', suggested_route: 'beatrix', world_touching_action: null };
  const d = decide('telegram', cls);
  ok('telegram normal/handle = handle', d.effective_action === 'handle');

  const cls2 = { urgency: 'urgent', action: 'handle', suggested_route: 'beatrix', world_touching_action: null };
  const d2 = decide('telegram', cls2);
  ok('urgent always escalates', d2.effective_action === 'escalate');

  const cls3 = { urgency: 'normal', action: 'handle', suggested_route: 'beatrix', world_touching_action: 'send_external_message' };
  const d3 = decide('email', cls3);
  ok('world-touching → escalate', d3.effective_action === 'escalate');
});

section('audit log — write + read roundtrip', () => {
  audit.log({ action: 'classify', target: 'beatrix', reasoning: 'test event', data: { x: 1 } });
  audit.log({ action: 'route', target: 'clem', reasoning: 'test event 2', data: { x: 2 } });
  const recent = audit.recent({ limit: 10 });
  ok('audit returns events', recent.length >= 2, `got ${recent.length}`);
  ok('audit captures action', recent[recent.length - 1].action === 'route');
  ok('audit captures reasoning', recent[recent.length - 1].reasoning === 'test event 2');
});

// ─── teardown ───
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

// ─── summary ───
console.log(`\n────`);
console.log(`Passed: ${passed}    Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.details}`);
  process.exit(1);
}
process.exit(0);

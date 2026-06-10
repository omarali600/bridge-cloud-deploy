/**
 * cloud-brief — S0 substrate spike (masterpiece plan A1/A12).
 *
 * Proves a scheduled Telegram brief can fire from the cloud on a day the Mac
 * never opens. Fully isolated module: no imports from pipeline/routing/relay
 * paths; its own Telegram send; additive only.
 *
 * Flow (A12: cloud = read-only curated snapshot):
 *   1. Mac pushes a curated snapshot (PULSE.md + Active Focus titles +
 *      last_brief_at) to POST /snapshot, authenticated with
 *      CLOUD_SNAPSHOT_TOKEN (bearer). Stored at STATE_DIR/intake/cloud-snapshot.json.
 *   2. An in-process scheduler ticks every 30s against Europe/Amsterdam
 *      wall-clock time (no long setTimeout — drift + 32-bit overflow; no
 *      node-cron dependency needed at this scale).
 *   3. At CLOUD_BRIEF_TEST_AT (HH:MM, fires once, marker persisted) or at the
 *      standing CLOUD_BRIEF_AT (default 06:30 daily), it composes a SHORT
 *      degraded-mode brief from the snapshot and sends it to Omar's chat.
 *
 * DEDUPE (spike-grade, replaced by the A9 outbox in S1): the standing daily
 * fire is SKIPPED if snapshot.last_brief_at is within 20h — meaning the Mac
 * already briefed this morning. The one-off test fire bypasses dedupe so the
 * spike can be observed. Restart-safe: fired markers persist to disk, so a
 * Render deploy/restart neither double-fires nor forgets.
 *
 * Composition: claude-haiku-4-5 (one short call) when ANTHROPIC_API_KEY is
 * present; deterministic template otherwise. Output contract either way:
 * plain text, max 10 lines, headed "Morning note (cloud fallback)", and if
 * the snapshot is older than 24h it MUST say how stale it is.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { log } from './log.mjs';

const TZ = 'Europe/Amsterdam';
const TICK_MS = 30_000;
const DEDUPE_WINDOW_H = 20;
const STALE_AFTER_H = 24;

let cfg = {};
let snapshotPath = null;
let markersPath = null;
let timer = null;

// ─── init ───

export function initCloudBrief({ stateDir, telegramToken, telegramChatId, anthropicKey, snapshotToken, briefAt, testAt } = {}) {
  cfg = {
    telegramToken: telegramToken || process.env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: telegramChatId || process.env.TELEGRAM_CHAT_ID || null,
    anthropicKey: anthropicKey || process.env.ANTHROPIC_API_KEY || null,
    snapshotToken: snapshotToken || process.env.CLOUD_SNAPSHOT_TOKEN || null,
    briefAt: briefAt || process.env.CLOUD_BRIEF_AT || '06:30',
    testAt: testAt || process.env.CLOUD_BRIEF_TEST_AT || null,
  };
  const dir = `${stateDir ?? '/opt/data'}/intake`;
  mkdirSync(dir, { recursive: true });
  snapshotPath = `${dir}/cloud-snapshot.json`;
  markersPath = `${dir}/cloud-brief-markers.json`;

  if (!cfg.snapshotToken) {
    log('cloud-brief: CLOUD_SNAPSHOT_TOKEN not set; /snapshot will reject all pushes');
  }
  timer = setInterval(() => tick().catch((e) => log(`cloud-brief: tick error: ${e.message}`)), TICK_MS);
  timer.unref?.();
  log(`cloud-brief: scheduler armed (standing ${cfg.briefAt} ${TZ}${cfg.testAt ? `, one-off test ${cfg.testAt}` : ''})`);
}

// ─── snapshot intake (POST /snapshot) ───

export function checkSnapshotAuth(req) {
  if (!cfg.snapshotToken) return false;
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7) === cfg.snapshotToken;
}

export function saveSnapshot(body) {
  if (!body || typeof body.pulse_md !== 'string' || !body.generated_at) {
    throw new Error('snapshot requires { pulse_md, focus_excerpt, generated_at }');
  }
  const snapshot = {
    pulse_md: body.pulse_md,
    focus_excerpt: Array.isArray(body.focus_excerpt) ? body.focus_excerpt : [],
    generated_at: body.generated_at,
    last_brief_at: body.last_brief_at ?? null,
    received_at: new Date().toISOString(),
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  log(`cloud-brief: snapshot saved (generated_at=${snapshot.generated_at}, last_brief_at=${snapshot.last_brief_at})`);
  return { ok: true, received_at: snapshot.received_at, bytes: snapshot.pulse_md.length };
}

export function status() {
  const snap = readSnapshot();
  return {
    snapshot_present: !!snap,
    snapshot_generated_at: snap?.generated_at ?? null,
    snapshot_age_hours: snap ? ageHours(snap.generated_at) : null,
    last_brief_at: snap?.last_brief_at ?? null,
    markers: readMarkers(),
    standing_at: cfg.briefAt,
    test_at: cfg.testAt,
    tz: TZ,
  };
}

// ─── scheduler ───

function amsNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` };
}

async function tick() {
  const { date, hhmm } = amsNow();
  const markers = readMarkers();

  // One-off test fire: bypasses dedupe so the spike can be observed live.
  if (cfg.testAt && hhmm >= cfg.testAt && !markers.test_fired_at) {
    markers.test_fired_at = new Date().toISOString();
    writeMarkers(markers); // marker BEFORE side effect (idempotency, A11 spirit)
    log(`cloud-brief: one-off test fire at ${hhmm} ${TZ}`);
    await fireBrief({ reason: 'test' });
    return;
  }

  // Standing daily fallback at briefAt, dedupe against the Mac's brief.
  if (hhmm >= cfg.briefAt && markers.last_standing_date !== date) {
    // Only treat as "due" within 30 min of the slot so a midday deploy
    // doesn't fire retroactively.
    if (minutesSince(cfg.briefAt, hhmm) > 30) return;
    markers.last_standing_date = date;
    writeMarkers(markers);
    const snap = readSnapshot();
    if (snap?.last_brief_at && ageHours(snap.last_brief_at) < DEDUPE_WINDOW_H) {
      log(`cloud-brief: standing fire skipped — Mac briefed ${ageHours(snap.last_brief_at).toFixed(1)}h ago (dedupe < ${DEDUPE_WINDOW_H}h)`);
      return;
    }
    log(`cloud-brief: standing fallback fire at ${hhmm} ${TZ}`);
    await fireBrief({ reason: 'standing' });
  }
}

function minutesSince(hhmmA, hhmmB) {
  const [ah, am] = hhmmA.split(':').map(Number);
  const [bh, bm] = hhmmB.split(':').map(Number);
  return (bh * 60 + bm) - (ah * 60 + am);
}

// ─── brief composition + send ───

export async function fireBrief({ reason = 'manual' } = {}) {
  const snap = readSnapshot();
  const text = await compose(snap);
  const out = await sendTelegram(text);
  log(`cloud-brief: SENT (reason=${reason}, ok=${out.ok}, message_id=${out.result?.message_id})`);
  return { ok: out.ok, message_id: out.result?.message_id, reason, lines: text.split('\n').length };
}

async function compose(snap) {
  const header = 'Morning note (cloud fallback)';
  if (!snap) {
    return `${header}\nNo snapshot from your Mac yet, so I have nothing current to brief from.\nThe laptop pushing once will fix this.`;
  }
  const staleH = ageHours(snap.generated_at);
  const staleLine = staleH > STALE_AFTER_H ? `Working from a snapshot ${Math.round(staleH)} hours old.` : null;

  let body = null;
  if (cfg.anthropicKey) {
    body = await composeWithHaiku(snap).catch((e) => {
      log(`cloud-brief: haiku composition failed (${e.message}); falling back to template`);
      return null;
    });
  }
  if (!body) body = composeTemplate(snap);

  const lines = [header, ...(staleLine ? [staleLine] : []), ...body.split('\n').filter((l) => l.trim())];
  return lines.slice(0, 10).join('\n');
}

function composeTemplate(snap) {
  const focus = (snap.focus_excerpt ?? []).slice(0, 3).map((t, i) => `${i + 1}. ${t}`);
  return [
    'Your Mac is offline, so this is the short version.',
    ...(focus.length ? ['Active focus:', ...focus] : []),
    'Full brief resumes when the laptop wakes.',
  ].join('\n');
}

async function composeWithHaiku(snap) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: cfg.anthropicKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: [
      'You write a degraded-mode morning note for Omar. His Mac is offline;',
      'you only have a possibly-stale snapshot of his PULSE file. Plain text,',
      'max 7 short lines, no headers, no markdown, no bullets beyond simple',
      'numbers, warm and direct, no em dashes, no contrastive negation.',
      'Name the top 1-3 things that matter today from Active Focus and one',
      'constraint worth respecting. Do not invent anything not in the snapshot.',
    ].join(' '),
    messages: [{ role: 'user', content: `Snapshot (generated ${snap.generated_at}):\n\n${snap.pulse_md.slice(0, 6000)}` }],
  });
  const text = msg.content?.find((b) => b.type === 'text')?.text?.trim();
  if (!text) throw new Error('empty completion');
  return text;
}

async function sendTelegram(text) {
  if (!cfg.telegramToken || !cfg.telegramChatId) {
    throw new Error('cloud-brief: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
  }
  const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.telegramChatId, text, disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(`telegram sendMessage failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

// ─── disk helpers ───

function readSnapshot() {
  if (!existsSync(snapshotPath)) return null;
  try { return JSON.parse(readFileSync(snapshotPath, 'utf8')); } catch { return null; }
}

function readMarkers() {
  if (!existsSync(markersPath)) return {};
  try { return JSON.parse(readFileSync(markersPath, 'utf8')); } catch { return {}; }
}

function writeMarkers(m) {
  writeFileSync(markersPath, JSON.stringify(m, null, 2), { mode: 0o600 });
}

function ageHours(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

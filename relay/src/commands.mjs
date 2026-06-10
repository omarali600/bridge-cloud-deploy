/**
 * S1 command ingestion (masterpiece plan A8/A9/A11) — additive module.
 *
 * The relay is the SOLE Telegram getUpdates consumer. When commands mode is
 * on (RELAY_COMMANDS_ENABLED=1), every non-/ message from the PINNED chat is
 * parsed against the approval grammar and written to a durable outbox on the
 * service disk; the Mac's queue consumer pulls it every 60s through the
 * authenticated /outbox endpoints and sends the acks. Messages from any
 * other chat are dropped + audited (handled upstream in telegram.mjs, audit
 * here). The relay itself stays silent on commands — one voice (the Mac)
 * answers, so Omar never gets two replies.
 *
 * Idempotency (A11): processed Telegram update_ids are persisted BEFORE the
 * outbox append, so a crash between getUpdates batches can never double-
 * enqueue an approval.
 *
 * Grammar TWIN: packages/bridge-command-queue/src/grammar.ts in bridge-ai is
 * the authority; tests/grammar.test.ts there carries the shared fixtures.
 * Change semantics in both places in the same sitting.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { log } from './log.mjs';

let outboxDir = null;
let token = null;
let enabled = false;

const HASH = '([0-9a-f]{6})';
const BARE_APPROVE = /^(send( it)?|yes|approve[d]?|ok|okay|go|ship it)[.!]?$/i;
const BARE_DROP = /^(drop( it)?|no)[.!]?$/i;
const BARE_CANCEL = /^(cancel|undo|stop)[.!]?$/i;

export function initCommands({ stateDir, outboxToken, commandsEnabled } = {}) {
  outboxDir = path.join(stateDir ?? '/opt/data', 'outbox');
  mkdirSync(outboxDir, { recursive: true });
  token = outboxToken ?? process.env.OUTBOX_TOKEN ?? null;
  enabled = commandsEnabled ?? process.env.RELAY_COMMANDS_ENABLED === '1';
  if (enabled && !token) {
    log('commands: RELAY_COMMANDS_ENABLED=1 but OUTBOX_TOKEN missing; outbox pull will reject everything');
  }
  log(`commands: ${enabled ? 'ENABLED' : 'disabled'} (outbox at ${outboxDir})`);
}

export function commandsEnabled() {
  return enabled;
}

// ── grammar (twin of bridge-command-queue/src/grammar.ts) ─────────────────

export function hashFromReplyContext(replyToText) {
  if (!replyToText) return null;
  const fromTemplate = replyToText.match(new RegExp(`send ${HASH}\\b`, 'i'));
  if (fromTemplate) return fromTemplate[1].toLowerCase();
  const standalone = replyToText.match(new RegExp(`\\b${HASH}\\b`, 'i'));
  return standalone ? standalone[1].toLowerCase() : null;
}

export function parseCommand(rawText, replyToText) {
  const text = (rawText ?? '').trim();
  const base = { kind: 'capture', hash: null, instruction: null, city: null, bare: false, text };
  if (!text) return base;

  let m;
  if ((m = text.match(new RegExp(`^send\\s+${HASH}$`, 'i')))) {
    return { ...base, kind: 'send', hash: m[1].toLowerCase() };
  }
  if ((m = text.match(new RegExp(`^edit\\s+${HASH}\\s+([\\s\\S]+)$`, 'i')))) {
    return { ...base, kind: 'edit', hash: m[1].toLowerCase(), instruction: m[2].trim() };
  }
  if ((m = text.match(new RegExp(`^(drop|cancel|undo)\\s+${HASH}$`, 'i')))) {
    const verb = m[1].toLowerCase();
    return { ...base, kind: verb === 'drop' ? 'drop' : 'cancel', hash: m[2].toLowerCase() };
  }
  if (/^status$/i.test(text)) return { ...base, kind: 'status' };
  if (/^freeze$/i.test(text)) return { ...base, kind: 'freeze' };
  if (/^thaw$/i.test(text)) return { ...base, kind: 'thaw' };
  if ((m = text.match(/^tz\s+(.+)$/i))) return { ...base, kind: 'tz', city: m[1].trim() };

  const ctxHash = hashFromReplyContext(replyToText);
  if (BARE_APPROVE.test(text)) return { ...base, kind: 'send', hash: ctxHash, bare: true };
  if (BARE_DROP.test(text)) return { ...base, kind: 'drop', hash: ctxHash, bare: true };
  if (BARE_CANCEL.test(text)) return { ...base, kind: 'cancel', hash: ctxHash, bare: true };
  if ((m = text.match(/^edit\s+([\s\S]+)$/i)) && ctxHash) {
    return { ...base, kind: 'edit', hash: ctxHash, instruction: m[1].trim(), bare: true };
  }
  return base;
}

// ── durable outbox on the service disk ────────────────────────────────────

function metaPath() {
  return path.join(outboxDir, 'meta.json');
}

function linesPath() {
  return path.join(outboxDir, 'commands.jsonl');
}

function processedPath() {
  return path.join(outboxDir, 'processed-updates.json');
}

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(p, content) {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, p);
}

function readMeta() {
  return readJson(metaPath(), { next_seq: 1, acked_seq: 0 });
}

function writeMeta(meta) {
  atomicWrite(metaPath(), JSON.stringify(meta));
}

export function alreadyProcessed(updateId) {
  return readJson(processedPath(), []).includes(updateId);
}

/** Persist the update_id BEFORE any side effect (A11). */
export function markProcessed(updateId) {
  const ids = readJson(processedPath(), []);
  if (ids.includes(updateId)) return;
  ids.push(updateId);
  atomicWrite(processedPath(), JSON.stringify(ids.slice(-5000)));
}

export function appendCommand(cmd) {
  const meta = readMeta();
  const record = { ...cmd, seq: meta.next_seq };
  meta.next_seq += 1;
  // jsonl append is the durable store; meta written after so a crash between
  // the two can only re-issue the same seq, which the Mac dedupes by id.
  appendFileSync(linesPath(), JSON.stringify(record) + '\n');
  writeMeta(meta);
  return record;
}

export function pullCommands(afterSeq, limit = 50) {
  const meta = readMeta();
  const floor = Math.max(Number(afterSeq) || 0, meta.acked_seq);
  if (!existsSync(linesPath())) return [];
  const out = [];
  for (const line of readFileSync(linesPath(), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.seq > floor) out.push(rec);
    if (out.length >= limit) break;
  }
  return out;
}

export function ackCommands(uptoSeq) {
  const meta = readMeta();
  meta.acked_seq = Math.max(meta.acked_seq, Number(uptoSeq) || 0);
  writeMeta(meta);
  // Compaction: drop fully-acked lines once the file grows past ~2000 rows.
  if (existsSync(linesPath())) {
    const lines = readFileSync(linesPath(), 'utf-8').split('\n').filter((l) => l.trim());
    if (lines.length > 2000) {
      const keep = lines.filter((l) => {
        try {
          return JSON.parse(l).seq > meta.acked_seq;
        } catch {
          return false;
        }
      });
      atomicWrite(linesPath(), keep.join('\n') + (keep.length ? '\n' : ''));
    }
  }
  return meta.acked_seq;
}

export function outboxStatus() {
  const meta = readMeta();
  return {
    enabled,
    next_seq: meta.next_seq,
    acked_seq: meta.acked_seq,
    pending: pullCommands(meta.acked_seq, 1000).length,
  };
}

// ── auth (CLOUD_SNAPSHOT_TOKEN pattern) ───────────────────────────────────

export function checkOutboxAuth(req) {
  if (!token) return false;
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7) === token;
}

// ── audit ─────────────────────────────────────────────────────────────────

export function auditRow(row) {
  try {
    appendFileSync(
      path.join(outboxDir, 'audit.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'
    );
  } catch (e) {
    log(`commands: audit write failed: ${e.message}`);
  }
}

// ── entry point used by the telegram channel ──────────────────────────────

/**
 * Handle a message from the PINNED chat. Returns true when the message was
 * consumed as a command/capture (the caller must then NOT run the legacy
 * agent-reply path — one voice only).
 */
export function handlePinnedMessage(updateId, msg) {
  if (!enabled) return false;
  const text = msg.text ?? '';
  if (!text || text.startsWith('/')) return false; // /start, /help stay with the channel

  const id = `tg-${updateId}`;
  if (alreadyProcessed(updateId)) {
    log(`commands: duplicate update ${updateId}, skipping`);
    auditRow({ action: 'duplicate-update', update_id: updateId });
    return true; // consumed previously; still suppress the legacy path
  }
  // A11: persist BEFORE the side effect (the outbox append).
  markProcessed(updateId);

  const parsed = parseCommand(text, msg.reply_to_message?.text ?? null);
  const record = appendCommand({
    id,
    kind: parsed.kind,
    hash: parsed.hash,
    instruction: parsed.instruction,
    city: parsed.city,
    bare: parsed.bare,
    text,
    reply_to_text: msg.reply_to_message?.text ?? null,
    message_id: msg.message_id,
    received_at: new Date().toISOString(),
  });
  auditRow({ action: 'enqueued', seq: record.seq, id, kind: parsed.kind, hash: parsed.hash });
  log(`commands: enqueued seq=${record.seq} ${parsed.kind}${parsed.hash ? ` ${parsed.hash}` : ''}`);
  return true;
}

/** Unknown-chat drop (A3): audit and stay silent. */
export function auditUnknownChat(chatId, msg) {
  auditRow({
    action: 'unknown-chat-dropped',
    chat_id: String(chatId),
    message_id: msg?.message_id ?? null,
  });
}

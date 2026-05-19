#!/usr/bin/env node
/**
 * Local Mac watcher for new images in Screenshots and Downloads.
 *
 * Watches:
 *   ~/Library/Mobile Documents/com~apple~CloudDocs/Screenshots/
 *   ~/Downloads/
 *
 * For each new image: runs OCR via OpenAI vision (Whisper does audio, vision
 * for images), produces an image-description summary, then POSTs to the
 * cloud intake at /ingest/photo.
 *
 * The classifier's rule pass catches receipts/business cards. Everything
 * else flows to the photo specialist queue inside Beatrix.
 *
 * Same launchd pattern as voicememo.mjs.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR
  ?? join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Screenshots');
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR ?? join(homedir(), 'Downloads');
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), '.bridge', 'photo-watcher');
const INTAKE_URL = (process.env.INTAKE_URL ?? '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.INTAKE_ADMIN_TOKEN ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10);

if (!INTAKE_URL) {
  console.error('photo-watcher: INTAKE_URL not set; exiting');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('photo-watcher: OPENAI_API_KEY not set; cannot run vision');
  process.exit(1);
}

mkdirSync(STATE_DIR, { recursive: true });
const seenPath = join(STATE_DIR, 'seen.json');
const seen = existsSync(seenPath) ? new Set(JSON.parse(readFileSync(seenPath, 'utf-8'))) : new Set();

function saveSeen() {
  writeFileSync(seenPath, JSON.stringify([...seen]));
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp']);

function hashFile(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function visionDescribe(path) {
  const buf = readFileSync(path);
  const b64 = buf.toString('base64');
  const mime = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.heic': 'image/heic', '.webp': 'image/webp',
  }[extname(path).toLowerCase()] ?? 'image/png';

  const body = {
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image in 2-3 sentences. If it is a receipt, business card, or document, also extract the key text fields (vendor, amount, date, names, contact info). Be precise, not verbose.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    max_tokens: 500,
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`vision ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

async function postToIntake(payload) {
  const url = `${INTAKE_URL}/ingest/photo`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`intake POST ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function processFile(path, sourceDir) {
  console.log(`photo-watcher: processing ${basename(path)}`);
  try {
    const hash = hashFile(path);
    if (seen.has(hash)) {
      console.log(`  already processed (sha=${hash.slice(0, 8)}…)`);
      return;
    }
    const description = await visionDescribe(path);
    const st = statSync(path);
    const out = await postToIntake({
      filename: basename(path),
      sourceDir,
      takenAt: st.mtime.toISOString(),
      ocr: '',  // vision call now produces a unified description; pure-OCR could be added later
      visionSummary: description,
      fileHashSha256: hash,
    });
    console.log(`  ingested → ${out.outcome?.effective_action} (${out.classification?.suggested_route})`);
    seen.add(hash);
    saveSeen();
  } catch (e) {
    console.error(`  failed: ${e.message}`);
  }
}

async function scanDir(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const e of entries) {
    if (!IMAGE_EXT.has(extname(e).toLowerCase())) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (Date.now() - st.mtimeMs < 5000) continue; // still writing?
    await processFile(full, dir);
  }
}

async function scan() {
  await scanDir(SCREENSHOTS_DIR);
  await scanDir(DOWNLOADS_DIR);
}

console.log(`photo-watcher: starting (screenshots=${SCREENSHOTS_DIR}, downloads=${DOWNLOADS_DIR})`);
scan().catch((e) => console.error(`scan: ${e.message}`));
setInterval(() => {
  scan().catch((e) => console.error(`scan: ${e.message}`));
}, POLL_INTERVAL);

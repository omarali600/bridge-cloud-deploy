#!/usr/bin/env node
/**
 * Local Mac watcher for Apple Voice Memos.
 *
 * Runs on Omar's Mac (not in the cloud — the cloud can't see Apple's
 * voice memos folder). Watches the standard recordings dir, transcribes
 * new audio files via OpenAI Whisper, then POSTs the result to the cloud
 * intake service at /ingest/voice-memo.
 *
 * Run via launchd at ~/Library/LaunchAgents/com.omar.intake.voicememo.plist
 * (template at bottom of this file).
 *
 * ENV REQUIRED:
 *   INTAKE_URL                 base URL of the cloud intake (e.g., https://bridge-intake.onrender.com)
 *   INTAKE_ADMIN_TOKEN         admin token (for surface watchers)
 *   OPENAI_API_KEY             for Whisper transcription
 *
 * ENV OPTIONAL:
 *   VOICE_MEMOS_DIR            default: ~/Library/Application Support/com.apple.voicememos/Recordings
 *   STATE_DIR                  default: ~/.bridge/voice-memo-watcher
 */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const VOICE_MEMOS_DIR = process.env.VOICE_MEMOS_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'com.apple.voicememos', 'Recordings');
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), '.bridge', 'voice-memo-watcher');
const INTAKE_URL = (process.env.INTAKE_URL ?? '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.INTAKE_ADMIN_TOKEN ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS ?? '20000', 10);

if (!INTAKE_URL) {
  console.error('voicememo-watcher: INTAKE_URL not set; exiting');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('voicememo-watcher: OPENAI_API_KEY not set; cannot transcribe');
  process.exit(1);
}

mkdirSync(STATE_DIR, { recursive: true });
const seenPath = join(STATE_DIR, 'seen.json');
const seen = existsSync(seenPath) ? new Set(JSON.parse(readFileSync(seenPath, 'utf-8'))) : new Set();

function saveSeen() {
  writeFileSync(seenPath, JSON.stringify([...seen]));
}

const AUDIO_EXT = new Set(['.m4a', '.mp3', '.wav', '.aac', '.caf']);

function hashFile(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function transcribe(path) {
  const fileBuf = readFileSync(path);
  const fname = basename(path);

  // Multipart form-data
  const boundary = `----intake-${Date.now()}`;
  const lines = [];
  lines.push(`--${boundary}`);
  lines.push(`Content-Disposition: form-data; name="model"`);
  lines.push('');
  lines.push('whisper-1');
  lines.push(`--${boundary}`);
  lines.push(`Content-Disposition: form-data; name="file"; filename="${fname}"`);
  lines.push(`Content-Type: audio/mp4`);
  lines.push('');
  const head = Buffer.from(lines.join('\r\n') + '\r\n');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBuf, tail]);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`whisper ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  return j.text ?? '';
}

async function postToIntake(payload) {
  const url = `${INTAKE_URL}/ingest/voice-memo`;
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

async function processFile(path) {
  console.log(`voicememo-watcher: processing ${basename(path)}`);
  try {
    const hash = hashFile(path);
    if (seen.has(hash)) {
      console.log(`  already processed (sha=${hash.slice(0, 8)}…)`);
      return;
    }
    const transcript = await transcribe(path);
    const st = statSync(path);
    const out = await postToIntake({
      filename: basename(path),
      durationSec: null,  // could parse from metadata; left for now
      recordedAt: st.mtime.toISOString(),
      transcript,
      fileHashSha256: hash,
    });
    console.log(`  ingested → ${out.outcome?.effective_action} (${out.classification?.suggested_route})`);
    seen.add(hash);
    saveSeen();
  } catch (e) {
    console.error(`  failed: ${e.message}`);
  }
}

async function scan() {
  if (!existsSync(VOICE_MEMOS_DIR)) {
    console.error(`voicememo-watcher: ${VOICE_MEMOS_DIR} doesn't exist; waiting`);
    return;
  }
  const entries = readdirSync(VOICE_MEMOS_DIR);
  for (const e of entries) {
    if (!AUDIO_EXT.has(extname(e).toLowerCase())) continue;
    const full = join(VOICE_MEMOS_DIR, e);
    // Skip files modified in the last 5 seconds (could still be writing).
    const st = statSync(full);
    if (Date.now() - st.mtimeMs < 5000) continue;
    // Hash de-dupe is the strongest check; do it inside processFile.
    await processFile(full);
  }
}

console.log(`voicememo-watcher: starting (dir=${VOICE_MEMOS_DIR}, interval=${POLL_INTERVAL}ms)`);
scan().catch((e) => console.error(`scan: ${e.message}`));
setInterval(() => {
  scan().catch((e) => console.error(`scan: ${e.message}`));
}, POLL_INTERVAL);

/*
 launchd plist (~/Library/LaunchAgents/com.omar.intake.voicememo.plist):

 <?xml version="1.0" encoding="UTF-8"?>
 <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
 <plist version="1.0">
 <dict>
   <key>Label</key>           <string>com.omar.intake.voicememo</string>
   <key>ProgramArguments</key>
   <array>
     <string>/usr/bin/env</string>
     <string>node</string>
     <string>/Users/omar/.bridge-migration-2026-05-18/repo/bridge-cloud-deploy/intake/local-watchers/voicememo.mjs</string>
   </array>
   <key>RunAtLoad</key>       <true/>
   <key>KeepAlive</key>       <true/>
   <key>EnvironmentVariables</key>
   <dict>
     <key>INTAKE_URL</key>           <string>https://bridge-intake.onrender.com</string>
     <key>INTAKE_ADMIN_TOKEN</key>   <string>...</string>
     <key>OPENAI_API_KEY</key>       <string>...</string>
   </dict>
   <key>StandardOutPath</key>  <string>/tmp/intake-voicememo.log</string>
   <key>StandardErrorPath</key><string>/tmp/intake-voicememo.err.log</string>
 </dict>
 </plist>
*/

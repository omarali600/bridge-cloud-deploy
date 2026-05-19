#!/usr/bin/env node
/**
 * bridge-relay (cloud) — multi-channel phone surface for BRIDGE.
 *
 * Channels in this build:
 *   • Telegram (live)       — long-polling, replies on the same thread
 *   • WhatsApp (scaffolded) — Baileys linked-device + /admin/pair QR endpoint
 *   • Voice (scaffolded)    — Twilio webhook handlers (separate service for v1)
 *
 * All channels converge on a single routing+invocation pipeline:
 *   incoming message  →  classify intent (gpt-4o-mini)  →  invoke cloud agent
 *   (Beatrix or Clem on bridge-openclaw) →  emit reply on the same channel.
 *
 * Designed to run on Render (eu-west-1 to co-locate with Supabase).
 * Persistent state lives at /opt/data:
 *   /opt/data/identity/            bridge-service Ed25519 keys (from env at boot)
 *   /opt/data/sessions.json        sticky session keys per agent
 *   /opt/data/telegram-offset.txt  resume point for the Telegram long-poll
 *   /opt/data/whatsapp/            Baileys session state
 *
 * Plain-English everywhere user-facing (see feedback_plain_english_only).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startTelegramChannel } from './channels/telegram.mjs';
import { initWhatsapp } from './channels/whatsapp.mjs';
import { startHttpServer } from './http.mjs';
import { initRouting } from './routing.mjs';
import { initAgentClient } from './agents.mjs';
import { initIntake } from './intake-client.mjs';
import { log } from './log.mjs';

// ───── identity bootstrap ─────
// bridge-service Ed25519 keys are injected via env (base64) so the public
// github seed never carries them. At boot we materialize them into
// /opt/data/identity/ and point openclaw at that profile dir.

const STATE_DIR = process.env.STATE_DIR ?? '/opt/data';
const IDENTITY_DIR = `${STATE_DIR}/identity`;
mkdirSync(IDENTITY_DIR, { recursive: true });

function writeFromEnv(envKey, filename, mode = 0o600) {
  const b64 = process.env[envKey];
  if (!b64) {
    log(`WARN: env ${envKey} not set; ${filename} not written`);
    return;
  }
  const path = `${IDENTITY_DIR}/${filename}`;
  writeFileSync(path, Buffer.from(b64, 'base64'));
  try { writeFileSync(path, readFileSync(path), { mode }); } catch {}
  log(`materialized ${filename} (from env ${envKey})`);
}

writeFromEnv('BRIDGE_SERVICE_DEVICE_JSON_B64', 'device.json');
writeFromEnv('BRIDGE_SERVICE_DEVICE_AUTH_JSON_B64', 'device-auth.json');

// Minimal openclaw config pointing at the cloud gateway. Profile name is
// "bridge-service" so the existing identity files map cleanly.
const OPENCLAW_PROFILE_DIR = process.env.OPENCLAW_PROFILE_DIR ?? STATE_DIR;
const OC_CONFIG = `${OPENCLAW_PROFILE_DIR}/openclaw.json`;
const GATEWAY_URL = process.env.BRIDGE_GATEWAY_URL ?? 'wss://bridge-openclaw.onrender.com';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';

if (!existsSync(OC_CONFIG)) {
  writeFileSync(
    OC_CONFIG,
    JSON.stringify(
      {
        agents: { list: [] },
        gateway: {
          mode: 'remote',
          remote: { url: GATEWAY_URL, token: GATEWAY_TOKEN },
          auth: { mode: 'token', token: '' },
        },
        session: { dmScope: 'per-channel-peer' },
        wizard: { lastRunAt: '2026-05-19T00:00:00.000Z', lastRunVersion: '2026.4.12', lastRunCommand: 'skip', lastRunMode: 'remote' },
      },
      null,
      2,
    ),
  );
  log(`wrote ${OC_CONFIG}`);
}

// ───── boot ─────

initRouting({ openrouterKey: process.env.OPENROUTER_API_KEY });
initAgentClient({
  profileDir: OPENCLAW_PROFILE_DIR,
  gatewayUrl: GATEWAY_URL,
  gatewayToken: GATEWAY_TOKEN,
  stateDir: STATE_DIR,
});
initIntake({
  intakeUrl: process.env.INTAKE_URL,
  adminToken: process.env.INTAKE_ADMIN_TOKEN,
});

const httpPort = Number(process.env.PORT ?? 8080);
startHttpServer({ port: httpPort });

if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  startTelegramChannel({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    stateDir: STATE_DIR,
  });
} else {
  log('Telegram: missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, channel disabled');
}

// WhatsApp via Twilio — inbound goes to /whatsapp/incoming, replies via
// Twilio API. Ready as soon as TWILIO_ACCOUNT_SID/AUTH_TOKEN/
// WHATSAPP_FROM env vars are set + Twilio's webhook config points here.
initWhatsapp();

// Voice (Twilio) handlers live inside the HTTP server (/voice/* routes).
// They're always wired; Twilio just won't hit them until you point its
// webhook config at this service's public URL.

log('bridge-relay boot complete');

// Keep the process alive (channels and HTTP server hold their own work).
process.on('SIGTERM', () => { log('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT received'); process.exit(0); });
await new Promise(() => {}); // never resolves; channels/http own the lifecycle

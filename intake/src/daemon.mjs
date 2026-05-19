#!/usr/bin/env node
/**
 * bridge-intake — Bridget's intake engine. Capability #22 from the BRIDGE
 * canvas. The membrane between every inbound surface (email, Telegram,
 * WhatsApp, voice memos, photos, calendar, Drive, SharePoint) and Omar's
 * inner agents (Beatrix, Clem).
 *
 * Long-running Node daemon. Long-poll surface watchers run in-process;
 * webhook-based surfaces hit the HTTP server.
 *
 * Architecture in plain English:
 *   1. Surface adapters normalize every inbound into a standard intake item.
 *   2. Classifier (Claude Sonnet 4.5 + rule pre-pass) tags urgency, domain,
 *      entities, suggested route, action.
 *   3. Action thresholds apply per surface × principal.
 *   4. Router dispatches: Beatrix, Clem, brain, or Omar-direct via Telegram.
 *   5. Every step logs to the audit trail (capability #92 substrate).
 *
 * State persists at /opt/data/intake/:
 *   audit.jsonl           — every classification + routing decision
 *   thresholds.json       — action thresholds (live-tunable via /admin)
 *   sessions.json         — sticky OpenClaw sessions for Beatrix + Clem
 *   oauth/gmail.json      — Google OAuth tokens (shared by email/calendar/drive)
 *
 * Plain English everywhere user-facing — no command names, no file paths,
 * no surface internals leaked into messages Omar reads.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { startHttpServer } from './http.mjs';
import { initClassifier } from './classifier/index.mjs';
import { initRouter } from './routing/router.mjs';
import { initAgentClient } from './routing/agents.mjs';
import { initBrainClient } from './routing/brain.mjs';
import { initOmarChannel } from './routing/omar.mjs';
import { initThresholds } from './routing/thresholds.mjs';
import { initAudit } from './audit/index.mjs';
import { initEmail } from './surfaces/email.mjs';
import { initCalendar } from './surfaces/calendar.mjs';
import { initDrive } from './surfaces/drive.mjs';
import { initSharepoint } from './surfaces/sharepoint.mjs';
import { log } from './log.mjs';

// ─── state dir + identity ───

const STATE_DIR = process.env.STATE_DIR ?? '/opt/data';
const IDENTITY_DIR = `${STATE_DIR}/identity`;
mkdirSync(IDENTITY_DIR, { recursive: true });
mkdirSync(`${STATE_DIR}/intake`, { recursive: true });

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

// OpenClaw config pointing at the cloud gateway.
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
        wizard: { lastRunAt: '2026-05-20T00:00:00.000Z', lastRunVersion: '2026.4.12', lastRunCommand: 'skip', lastRunMode: 'remote' },
      },
      null,
      2,
    ),
  );
  log(`wrote ${OC_CONFIG}`);
}

// ─── init substrate ───

initAudit({ stateDir: STATE_DIR });
initThresholds({ stateDir: STATE_DIR });

initClassifier({
  apiKey: process.env.ANTHROPIC_API_KEY,
  primaryModel: process.env.CLASSIFIER_PRIMARY_MODEL,
  fallbackModel: process.env.CLASSIFIER_FALLBACK_MODEL,
});

initRouter({ liveRouting: process.env.INTAKE_LIVE_ROUTING !== '0' });
initAgentClient({
  profileDir: OPENCLAW_PROFILE_DIR,
  gatewayUrl: GATEWAY_URL,
  gatewayToken: GATEWAY_TOKEN,
  stateDir: STATE_DIR,
});
initBrainClient({
  httpUrl: process.env.GBRAIN_HTTP_URL,
  httpToken: process.env.GBRAIN_HTTP_TOKEN,
});
initOmarChannel({
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
});

// ─── init surface watchers ───

const GOOGLE_REDIRECT = process.env.GOOGLE_OAUTH_REDIRECT_URI
  ?? `https://${process.env.RENDER_EXTERNAL_HOSTNAME ?? 'bridge-intake.onrender.com'}/admin/oauth/google/callback`;

initEmail({
  stateDir: STATE_DIR,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: GOOGLE_REDIRECT,
});
initCalendar({
  stateDir: STATE_DIR,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: GOOGLE_REDIRECT,
});
initDrive({
  stateDir: STATE_DIR,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: GOOGLE_REDIRECT,
});
initSharepoint({});

// ─── HTTP server ───

const httpPort = Number(process.env.PORT ?? 8080);
startHttpServer({ port: httpPort, adminToken: process.env.ADMIN_TOKEN });

log('bridge-intake boot complete');

// ─── lifecycle ───

process.on('SIGTERM', () => { log('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT received'); process.exit(0); });
process.on('uncaughtException', (e) => log(`uncaughtException: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.message || e}`));

await new Promise(() => {}); // run forever

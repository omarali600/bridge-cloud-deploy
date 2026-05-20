/**
 * Email (Gmail) surface adapter.
 *
 * Two modes:
 *   1. Push (preferred): Gmail watch() registers a Pub/Sub topic, GCP pushes
 *      to /push/email when new mail arrives. Sub-second latency.
 *   2. Polling (fallback): 60s history.list() against the user's mailbox.
 *      No GCP setup required, just OAuth refresh tokens.
 *
 * OAuth: refresh tokens persist to /opt/data/oauth/gmail.json. First-run
 * requires Omar to click through the consent screen (60s flow). After that,
 * refresh tokens auto-renew indefinitely.
 *
 * Status: code ready end-to-end. Blocked on Omar completing the OAuth click.
 * The /admin/oauth/google/start endpoint returns a URL he taps; the
 * /admin/oauth/google/callback handles the redirect and persists tokens.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { google } from 'googleapis';
import { ingest } from '../pipeline.mjs';
import { log } from '../log.mjs';

// Multi-account state. Keyed by account label (e.g. 'primary', 'crrem', 'ampersand').
// The first imported token uses label='primary' for backward compatibility.
const accounts = new Map(); // label -> { oauth2Client, tokenPath, lastHistoryId, pollTimer, email }
let stateDir = '/opt/data';
let googleClientId = null;
let googleClientSecret = null;
let redirectUri = null;

function tokenPathFor(label) {
  return label === 'primary'
    ? `${stateDir}/oauth/gmail.json`
    : `${stateDir}/oauth/gmail-${label}.json`;
}

function buildClient() {
  return new google.auth.OAuth2(googleClientId, googleClientSecret, redirectUri);
}

function attachClient(label, email, tokens) {
  const oauth2Client = buildClient();
  oauth2Client.setCredentials(tokens);
  const tokenPath = tokenPathFor(label);
  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
  });
  accounts.set(label, { oauth2Client, tokenPath, lastHistoryId: null, pollTimer: null, email });
  startPolling(label);
}

export function initEmail({ stateDir: sd, googleClientId: cid, googleClientSecret: csec, redirectUri: ruri }) {
  stateDir = sd;
  googleClientId = cid;
  googleClientSecret = csec;
  redirectUri = ruri;
  mkdirSync(`${stateDir}/oauth`, { recursive: true });

  if (!googleClientId || !googleClientSecret) {
    log('email: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing; email adapter idle');
    return false;
  }

  // Load all persisted accounts: gmail.json + gmail-*.json.
  let loaded = 0;
  try {
    const files = readdirSync(`${stateDir}/oauth`).filter((f) => f === 'gmail.json' || /^gmail-[\w.@-]+\.json$/.test(f));
    for (const f of files) {
      const label = f === 'gmail.json' ? 'primary' : f.replace(/^gmail-/, '').replace(/\.json$/, '');
      try {
        const tokens = JSON.parse(readFileSync(`${stateDir}/oauth/${f}`, 'utf-8'));
        const email = tokens._email || 'unknown';
        attachClient(label, email, tokens);
        loaded++;
        log(`email: loaded account ${label} (${email})`);
      } catch (e) {
        log(`email: failed to load ${f}: ${e.message}`);
      }
    }
  } catch {
    // oauth dir empty or unreadable
  }

  if (loaded === 0) {
    log('email: no accounts yet; awaiting OAuth import or click');
  } else {
    log(`email: ${loaded} account(s) active, polling`);
  }
  return loaded > 0;
}

/**
 * Return the URL Omar taps to authorize Gmail access. Used by /admin/oauth/google/start.
 */
export function authUrl() {
  if (!googleClientId) throw new Error('email adapter not initialized');
  const tempClient = buildClient();
  return tempClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

/**
 * Exchange the OAuth code for tokens, persist, start polling.
 * Stores as 'primary' account if no accounts exist; otherwise appends.
 */
export async function handleOAuthCallback(code) {
  if (!googleClientId) throw new Error('email adapter not initialized');
  const tempClient = buildClient();
  const { tokens } = await tempClient.getToken(code);
  const label = accounts.size === 0 ? 'primary' : `acct${accounts.size}`;
  tokens._email = 'unknown';  // we don't have the email from the code exchange
  const tokenPath = tokenPathFor(label);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  attachClient(label, 'unknown', tokens);
  log(`email: OAuth complete for ${label}, tokens persisted, polling`);
  return { ok: true, label };
}

/**
 * Import a refresh token obtained out-of-band (e.g. via a desktop-app OAuth
 * flow on Omar's Mac). Persists the token under the given email/label and starts polling.
 *
 * Body: { refresh_token, email?, label?, scope?, token_type? }
 * - email: the Gmail address (e.g. omarali600@gmail.com). Used for the file label.
 * - label: optional explicit label (e.g. 'primary', 'crrem'). Overrides email-derived.
 */
export async function importRefreshToken({ refresh_token, email, label, scope, token_type }) {
  if (!googleClientId) throw new Error('email adapter not initialized');
  if (!refresh_token) throw new Error('refresh_token required');

  // Derive label: explicit > email-slug > primary-if-empty > acctN.
  let resolvedLabel = label;
  if (!resolvedLabel && email) {
    resolvedLabel = email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  }
  if (!resolvedLabel) {
    resolvedLabel = accounts.size === 0 ? 'primary' : `acct${accounts.size}`;
  }

  const tokens = {
    refresh_token,
    scope: scope || [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ].join(' '),
    token_type: token_type || 'Bearer',
    expiry_date: 1,
    _email: email || 'unknown',
  };
  const tokenPath = tokenPathFor(resolvedLabel);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  attachClient(resolvedLabel, email || 'unknown', tokens);
  log(`email: refresh token imported for ${resolvedLabel} (${email || 'unknown'}), polling`);
  return {
    ok: true,
    label: resolvedLabel,
    email: email || 'unknown',
    accounts_active: accounts.size,
    message: `Gmail / Calendar / Drive connected for ${email || resolvedLabel}.`,
  };
}

/**
 * List active accounts. Used by /admin/oauth/google/accounts.
 */
export function listAccounts() {
  return Array.from(accounts.entries()).map(([label, a]) => ({
    label,
    email: a.email,
    polling: !!a.pollTimer,
  }));
}

/**
 * Start the 60s polling loop for a specific account.
 */
function startPolling(label) {
  const a = accounts.get(label);
  if (!a || a.pollTimer) return;
  pollOnce(label).catch((e) => log(`email[${label}]: initial poll failed: ${e.message}`));
  a.pollTimer = setInterval(() => {
    pollOnce(label).catch((e) => log(`email[${label}]: poll failed: ${e.message}`));
  }, 60_000);
  log(`email[${label}]: polling every 60s`);
}

async function pollOnce(label) {
  const a = accounts.get(label);
  if (!a) return;
  const gmail = google.gmail({ version: 'v1', auth: a.oauth2Client });

  if (!a.lastHistoryId) {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    a.lastHistoryId = profile.data.historyId;
    if (a.email === 'unknown' && profile.data.emailAddress) {
      a.email = profile.data.emailAddress;
      // Persist the discovered email back to the token file.
      try {
        const tokens = JSON.parse(readFileSync(a.tokenPath, 'utf-8'));
        tokens._email = a.email;
        writeFileSync(a.tokenPath, JSON.stringify(tokens, null, 2));
      } catch { /* non-fatal */ }
    }
    log(`email[${label}] (${a.email}): baseline historyId=${a.lastHistoryId}`);
    return;
  }

  let history;
  try {
    history = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: a.lastHistoryId,
      historyTypes: ['messageAdded'],
    });
  } catch (e) {
    if (e.code === 404 || /no longer valid/i.test(e.message)) {
      log(`email[${label}]: historyId expired, re-baselining`);
      const profile = await gmail.users.getProfile({ userId: 'me' });
      a.lastHistoryId = profile.data.historyId;
      return;
    }
    throw e;
  }

  const newMessageIds = new Set();
  for (const h of history.data.history ?? []) {
    for (const ma of h.messagesAdded ?? []) {
      if (ma.message?.id) newMessageIds.add(ma.message.id);
    }
  }
  if (history.data.historyId) a.lastHistoryId = history.data.historyId;

  if (newMessageIds.size === 0) return;
  log(`email[${label}]: ${newMessageIds.size} new message(s)`);

  for (const id of newMessageIds) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const item = normalize(msg.data);
      item.from.account_label = label;
      item.from.account_email = a.email;
      await ingest(item);
    } catch (e) {
      log(`email[${label}]: failed to handle message ${id}: ${e.message}`);
    }
  }
}

/**
 * Push handler — kicks off a poll across all accounts.
 */
export async function handlePush(body) {
  if (accounts.size === 0) return { ok: false, reason: 'email adapter not initialized' };
  for (const label of accounts.keys()) {
    pollOnce(label).catch((e) => log(`email[${label}]: push-triggered poll failed: ${e.message}`));
  }
  return { ok: true, accounts: accounts.size };
}

/**
 * Normalize a Gmail message into an intake item.
 */
export function normalize(message) {
  const headers = Object.fromEntries(
    (message.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  const from = headers.from ?? 'unknown';
  const subject = headers.subject ?? '(no subject)';
  const dateStr = headers.date ?? new Date().toUTCString();
  const text = extractText(message.payload);

  // Parse "Name <email@example.com>" into display + identifier.
  const m = from.match(/^"?([^"<]*?)"?\s*<(.+)>$/);
  const display = m ? m[1].trim() || m[2] : from;
  const email = m ? m[2] : from;

  return {
    surface: 'email',
    receivedAt: new Date(dateStr).toISOString(),
    from: {
      identifier: email,
      display,
      kind: 'contact',
    },
    content: {
      subject,
      text,
      rawSurfaceMetadata: {
        gmail_message_id: message.id,
        thread_id: message.threadId,
        labels: message.labelIds ?? [],
        headers,
      },
    },
    hints: {
      suspectedDomain: detectDomain(headers, subject, text),
    },
  };
}

function extractText(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    // Prefer text/plain, fall back to text/html stripped.
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, 'base64url').toString('utf-8');
    }
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return Buffer.from(html.body.data, 'base64url').toString('utf-8')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Recurse into multipart.
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  return '';
}

function detectDomain(headers, subject, text) {
  const blob = `${headers.from ?? ''} ${headers.to ?? ''} ${subject} ${text.slice(0, 500)}`.toLowerCase();
  if (blob.includes('crrem') || blob.includes('@crrem.org')) return 'crrem';
  return null;
}

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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { google } from 'googleapis';
import { ingest } from '../pipeline.mjs';
import { log } from '../log.mjs';

let oauth2Client = null;
let tokenPath = null;
let lastHistoryId = null;
let pollTimer = null;
let stateDir = '/opt/data';

export function initEmail({ stateDir: sd, googleClientId, googleClientSecret, redirectUri }) {
  stateDir = sd;
  tokenPath = `${stateDir}/oauth/gmail.json`;
  mkdirSync(dirname(tokenPath), { recursive: true });

  if (!googleClientId || !googleClientSecret) {
    log('email: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing; email adapter idle');
    return false;
  }

  oauth2Client = new google.auth.OAuth2(
    googleClientId,
    googleClientSecret,
    redirectUri,
  );

  // Try to load persisted tokens.
  if (existsSync(tokenPath)) {
    try {
      const tokens = JSON.parse(readFileSync(tokenPath, 'utf-8'));
      oauth2Client.setCredentials(tokens);
      // Persist refreshed access tokens automatically.
      oauth2Client.on('tokens', (newTokens) => {
        const merged = { ...tokens, ...newTokens };
        writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
        log('email: refreshed access token, persisted');
      });
      log('email: loaded OAuth tokens, ready to poll');
      startPolling();
      return true;
    } catch (e) {
      log(`email: failed to load tokens (${e.message}); awaiting OAuth click`);
    }
  } else {
    log('email: no tokens yet; Omar needs to complete /admin/oauth/google/start');
  }
  return false;
}

/**
 * Return the URL Omar taps to authorize Gmail access. Used by /admin/oauth/google/start.
 */
export function authUrl() {
  if (!oauth2Client) throw new Error('email adapter not initialized');
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',  // forces refresh_token in the response
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',     // marking read, labels
      'https://www.googleapis.com/auth/calendar.readonly', // calendar adapter piggy-backs
      'https://www.googleapis.com/auth/drive.readonly',    // drive adapter piggy-backs
    ],
  });
}

/**
 * Exchange the OAuth code for tokens, persist, start polling.
 */
export async function handleOAuthCallback(code) {
  if (!oauth2Client) throw new Error('email adapter not initialized');
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  log('email: OAuth complete, tokens persisted, starting poll');
  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
  });
  startPolling();
  return { ok: true };
}

/**
 * Import a refresh token obtained out-of-band (e.g. via a desktop-app OAuth
 * flow on Omar's Mac). Persists the token and starts polling. Same code path
 * as handleOAuthCallback once tokens are loaded.
 */
export async function importRefreshToken({ refresh_token, scope, token_type }) {
  if (!oauth2Client) throw new Error('email adapter not initialized');
  if (!refresh_token) throw new Error('refresh_token required');
  const tokens = {
    refresh_token,
    scope: scope || [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ].join(' '),
    token_type: token_type || 'Bearer',
    // expiry_date=1 forces google-auth-library to refresh on the first call,
    // which mints a fresh access_token + persists it via the 'tokens' listener.
    expiry_date: 1,
  };
  oauth2Client.setCredentials(tokens);
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  log('email: refresh token imported, persisted, starting poll');
  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
  });
  startPolling();
  return { ok: true, message: 'Refresh token imported. Gmail / Calendar / Drive polling started.' };
}

/**
 * Start the 60s polling loop. Uses Gmail's history.list to detect new
 * messages since the last seen historyId. The first run takes a baseline
 * from the latest message's historyId so we don't replay the entire inbox.
 */
function startPolling() {
  if (pollTimer) return;
  pollOnce().catch((e) => log(`email: initial poll failed: ${e.message}`));
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => log(`email: poll failed: ${e.message}`));
  }, 60_000);
  log('email: polling every 60s');
}

async function pollOnce() {
  if (!oauth2Client) return;
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // First run: take a baseline historyId. Don't replay the entire inbox.
  if (!lastHistoryId) {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    lastHistoryId = profile.data.historyId;
    log(`email: baseline historyId=${lastHistoryId}`);
    return;
  }

  let history;
  try {
    history = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: lastHistoryId,
      historyTypes: ['messageAdded'],
    });
  } catch (e) {
    // 404 with "historyId no longer valid" means our baseline is too old;
    // re-baseline.
    if (e.code === 404 || /no longer valid/i.test(e.message)) {
      log('email: historyId expired, re-baselining');
      const profile = await gmail.users.getProfile({ userId: 'me' });
      lastHistoryId = profile.data.historyId;
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
  if (history.data.historyId) lastHistoryId = history.data.historyId;

  if (newMessageIds.size === 0) return;
  log(`email: ${newMessageIds.size} new message(s)`);

  for (const id of newMessageIds) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const item = normalize(msg.data);
      await ingest(item);
    } catch (e) {
      log(`email: failed to handle message ${id}: ${e.message}`);
    }
  }
}

/**
 * Push handler — called when GCP Pub/Sub delivers a Gmail change notification.
 * Body is { message: { data: base64(JSON{ historyId, emailAddress }) } }.
 */
export async function handlePush(body) {
  if (!oauth2Client) return { ok: false, reason: 'email adapter not initialized' };
  // Pub/Sub messages tell us "something changed" but we still need to call
  // history.list to find out what. So the push handler just kicks off a poll.
  await pollOnce();
  return { ok: true };
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

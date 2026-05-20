/**
 * HTTP server. All endpoints:
 *
 *   GET  /health                         liveness probe
 *   GET  /metrics                        counts + rates
 *   POST /ingest/telegram                relay forwards Telegram messages
 *   POST /ingest/whatsapp                relay forwards WhatsApp via Twilio
 *   POST /ingest/voice-memo              local watcher posts voice memo events
 *   POST /ingest/photo                   local watcher posts photo events
 *   POST /ingest/admin-test              dry-run an arbitrary intake item
 *   POST /push/email                     Gmail Pub/Sub push handler
 *   GET  /admin/oauth/google/start       returns the Google OAuth URL
 *   GET  /admin/oauth/google/callback    OAuth redirect target
 *   GET  /admin/threshold                read action thresholds
 *   POST /admin/threshold                update action thresholds
 *   POST /admin/test                     classify+route a sample without acting
 *   GET  /admin/audit                    recent audit events
 *
 * Admin endpoints (except oauth/google/callback) require ?token=ADMIN_TOKEN
 * or Authorization: Bearer ADMIN_TOKEN.
 *
 * The relay forwards channel events as POST JSON; surface adapters know how
 * to normalize from each shape.
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as telegramSurface from './surfaces/telegram.mjs';
import * as whatsappSurface from './surfaces/whatsapp.mjs';
import * as voiceSurface from './surfaces/voicememo.mjs';
import * as photoSurface from './surfaces/photo.mjs';
import * as emailSurface from './surfaces/email.mjs';
import { ingest } from './pipeline.mjs';
import { classify } from './classifier/index.mjs';
import { decide } from './routing/thresholds.mjs';
import * as thresholds from './routing/thresholds.mjs';
import { audit } from './audit/index.mjs';
import { metrics } from './metrics.mjs';
import { log } from './log.mjs';

let adminToken = '';

export function startHttpServer({ port, adminToken: at }) {
  adminToken = at ?? process.env.ADMIN_TOKEN ?? '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      // ─── public ───
      if (path === '/health' && req.method === 'GET') return health(res);
      if (path === '/metrics' && req.method === 'GET') return sendMetrics(res);

      // ─── dashboard (turnkey) ───
      if (path === '/dashboard' && req.method === 'GET') {
        return serveDashboard(req, res, url);
      }
      if (path === '/dashboard/data' && req.method === 'GET') {
        return serveDashboardData(req, res, url);
      }
      if (path === '/dashboard/coordinates.md' && req.method === 'GET') {
        return serveStaticFile(res, 'omar-coordinates-2026-05-19.md', 'text/markdown; charset=utf-8');
      }
      if (path === '/dashboard/coordinates-map.html' && req.method === 'GET') {
        return serveStaticFile(res, 'coordinates-map.html', 'text/html; charset=utf-8');
      }

      // ─── ingest endpoints ───
      if (path === '/ingest/telegram' && req.method === 'POST') {
        return handleIngest(req, res, async (body) => telegramSurface.handle(body));
      }
      if (path === '/ingest/whatsapp' && req.method === 'POST') {
        return handleIngest(req, res, async (body) => {
          // Body could be form-encoded (Twilio) or JSON (relay). Support both.
          const params = typeof body === 'string' ? Object.fromEntries(new URLSearchParams(body)) : body;
          return whatsappSurface.handle(params);
        });
      }
      if (path === '/ingest/voice-memo' && req.method === 'POST') {
        return handleIngest(req, res, async (body) => voiceSurface.handle(body));
      }
      if (path === '/ingest/photo' && req.method === 'POST') {
        return handleIngest(req, res, async (body) => photoSurface.handle(body));
      }
      if (path === '/ingest/admin-test' && req.method === 'POST') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        return handleIngest(req, res, async (body) => ingest({ ...body, surface: body.surface ?? 'admin-test' }));
      }

      // ─── push handlers ───
      if (path === '/push/email' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const out = await emailSurface.handlePush(body);
        return sendJson(res, 200, out);
      }

      // ─── admin: OAuth ───
      if (path === '/admin/oauth/google/start' && req.method === 'GET') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        try {
          const authUrl = emailSurface.authUrl();
          return sendJson(res, 200, { authUrl });
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }
      if (path === '/admin/oauth/google/callback' && req.method === 'GET') {
        // No admin token check here — this is Google's redirect. State protects.
        const code = url.searchParams.get('code');
        if (!code) return sendJson(res, 400, { error: 'missing code' });
        try {
          const out = await emailSurface.handleOAuthCallback(code);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Email + Calendar + Drive connected.</h1><p>You can close this tab. Bridget will start watching your inbox.</p>');
          return;
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }
      if (path === '/admin/oauth/google/accounts' && req.method === 'GET') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        return sendJson(res, 200, { accounts: emailSurface.listAccounts() });
      }
      if (path === '/admin/oauth/google/import' && req.method === 'POST') {
        // Import a pre-obtained refresh token (e.g. from a local desktop-app OAuth flow).
        // Lets us activate Gmail/Calendar/Drive without the cloud-redirect dance.
        if (!checkAdmin(req, url)) return unauthorized(res);
        const body = await readJsonBody(req);
        if (!body.refresh_token) return sendJson(res, 400, { error: 'refresh_token required' });
        try {
          const out = await emailSurface.importRefreshToken(body);
          return sendJson(res, 200, out);
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }

      // ─── admin: thresholds ───
      if (path === '/admin/threshold' && req.method === 'GET') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        return sendJson(res, 200, thresholds.get());
      }
      if (path === '/admin/threshold' && req.method === 'POST') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        const body = await readJsonBody(req);
        const updated = thresholds.update(body);
        audit.log({ action: 'threshold-change', target: null, reasoning: 'Admin updated action thresholds.', data: { patch: body } });
        return sendJson(res, 200, updated);
      }

      // ─── admin: test ───
      if (path === '/admin/test' && req.method === 'POST') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        const body = await readJsonBody(req);
        // Run the classifier WITHOUT routing. Compute what the router would
        // do, but don't actually call agents/brain/Omar.
        const item = {
          id: `test-${Date.now()}`,
          receivedAt: new Date().toISOString(),
          surface: body.surface ?? 'admin-test',
          from: body.from ?? { identifier: 'test', display: 'test', kind: 'self' },
          content: body.content ?? {},
          hints: body.hints ?? {},
        };
        const classification = await classify(item);
        const decision = decide(item.surface, classification);
        audit.log({ action: 'admin-test', target: classification.suggested_route, reasoning: classification.reasoning_summary, data: { item, classification, decision } });
        return sendJson(res, 200, { item, classification, decision });
      }

      // ─── admin: audit ───
      if (path === '/admin/audit' && req.method === 'GET') {
        if (!checkAdmin(req, url)) return unauthorized(res);
        const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
        const since = url.searchParams.get('since');
        return sendJson(res, 200, { events: audit.recent({ limit, since }) });
      }

      // 404
      sendJson(res, 404, { error: 'not found', path });
    } catch (e) {
      log(`http: handler error: ${e.message}`);
      sendJson(res, 500, { error: e.message });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log(`HTTP server listening on :${port}`);
  });
  return server;
}

// ─── helpers ───

function health(res) {
  sendJson(res, 200, {
    ok: true,
    ts: new Date().toISOString(),
    service: 'bridge-intake',
    version: '0.1.0',
    surfaces: {
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
      whatsapp: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      email: !!process.env.GOOGLE_CLIENT_ID,
      calendar: !!process.env.GOOGLE_CLIENT_ID,
      drive: !!process.env.GOOGLE_CLIENT_ID,
      sharepoint: !!process.env.MICROSOFT_TENANT_ID,
      'voice-memo': true,    // always accept inbound from local watchers
      photo: true,
    },
    live_routing: process.env.INTAKE_LIVE_ROUTING !== '0',
  });
}

function sendMetrics(res) {
  sendJson(res, 200, metrics.snapshot());
}

async function handleIngest(req, res, handler) {
  const startTs = Date.now();
  const body = await readJsonOrFormBody(req);
  metrics.incr('inbound', 1);
  metrics.incr(`inbound.${body.surface ?? 'unknown'}`, 1);

  try {
    const out = await handler(body);
    metrics.observe('latency_ms', Date.now() - startTs);
    metrics.incr(`route.${out.outcome?.effective_action ?? 'unknown'}`, 1);
    metrics.incr(`target.${out.outcome?.target ?? 'none'}`, 1);
    return sendJson(res, 200, out);
  } catch (e) {
    log(`ingest: handler failed: ${e.message}`);
    metrics.incr('errors', 1);
    return sendJson(res, 500, { error: e.message });
  }
}

function checkAdmin(req, url) {
  if (!adminToken) return false;
  const queryTok = url.searchParams.get('token');
  if (queryTok && queryTok === adminToken) return true;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && auth.slice(7) === adminToken) return true;
  // Cookie-based session (set after first ?key= visit on /dashboard)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.bridge_admin === adminToken) return true;
  return false;
}

function parseCookies(header) {
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// ─── dashboard helpers ───

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolvePath(__dirname, '..', 'public');

function serveStaticFile(res, name, contentType) {
  const full = resolvePath(DASHBOARD_DIR, name);
  if (!existsSync(full)) {
    return sendJson(res, 404, { error: `static ${name} missing` });
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  res.end(readFileSync(full));
}

function serveDashboard(req, res, url) {
  // Magic-link: visit /dashboard?key=<adminToken> once to set the cookie.
  // Subsequent visits are cookie-authenticated.
  const cookies = parseCookies(req.headers.cookie);
  const keyParam = url.searchParams.get('key');

  let authed = false;
  let setCookie = null;

  if (keyParam && keyParam === adminToken) {
    authed = true;
    // 30-day cookie, httpOnly, secure (Render is HTTPS)
    setCookie = `bridge_admin=${encodeURIComponent(adminToken)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
    // Strip the key from URL by redirecting once
    res.writeHead(302, {
      'Set-Cookie': setCookie,
      'Location': '/dashboard',
    });
    return res.end();
  }

  if (cookies.bridge_admin === adminToken) {
    authed = true;
  }

  if (!authed) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset=utf-8><title>Bridge — unauthorized</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#1c1d20;line-height:1.5}h1{font-size:24px;margin-bottom:8px}code{background:#ebe3cf;padding:2px 6px;border-radius:2px;font-size:14px}</style></head><body><h1>Bridge — first-time setup</h1><p>This page is private. Visit it once with your one-time setup key in the URL:</p><pre><code>/dashboard?key=YOUR-ADMIN-TOKEN</code></pre><p>After that, the page remembers you for 30 days. No tokens in the URL.</p></body></html>`);
  }

  return serveStaticFile(res, 'dashboard.html', 'text/html; charset=utf-8');
}

async function serveDashboardData(req, res, url) {
  if (!checkAdmin(req, url)) return unauthorized(res);

  // Server-side aggregation — no admin token needed in browser.
  const result = {
    timestamp: new Date().toISOString(),
    services: {},
    surfaces: {},
    accounts: [],
    audit_recent: [],
  };

  // Service health: same-origin self-check + sibling Render services
  const sibling = {
    intake: 'https://bridge-intake.onrender.com/health',
    brain: 'https://bridge-gbrain-http.onrender.com/health',
    relay: 'https://bridge-relay-hdmy.onrender.com/health',
    voice: 'https://bridge-voice-mleh.onrender.com/health',
  };
  await Promise.all(Object.entries(sibling).map(async ([name, healthUrl]) => {
    try {
      const r = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
      result.services[name] = { ok: r.ok };
      if (name === 'intake' && r.ok) {
        const body = await r.json().catch(() => ({}));
        if (body.surfaces) result.surfaces = body.surfaces;
      }
    } catch {
      result.services[name] = { ok: false };
    }
  }));

  // Connected accounts (server-side — no token needed in browser)
  try {
    result.accounts = emailSurface.listAccounts();
  } catch {
    result.accounts = [];
  }

  // Recent audit (last 10)
  try {
    result.audit_recent = audit.recent({ limit: 10 });
  } catch {
    result.audit_recent = [];
  }

  return sendJson(res, 200, result);
}

function unauthorized(res) {
  return sendJson(res, 401, { error: 'unauthorized — supply admin token via ?token= or Authorization: Bearer' });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}

async function readJsonOrFormBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const ct = req.headers['content-type'] ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); }
  catch { return { raw }; }
}

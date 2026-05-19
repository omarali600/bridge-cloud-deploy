/**
 * HTTP server — endpoints for ops + Twilio voice webhook + /admin/pair.
 *
 * Endpoints:
 *   GET  /health          — liveness probe ({"ok":true,"channels":[...]})
 *   GET  /admin/pair      — current WhatsApp pairing QR as PNG (admin-only)
 *   POST /voice/incoming  — Twilio voice webhook (scaffolded; see voice.mjs)
 *
 * Admin endpoints require ?token=<ADMIN_TOKEN> matching the
 * ADMIN_TOKEN env var. Don't expose ADMIN_TOKEN publicly; treat it like
 * a service secret.
 */

import http from 'node:http';
import qrcode from 'qrcode';
import { getPendingQr } from './channels/whatsapp.mjs';
import { log } from './log.mjs';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

export function startHttpServer({ port }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        channels: {
          telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
          whatsapp: process.env.WHATSAPP_ENABLED === '1',
          voice: !!process.env.TWILIO_AUTH_TOKEN,
        },
      }));
      return;
    }

    if (url.pathname === '/admin/pair') {
      if (!ADMIN_TOKEN || url.searchParams.get('token') !== ADMIN_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('admin token required (?token=...)');
        return;
      }
      const { qr, ageSeconds } = getPendingQr();
      if (!qr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(
          'No pairing QR available right now. Either WhatsApp is already paired, or the Baileys client has not emitted a QR yet. Try restarting the service (Render dashboard → Manual Deploy → "Clear cache & deploy") to force a fresh pair.'
        );
        return;
      }
      try {
        const png = await qrcode.toBuffer(qr, { type: 'png', width: 480, margin: 2 });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'X-QR-Age-Seconds': String(ageSeconds),
          'Cache-Control': 'no-store',
        });
        res.end(png);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`QR render failed: ${e.message}`);
      }
      return;
    }

    if (url.pathname === '/voice/incoming' && req.method === 'POST') {
      // Twilio voice webhook scaffold. Real handling lives in voice.mjs
      // when wired; for now we respond with a polite TwiML message so
      // misconfigured callers don't get a 500.
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Voice surface is not yet active. Please text me instead.</Say><Hangup/></Response>`
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, '0.0.0.0', () => {
    log(`HTTP server listening on :${port}`);
  });
}

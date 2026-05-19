/**
 * HTTP server — endpoints for ops + Twilio WhatsApp + voice webhooks.
 *
 *   GET  /health             liveness probe ({"ok":true,"channels":{...}})
 *   POST /whatsapp/incoming  Twilio WhatsApp webhook (form-encoded)
 *   POST /voice/incoming     Twilio voice webhook (returns TwiML)
 *
 * Twilio signs each request with X-Twilio-Signature. We verify against
 * the auth token before processing.
 */

import http from 'node:http';
import twilio from 'twilio';
import { handleWhatsappIncoming, isWhatsappReady } from './channels/whatsapp.mjs';
import { log } from './log.mjs';

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

function verifyTwilio(req, body, publicUrl) {
  if (!TWILIO_AUTH_TOKEN) return true; // dev convenience; in prod always sign
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const params = Object.fromEntries(new URLSearchParams(body));
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, publicUrl, params);
}

export function startHttpServer({ port }) {
  const publicHost = process.env.RENDER_EXTERNAL_HOSTNAME
    || process.env.PUBLIC_HOSTNAME
    || `bridge-relay-hdmy.onrender.com`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        channels: {
          telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
          whatsapp: isWhatsappReady(),
          voice: !!process.env.TWILIO_AUTH_TOKEN,
        },
      }));
      return;
    }

    if (url.pathname === '/whatsapp/incoming' && req.method === 'POST') {
      const body = await readBody(req);
      const publicUrl = `https://${publicHost}${url.pathname}`;
      if (!verifyTwilio(req, body, publicUrl)) {
        log(`WhatsApp: signature verification failed for ${publicUrl}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('signature verification failed');
        return;
      }

      // Acknowledge fast (empty TwiML) — async-process the message.
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');

      const params = new URLSearchParams(body);
      handleWhatsappIncoming(params).catch((e) => log(`WhatsApp handler error: ${e.message}`));
      return;
    }

    if (url.pathname === '/voice/incoming' && req.method === 'POST') {
      // Voice surface scaffold. Existing Mac-side voice-agent continues to
      // handle real calls via ngrok; this endpoint will take over when we
      // migrate voice fully to the cloud (Phase 6 step 4 in current plan).
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Voice surface is being migrated. Please text me on Telegram or WhatsApp meanwhile.</Say><Hangup/></Response>',
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

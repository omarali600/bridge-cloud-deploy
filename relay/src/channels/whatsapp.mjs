/**
 * WhatsApp channel via Baileys (linked-device pairing model).
 *
 * Bring-up:
 *   1. Set WHATSAPP_ENABLED=1 in the Render service env.
 *   2. Visit https://<service-host>/admin/pair on this service. The QR
 *      endpoint returns a PNG that you scan on your phone (WhatsApp →
 *      Settings → Linked devices → Link a device).
 *   3. After scan, Baileys persists session creds to /opt/data/whatsapp/.
 *      The container can restart without re-pairing.
 *
 * UX model:
 *   - The cloud is linked to Omar's main WhatsApp as a "linked device" —
 *     same model as WhatsApp Web. Omar messages himself (or asks others
 *     to forward) and the relay picks it up.
 *   - For a separate "Bridget number", we'd need Twilio's WhatsApp
 *     Business API (Meta verification required). Phase 6 starts with
 *     linked-device because it's immediate; Twilio can be swapped in
 *     without changing the routing layer.
 *
 * NOTE: This module exports a `pendingQr` value the HTTP server reads
 * for the /admin/pair endpoint. Baileys emits QR codes via its update
 * stream; we cache the most recent one.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { log } from '../log.mjs';
import { classify } from '../routing.mjs';
import { invokeAgent } from '../agents.mjs';

let stateDir = '/opt/data/whatsapp';
let ownerPhone = '';
export let pendingQr = null; // most recent QR as a string (data: encoded)
let pendingQrTs = 0;

export async function startWhatsappChannel(opts) {
  stateDir = `${opts.stateDir}/whatsapp`;
  ownerPhone = opts.ownerPhone || '';
  mkdirSync(stateDir, { recursive: true });

  let baileys;
  try {
    baileys = await import('@whiskeysockets/baileys');
  } catch (e) {
    log(`WhatsApp: baileys not installed (${e.message}); channel disabled`);
    return;
  }

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
  const { state, saveCreds } = await useMultiFileAuthState(stateDir);

  function start() {
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        pendingQr = qr;
        pendingQrTs = Date.now();
        log('WhatsApp: new pairing QR available at /admin/pair');
      }
      if (connection === 'open') {
        pendingQr = null;
        log(`WhatsApp: connected as ${sock.user?.id || 'unknown'}`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        log(`WhatsApp: disconnected (code=${code}, willReconnect=${shouldReconnect})`);
        if (shouldReconnect) setTimeout(start, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try { await handleIncoming(sock, m); }
        catch (e) { log(`WhatsApp handler error: ${e.message}`); }
      }
    });
  }

  start();
  log(`WhatsApp channel: started (state at ${stateDir})`);
}

export function getPendingQr() {
  return { qr: pendingQr, ageSeconds: pendingQr ? Math.floor((Date.now() - pendingQrTs) / 1000) : null };
}

async function handleIncoming(sock, m) {
  // Skip our own messages (sent by us via the linked-device session)
  if (m.key.fromMe) return;
  // Optional owner restriction: only respond to specific phone if set
  if (ownerPhone) {
    const from = (m.key.remoteJid || '').split('@')[0];
    if (from !== ownerPhone.replace(/\D/g, '')) {
      log(`WhatsApp: ignoring message from ${from} (not owner)`);
      return;
    }
  }

  const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
  if (!text) return;

  const jid = m.key.remoteJid;
  log(`WhatsApp [in] ${jid}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);

  await sock.sendPresenceUpdate('composing', jid);
  try {
    const agentId = await classify(text);
    const reply = await invokeAgent(agentId, text);
    await sock.sendMessage(jid, { text: reply });
    log(`WhatsApp [out:${agentId}] ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);
  } catch (e) {
    log(`WhatsApp error: ${e.message}`);
    await sock.sendMessage(jid, { text: `Something went wrong: ${e.message.slice(0, 200)}` });
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
  }
}

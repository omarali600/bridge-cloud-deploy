/**
 * WhatsApp channel via Twilio.
 *
 * Architecture:
 *   - Inbound: Twilio POSTs to /whatsapp/incoming on this service.
 *     The HTTP server (http.mjs) routes the POST here. We respond with
 *     an empty TwiML <Response/> immediately and process async so the
 *     agent's longer response doesn't block the webhook.
 *   - Outbound: twilio npm package to messages.create(). The "From"
 *     comes from env (TWILIO_WHATSAPP_FROM) — for sandbox it's
 *     "whatsapp:+14155238886"; for production it's the verified
 *     business number.
 *
 * Bring-up:
 *   1. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *      env vars on the Render service.
 *   2. Point the Twilio WhatsApp Sandbox / Sender webhook at
 *      https://bridge-relay-hdmy.onrender.com/whatsapp/incoming
 *   3. Send a message — Twilio POSTs to the webhook, we route + reply.
 */

import twilio from 'twilio';
import { classify } from '../routing.mjs';
import { invokeAgent } from '../agents.mjs';
import { forward, intakeEnabled } from '../intake-client.mjs';
import { log } from '../log.mjs';

let twilioClient = null;
let whatsappFrom = '';

export function initWhatsapp() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  whatsappFrom = process.env.TWILIO_WHATSAPP_FROM ?? '';

  if (!sid || !auth) {
    log('WhatsApp: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN required; channel disabled');
    return false;
  }
  if (!whatsappFrom) {
    log('WhatsApp: TWILIO_WHATSAPP_FROM required (e.g., whatsapp:+14155238886 for sandbox); channel disabled');
    return false;
  }
  twilioClient = twilio(sid, auth);
  log(`WhatsApp: ready (from=${whatsappFrom})`);
  return true;
}

export function isWhatsappReady() {
  return twilioClient !== null;
}

/**
 * Handle an inbound WhatsApp message (already parsed from Twilio's
 * form-encoded POST). Sends agent reply via Twilio API.
 */
export async function handleWhatsappIncoming(params) {
  if (!twilioClient) {
    log('WhatsApp: incoming but client not initialized');
    return;
  }

  const from = params.get('From');         // "whatsapp:+12025551234"
  const text = params.get('Body') || '';
  const messageSid = params.get('MessageSid') ?? '';

  if (!from || !text.trim()) {
    log(`WhatsApp: ignoring (missing from=${from} or body)`);
    return;
  }

  log(`WhatsApp [in:${from}] ${text.slice(0, 100)}${text.length > 100 ? '…' : ''} sid=${messageSid}`);

  try {
    let reply = null;
    let agentLabel = 'unknown';

    if (intakeEnabled()) {
      const out = await forward('whatsapp', Object.fromEntries(params));
      reply = out?.outcome?.reply ?? null;
      agentLabel = out?.outcome?.target ?? out?.classification?.suggested_route ?? 'intake';
      // Intake handles escalation directly; skip thread reply if so.
      if (!reply) {
        log(`WhatsApp [intake] ${out?.outcome?.effective_action ?? 'no-reply'}; nothing to send back`);
        return;
      }
    } else {
      const agentId = await classify(text);
      reply = await invokeAgent(agentId, text);
      agentLabel = agentId;
    }

    log(`WhatsApp [out:${agentLabel}] ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);
    await twilioClient.messages.create({
      from: whatsappFrom,
      to: from,
      body: reply,
    });
  } catch (e) {
    log(`WhatsApp error: ${e.message}`);
    try {
      await twilioClient.messages.create({
        from: whatsappFrom,
        to: from,
        body: `Something went wrong on my end — I couldn't get an answer for you this time. (${e.message.slice(0, 200)})`,
      });
    } catch (sendErr) {
      log(`WhatsApp: failed to send error message: ${sendErr.message}`);
    }
  }
}

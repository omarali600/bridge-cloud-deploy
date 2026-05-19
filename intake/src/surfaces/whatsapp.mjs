/**
 * WhatsApp surface adapter (Twilio).
 *
 * The relay receives Twilio's webhook POST and forwards the parsed params
 * here. We classify + route + return any reply text.
 *
 * Blocked on Twilio reactivation as of 2026-05-20 (account flagged).
 * Tested with mock fixtures meanwhile.
 */

import { ingest } from '../pipeline.mjs';

/**
 * Twilio sends form-encoded:
 *   From: whatsapp:+12025551234
 *   Body: message text
 *   MessageSid: SM...
 *   ProfileName: optional sender display name
 */
export function normalize(params) {
  const from = params.From ?? params.from ?? '';
  const body = params.Body ?? params.body ?? '';
  const sid = params.MessageSid ?? params.sid ?? '';
  const profile = params.ProfileName ?? params.profileName ?? '';

  const phoneNumber = from.replace(/^whatsapp:/, '');
  const isSelf = phoneNumber === (process.env.WHATSAPP_OWNER_PHONE || '+31618255047');

  return {
    surface: 'whatsapp',
    from: {
      identifier: from,
      display: profile || phoneNumber,
      kind: isSelf ? 'self' : 'contact',
    },
    content: {
      text: body,
      rawSurfaceMetadata: { MessageSid: sid, From: from, ProfileName: profile },
    },
    hints: {},
  };
}

export async function handle(params) {
  const item = normalize(params);
  return ingest(item);
}

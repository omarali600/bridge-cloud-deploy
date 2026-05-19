/**
 * Telegram surface adapter.
 *
 * Two modes:
 *   1. Inbound HTTP from the refactored relay — relay forwards Telegram messages
 *      here after receiving them via long-poll. We classify + route + return
 *      the agent's reply for relay to send back.
 *   2. Outbound Telegram-as-escalation — handled by routing/omar.mjs.
 *
 * The relay still owns the Telegram getUpdates loop. We just expose an HTTP
 * endpoint relay calls per message.
 */

import { ingest } from '../pipeline.mjs';
import { log } from '../log.mjs';

/**
 * Build a normalized intake item from the relay's Telegram payload.
 *
 * Relay POSTs:
 *   { type: 'telegram', message: { message_id, chat: { id }, from: { username, id, first_name }, text } }
 */
export function normalize(payload) {
  const msg = payload.message ?? {};
  const text = msg.text ?? '';
  const sender = msg.from ?? {};
  const chatId = msg.chat?.id ? String(msg.chat.id) : 'unknown';

  return {
    surface: 'telegram',
    receivedAt: new Date(msg.date ? msg.date * 1000 : Date.now()).toISOString(),
    from: {
      identifier: chatId,
      display: sender.username || sender.first_name || `tg:${chatId}`,
      kind: chatId === (process.env.TELEGRAM_CHAT_ID || '') ? 'self' : 'contact',
    },
    content: {
      text,
      rawSurfaceMetadata: {
        message_id: msg.message_id,
        chat_id: chatId,
        date: msg.date,
      },
    },
    hints: {},
  };
}

/**
 * Process a Telegram payload through the pipeline. Returns the outcome with
 * a possible reply for the relay to send back on the same thread.
 */
export async function handle(payload) {
  const item = normalize(payload);
  return ingest(item);
}

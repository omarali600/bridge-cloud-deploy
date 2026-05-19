/**
 * Omar-direct messages. Sends plain-English Telegram alerts to Omar's chat.
 *
 * Plain English everywhere user-facing — no command names, no file paths, no
 * surface internals. See feedback_plain_english_only.
 */

import { log } from '../log.mjs';

let token = null;
let chatId = null;

export function initOmarChannel({ telegramToken, telegramChatId } = {}) {
  token = telegramToken || process.env.TELEGRAM_BOT_TOKEN || null;
  chatId = telegramChatId || process.env.TELEGRAM_CHAT_ID || null;
  if (!token || !chatId) {
    log('omar: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing; escalations will fail');
    return;
  }
  log(`omar: ready (chat=${chatId})`);
}

export async function messageOmar(text) {
  if (!token || !chatId) {
    throw new Error('omar channel not initialized (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`telegram sendMessage failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

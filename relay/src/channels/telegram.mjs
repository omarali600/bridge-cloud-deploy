/**
 * Telegram channel — long-poll inbound messages from Bridget bot, route +
 * invoke an agent, reply on the same thread. Replicates the local relay's
 * behavior, but on persistent /opt/data state so a container restart
 * resumes cleanly.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { classify } from '../routing.mjs';
import { invokeAgent } from '../agents.mjs';
import { forward, intakeEnabled } from '../intake-client.mjs';
import { log } from '../log.mjs';

let token, chatId, offsetFile;

export function startTelegramChannel(opts) {
  token = opts.token;
  chatId = String(opts.chatId);
  offsetFile = `${opts.stateDir}/telegram-offset.txt`;
  loop().catch((e) => log(`Telegram loop crashed: ${e.message}`));
  log(`Telegram channel: started (chat=${chatId})`);
}

function loadOffset() {
  if (existsSync(offsetFile)) {
    try { return parseInt(readFileSync(offsetFile, 'utf-8'), 10) || 0; }
    catch { /* fall through */ }
  }
  // First-boot resume: honor TELEGRAM_INITIAL_OFFSET so the cloud relay
  // picks up where the local relay left off (no replay of historical
  // messages, no duplicate handling). Set it once via env, then the
  // persistent offset.txt takes over.
  const initial = parseInt(process.env.TELEGRAM_INITIAL_OFFSET ?? '0', 10) || 0;
  if (initial > 0) {
    saveOffset(initial);
    log(`Telegram: seeded initial offset = ${initial} (from env)`);
  }
  return initial;
}

function saveOffset(n) { writeFileSync(offsetFile, String(n)); }

async function tgGetUpdates(offset) {
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25`;
  const res = await fetch(url);
  return res.json();
}

async function tgSendMessage(text, replyToMessageId) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function tgSendAction(action = 'typing') {
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

function startTyping() {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try { await tgSendAction('typing'); } catch {}
      await sleep(4000);
    }
  })();
  return () => { stopped = true; };
}

async function handleMessage(msg) {
  if (!msg.text) return;
  if (String(msg.chat?.id) !== chatId) {
    log(`Telegram: ignoring chat=${msg.chat?.id}`);
    return;
  }

  const text = msg.text;
  log(`Telegram [in] ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`);

  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/start') {
      await tgSendMessage(
        "Hi. I'm Bridget. Text me anything — about CRREM, about your week, about your brain — and I'll get one of your agents to answer.",
        msg.message_id,
      );
      return;
    }
    if (cmd === '/help') {
      await tgSendMessage(
        "Things you can text me:\n\n" +
          "• \"What's on my calendar tomorrow?\" — Beatrix answers from your brain.\n" +
          "• \"Draft a reply to the CRREM email about V2.04\" — Clem drafts it.\n" +
          "• \"What did Hans say last week?\" — Beatrix searches your brain.\n\n" +
          "I route to the right agent automatically.",
        msg.message_id,
      );
      return;
    }
    log(`Telegram: unknown command ${cmd}`);
    return;
  }

  const stopTyping = startTyping();
  try {
    let reply = null;
    let agentLabel = 'unknown';

    if (intakeEnabled()) {
      // Forward to bridge-intake. Intake classifies, routes, returns the reply
      // text (if any) for us to send back on the same Telegram thread.
      const out = await forward('telegram', { message: msg });
      reply = out?.outcome?.reply ?? null;
      agentLabel = out?.outcome?.target ?? out?.classification?.suggested_route ?? 'intake';
      // If intake escalated to Omar, the omar-direct message already went out
      // via Telegram from the intake service itself. Don't double-message.
      if (out?.outcome?.effective_action === 'escalate' && !reply) {
        log(`Telegram [intake] escalated to Omar (no reply on thread)`);
        stopTyping();
        return;
      }
      // Queued / archived items also don't get a thread reply.
      if (!reply && ['queue', 'archive'].includes(out?.outcome?.effective_action)) {
        log(`Telegram [intake] ${out.outcome.effective_action} (no reply on thread)`);
        stopTyping();
        return;
      }
    } else {
      // Legacy path: classify + invoke directly. Kept until intake is verified.
      const agentId = await classify(text);
      reply = await invokeAgent(agentId, text);
      agentLabel = agentId;
    }

    stopTyping();
    if (reply) {
      log(`Telegram [out:${agentLabel}] ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);
      await tgSendMessage(reply, msg.message_id);
    }
  } catch (e) {
    stopTyping();
    log(`Telegram error: ${e.message}`);
    await tgSendMessage(
      `Something went wrong on my end — I couldn't get an answer for you this time. (${e.message.slice(0, 200)})`,
      msg.message_id,
    );
  }
}

async function loop() {
  while (true) {
    try {
      const offset = loadOffset();
      const j = await tgGetUpdates(offset);
      if (j?.ok && j.result.length) {
        for (const u of j.result) {
          try { if (u.message) await handleMessage(u.message); } catch (e) { log(`Telegram handler: ${e.message}`); }
          saveOffset(u.update_id + 1);
        }
      } else if (!j?.ok) {
        log(`Telegram getUpdates failed: ${JSON.stringify(j).slice(0, 200)}`);
        await sleep(5000);
      }
    } catch (e) {
      log(`Telegram poll error: ${e.message} — backing off`);
      await sleep(10_000);
    }
  }
}

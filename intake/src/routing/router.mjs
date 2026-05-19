/**
 * Router. Takes a classification + threshold decision and dispatches to:
 *   • Cloud Beatrix or Clem via OpenClaw gateway
 *   • Brain via gbrain HTTP (or local spawn fallback)
 *   • Omar-direct via Telegram in plain English
 *
 * The router's job is dispatch, not decision-making. Decision logic lives
 * in classifier + thresholds.
 */

import { invokeAgent } from './agents.mjs';
import { writeToBrain } from './brain.mjs';
import { messageOmar } from './omar.mjs';
import { decide } from './thresholds.mjs';
import { audit } from '../audit/index.mjs';
import { log } from '../log.mjs';

let liveRouting = true;

export function initRouter(opts) {
  liveRouting = opts?.liveRouting !== false;
  log(`router: live routing ${liveRouting ? 'ENABLED' : 'DISABLED (dry-run)'}`);
}

/**
 * Route an intake item according to its classification. Returns the routing
 * outcome (what was done + any reply that should be sent back on the surface).
 */
export async function route(item, classification) {
  const decision = decide(item.surface, classification);

  audit.log({
    action: 'route',
    target: classification.suggested_route,
    reasoning: `${classification.reasoning_summary} → ${decision.effective_action} (${decision.reason})`,
    data: {
      intake_item_id: item.id,
      surface: item.surface,
      decision,
      classification_summary: {
        urgency: classification.urgency,
        domain: classification.domain,
        suggested_route: classification.suggested_route,
        action: classification.action,
      },
    },
  });

  // Dry-run mode: log what we would do, return without acting.
  if (!liveRouting) {
    log(`router: DRY-RUN would ${decision.effective_action} ${item.surface}#${item.id.slice(-8)} → ${classification.suggested_route}`);
    return {
      effective_action: decision.effective_action,
      target: classification.suggested_route,
      reply: null,
      dry_run: true,
    };
  }

  switch (decision.effective_action) {
    case 'handle':
      return handleAction(item, classification, decision);
    case 'queue':
      return queueAction(item, classification, decision);
    case 'escalate':
      return escalateAction(item, classification, decision);
    case 'archive':
      return archiveAction(item, classification, decision);
    default:
      log(`router: unknown effective_action ${decision.effective_action}`);
      return escalateAction(item, classification, decision);
  }
}

async function handleAction(item, classification, decision) {
  const target = classification.suggested_route;
  let reply = null;

  try {
    if (target === 'beatrix' || target === 'clem') {
      const message = buildAgentMessage(item, classification);
      reply = await invokeAgent(target, message);
      audit.log({
        action: 'invoke',
        target,
        reasoning: `Invoked ${target} for ${item.surface}#${item.id.slice(-8)}.`,
        data: { intake_item_id: item.id, reply_length: reply?.length ?? 0 },
      });
    } else if (target === 'brain') {
      const slug = brainSlugFor(item);
      const content = buildBrainContent(item, classification);
      await writeToBrain(slug, content);
      audit.log({
        action: 'invoke',
        target: 'brain',
        reasoning: `Filed ${item.surface}#${item.id.slice(-8)} to brain under ${slug}.`,
        data: { intake_item_id: item.id, slug },
      });
    } else if (target === 'omar-direct') {
      // Suggested route is omar-direct but action came through as handle.
      // Treat as escalation.
      return escalateAction(item, classification, decision);
    }
  } catch (e) {
    log(`router: handle ${target} failed: ${e.message}`);
    // Don't lose the inbound — escalate to Omar so it doesn't silently disappear.
    return escalateAction(item, classification, {
      ...decision,
      reason: `Tried to route to ${target} but failed: ${e.message}. Escalating.`,
    });
  }

  return {
    effective_action: 'handle',
    target,
    reply: decision.auto_reply ? reply : null,
    dry_run: false,
  };
}

async function queueAction(item, classification, decision) {
  // The audit log IS the queue for now — the future "reflection cadence"
  // (capability #23) will read from audit events with action=queued and
  // surface them in Bridget's daily/weekly check-ins.
  audit.log({
    action: 'queue',
    target: classification.suggested_route,
    reasoning: `Queued for later: ${classification.reasoning_summary}`,
    data: {
      intake_item_id: item.id,
      surface: item.surface,
      queue_for: classification.suggested_route,
    },
  });
  return {
    effective_action: 'queue',
    target: classification.suggested_route,
    reply: null,
    dry_run: false,
  };
}

async function escalateAction(item, classification, decision) {
  const message = buildOmarMessage(item, classification, decision);
  try {
    await messageOmar(message);
    audit.log({
      action: 'escalate',
      target: 'omar',
      reasoning: classification.reasoning_summary,
      data: {
        intake_item_id: item.id,
        surface: item.surface,
        message_sent: message,
      },
    });
  } catch (e) {
    log(`router: escalate to Omar failed: ${e.message}`);
    audit.log({
      action: 'escalate-failed',
      target: 'omar',
      reasoning: `Tried to escalate but Telegram failed: ${e.message}`,
      data: { intake_item_id: item.id },
    });
  }
  return {
    effective_action: 'escalate',
    target: 'omar',
    reply: null,
    dry_run: false,
  };
}

async function archiveAction(item, classification, decision) {
  audit.log({
    action: 'archive',
    target: null,
    reasoning: `Archived without acting: ${classification.reasoning_summary}`,
    data: { intake_item_id: item.id, surface: item.surface },
  });
  return {
    effective_action: 'archive',
    target: null,
    reply: null,
    dry_run: false,
  };
}

// ─── helpers ───

function buildAgentMessage(item, classification) {
  // Pass the agent enough context to act, but keep it plain English.
  const lines = [];
  lines.push(`From: ${item.from?.display ?? item.from?.identifier ?? 'unknown'} on ${item.surface}.`);
  if (item.content?.subject) lines.push(`Subject: ${item.content.subject}`);
  if (item.content?.text) lines.push(`\n${item.content.text.slice(0, 6000)}`);
  if (item.content?.transcript) lines.push(`\nVoice memo:\n${item.content.transcript.slice(0, 6000)}`);
  if (item.content?.vision) lines.push(`\nPhoto: ${item.content.vision.slice(0, 2000)}`);
  if (classification.urgency === 'urgent') lines.push(`\n(Bridget flagged this as urgent.)`);
  return lines.join('\n');
}

function buildOmarMessage(item, classification, decision) {
  // Plain English. The Telegram user is Omar. No command names. No file paths.
  const who = item.from?.display ?? 'unknown sender';
  const surfaceName = {
    telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'email',
    calendar: 'a calendar invite', 'voice-memo': 'a voice memo',
    photo: 'a photo', drive: 'a new file in Drive',
    sharepoint: 'a CRREM file', 'admin-test': 'a test inbound',
  }[item.surface] ?? item.surface;

  const subject = item.content?.subject ? ` — "${item.content.subject}"` : '';
  const summary = classification.reasoning_summary;

  const preview = (item.content?.text || item.content?.transcript || item.content?.vision || '')
    .replace(/\s+/g, ' ').trim().slice(0, 200);

  let lead;
  if (classification.urgency === 'urgent') {
    lead = `Heads up — urgent: ${who} sent ${surfaceName}${subject}.`;
  } else {
    lead = `${who} sent ${surfaceName}${subject}.`;
  }

  const ask = decision.effective_action === 'escalate' && classification.suggested_route !== 'omar-direct'
    ? `Want me to send it to ${classification.suggested_route === 'beatrix' ? 'Beatrix' : 'Clem'}?`
    : 'Want me to draft a reply or queue it?';

  return [
    lead,
    summary,
    preview ? `> ${preview}${preview.length >= 200 ? '…' : ''}` : null,
    ask,
  ].filter(Boolean).join('\n\n');
}

function brainSlugFor(item) {
  const date = new Date(item.receivedAt).toISOString().slice(0, 10);
  const safe = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const subject = item.content?.subject;
  const hint = subject ? safe(subject) : safe(item.id);
  return `inbox/${date}/${item.surface}-${hint}`;
}

function buildBrainContent(item, classification) {
  const fm = [
    '---',
    `kind: intake`,
    `surface: ${item.surface}`,
    `received: ${item.receivedAt}`,
    `from: ${item.from?.display ?? item.from?.identifier ?? 'unknown'}`,
    `urgency: ${classification.urgency}`,
    `domain: ${classification.domain}`,
    `entities: [${classification.entities.map((e) => `"${e.name}"`).join(', ')}]`,
    `intake_id: ${item.id}`,
    '---',
    '',
  ].join('\n');

  const body = [
    `# ${item.content?.subject ?? `${item.surface} from ${item.from?.display ?? 'unknown'}`}`,
    '',
    classification.reasoning_summary,
    '',
  ];

  if (item.content?.text) body.push('## Text\n\n' + item.content.text);
  if (item.content?.transcript) body.push('## Transcript\n\n' + item.content.transcript);
  if (item.content?.ocr) body.push('## OCR\n\n' + item.content.ocr);
  if (item.content?.vision) body.push('## Vision\n\n' + item.content.vision);

  return fm + body.join('\n\n');
}

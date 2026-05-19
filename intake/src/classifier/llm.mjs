/**
 * LLM-based classifier. Uses Claude Sonnet 4.5 by default (CLASSIFIER_PRIMARY_MODEL),
 * falls back to Haiku (CLASSIFIER_FALLBACK_MODEL) if the primary call fails.
 *
 * The prompt is structured around BRIDGE-specific routing rules:
 *   • Personal life → Beatrix
 *   • CRREM → Clem
 *   • Raw capture → brain (gbrain put)
 *   • High-stakes / world-touching / unclear → Omar-direct (escalate)
 *
 * Output is forced to a JSON schema via Anthropic's tool-use mechanism.
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../log.mjs';

let anthropic = null;
let primaryModel = 'claude-sonnet-4-5';
let fallbackModel = 'claude-haiku-4-5';

export function initLLMClassifier({ apiKey, primaryModel: p, fallbackModel: f }) {
  if (!apiKey) {
    log('classifier.llm: no ANTHROPIC_API_KEY; classifier will return defaults');
    return;
  }
  anthropic = new Anthropic({ apiKey });
  if (p) primaryModel = p;
  if (f) fallbackModel = f;
  log(`classifier.llm: ready (primary=${primaryModel}, fallback=${fallbackModel})`);
}

const SYSTEM_PROMPT = `You are Bridget, the intake membrane for Omar Ali's BRIDGE personal AI system.

Every inbound message from every surface (email, Telegram, WhatsApp, voice memo, photo, calendar, Drive, SharePoint) flows through you. Your job: classify each item, then route it.

OMAR'S TWO AGENTS

- Beatrix — Omar's personal life director. She handles personal email, calendar, finances, fitness, photos, people-graph, travel, decisions, writing, anything reflective. Her register is warm, direct, opinionated. Default route for personal-life things.

- Clem — CRREM organization director. CRREM is the Carbon Risk Real Estate Monitor; Omar is the founder. Clem handles methodology (V2.04 is current), brand voice, ASP cohort (Accredited Service Providers), Licence Partners, comms, events, CRREM team relationships, anything tied to the company. Hard CRREM brand rules Clem knows: never says "stranded" (must say "misalignment year"); American English; doesn't pair dark evergreen #174A3B with amber/gold; doesn't name CRREM individuals as owners.

ROUTES

- "beatrix" — personal life things, anything Omar himself would handle as a private person.
- "clem" — CRREM-related, work-as-founder things.
- "brain" — raw capture that should land in the knowledge store without ceremony. Voice memo half-thoughts, scanned business cards, screenshot of an article. Use when no immediate action is needed but the substance is worth preserving.
- "omar-direct" — Omar himself must see this. Urgent things. Things that require his personal judgment. Things you're not sure how to route.

URGENCY

- "urgent" — needs Omar's attention within hours (a fire to put out, a journalist needing a quote, a real-time question from a board member).
- "normal" — needs attention within days.
- "low" — eventual, not time-critical.
- "archive" — informational, no action needed.

DOMAIN

- "personal" — Omar's life outside CRREM.
- "work" — non-CRREM professional work.
- "crrem-internal" — internal CRREM operations, team comms, methodology.
- "crrem-external" — CRREM-facing-the-world: press, partners, ASPs, public.
- "admin" — calendar invites, scheduling, logistics, system messages.

ACTION

- "handle" — act on it now via the suggested route.
- "queue" — file it for later surfacing (no immediate action).
- "escalate" — Omar must see this before any action is taken.
- "archive" — log + archive without acting.

WORLD-TOUCHING ACTIONS

If the action involves sending an external message, moving money, accepting/declining an invitation on Omar's behalf, booking flights, modifying someone else's calendar, replying to a journalist, or committing on his behalf — set "world_touching_action" to one of: send_external_message, move_money, accept_invitation, decline_invitation, book_flight, book_accommodation, modify_calendar_other, reply_to_journalist, commit_on_behalf. Otherwise null.

ENTITIES

Extract named entities — people, organizations, projects, places. Type each one as person, org, project, place, document, or topic.

REASONING

Write a one-sentence plain-English explanation Omar will read in his audit feed. No command names, no file paths, no jargon. "Andrea emailed about V2.04, looks high-priority." not "intake.email.classify routed eml://xyz with urgency=high".

Always respond using the classify_intake tool.`;

const TOOL_SCHEMA = {
  name: 'classify_intake',
  description: 'Classify and route this intake item.',
  input_schema: {
    type: 'object',
    properties: {
      urgency: { type: 'string', enum: ['urgent', 'normal', 'low', 'archive'] },
      domain: { type: 'string', enum: ['personal', 'work', 'crrem-internal', 'crrem-external', 'admin'] },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['person', 'org', 'project', 'place', 'document', 'topic'] },
          },
          required: ['name', 'type'],
        },
      },
      suggested_route: { type: 'string', enum: ['beatrix', 'clem', 'brain', 'omar-direct'] },
      action: { type: 'string', enum: ['handle', 'queue', 'escalate', 'archive'] },
      world_touching_action: {
        type: ['string', 'null'],
        enum: [
          null, 'send_external_message', 'move_money', 'accept_invitation',
          'decline_invitation', 'book_flight', 'book_accommodation',
          'modify_calendar_other', 'reply_to_journalist', 'commit_on_behalf',
        ],
      },
      reasoning_summary: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['urgency', 'domain', 'entities', 'suggested_route', 'action', 'reasoning_summary', 'confidence'],
  },
};

function buildUserPrompt(item) {
  const lines = [
    `Surface: ${item.surface}`,
    `Received: ${item.receivedAt}`,
    `From: ${item.from?.display ?? item.from?.identifier ?? 'unknown'} (${item.from?.kind ?? 'unknown'})`,
  ];

  if (item.content?.subject) lines.push(`Subject: ${item.content.subject}`);
  if (item.content?.text) lines.push(`\nText:\n${item.content.text.slice(0, 4000)}`);
  if (item.content?.transcript) lines.push(`\nVoice memo transcript:\n${item.content.transcript.slice(0, 4000)}`);
  if (item.content?.ocr) lines.push(`\nOCR text from image:\n${item.content.ocr.slice(0, 2000)}`);
  if (item.content?.vision) lines.push(`\nVision analysis of image:\n${item.content.vision.slice(0, 2000)}`);

  if (item.hints && Object.keys(item.hints).length > 0) {
    lines.push(`\nAdapter hints: ${JSON.stringify(item.hints)}`);
  }

  if (item.content?.attachments?.length) {
    lines.push(`\nAttachments: ${item.content.attachments.map((a) => `${a.mime} (${a.size}b)`).join(', ')}`);
  }

  return lines.join('\n');
}

export async function classifyLLM(item, { model } = {}) {
  if (!anthropic) {
    log('classifier.llm: not initialized; returning default classification');
    return defaultClassification(item, 'no anthropic client');
  }

  const useModel = model ?? primaryModel;
  const userPrompt = buildUserPrompt(item);

  try {
    const res = await anthropic.messages.create({
      model: useModel,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'classify_intake' },
      messages: [{ role: 'user', content: userPrompt }],
    });

    const toolUse = res.content.find((c) => c.type === 'tool_use');
    if (!toolUse) {
      log(`classifier.llm: no tool_use in response (model=${useModel})`);
      return defaultClassification(item, 'no tool_use in response');
    }

    const classification = toolUse.input;
    classification._source = `llm:${useModel}`;
    classification._latency_ms = null;
    return classification;
  } catch (e) {
    log(`classifier.llm: ${useModel} failed: ${e.message}`);
    if (useModel === primaryModel && fallbackModel) {
      log(`classifier.llm: falling back to ${fallbackModel}`);
      return classifyLLM(item, { model: fallbackModel });
    }
    return defaultClassification(item, `llm failed: ${e.message}`);
  }
}

function defaultClassification(item, reason) {
  // Safe default — escalate to Omar so nothing silently disappears.
  return {
    urgency: 'normal',
    domain: 'personal',
    entities: [],
    suggested_route: 'omar-direct',
    action: 'escalate',
    world_touching_action: null,
    reasoning_summary: `Couldn't classify this — sending to you to decide. (${reason})`,
    confidence: 0.1,
    _source: 'default-fallback',
  };
}

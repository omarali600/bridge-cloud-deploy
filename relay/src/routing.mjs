/**
 * Intent classifier — given an inbound message, route it to one of:
 *   "beatrix" : personal life, calendar, email, brain queries, BRIDGE itself
 *   "clem"    : CRREM-related (methodology, V2.04, ASP, CRREM team/site)
 *
 * Uses gpt-4o-mini for speed + cost (~$0.0001 per classify).
 */

import { log } from './log.mjs';

let openrouterKey = null;

export function initRouting({ openrouterKey: key }) {
  openrouterKey = key;
}

export async function classify(text) {
  if (!openrouterKey) {
    log('routing: no OPENROUTER_API_KEY, defaulting to beatrix');
    return 'beatrix';
  }

  const body = {
    model: 'openai/gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You route Omar's messages to one of two agents.

clem  — anything about CRREM, climate-related real estate, the methodology, V2.04, the CRREM team, the CRREM website, ASP cohort, decarbonization pathways, misalignment-year language, the CRREM brand.
beatrix — everything else (personal life, calendar, email, BRIDGE itself, the brain, people in his rubric, planning, reflection, writing he wants to do).

Respond with exactly one word: clem or beatrix. No other text.`,
      },
      { role: 'user', content: text },
    ],
    max_tokens: 5,
    temperature: 0,
  };

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    const raw = (j.choices?.[0]?.message?.content || '').trim().toLowerCase();
    const word = raw.replace(/[^a-z]/g, '');
    const agent = word === 'clem' ? 'clem' : 'beatrix';
    log(`routing: classify → ${agent}`);
    return agent;
  } catch (e) {
    log(`routing: classifier failed (${e.message}), defaulting to beatrix`);
    return 'beatrix';
  }
}

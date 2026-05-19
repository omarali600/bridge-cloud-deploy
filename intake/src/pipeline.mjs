/**
 * The intake pipeline. Single entry point every surface adapter calls.
 *
 *   ingest(item) → classify → route → outcome
 *
 * Every surface adapter normalizes its surface's input into the intake item
 * shape, then calls ingest(). This is the only path inbound items take.
 */

import { randomBytes } from 'node:crypto';
import { classify } from './classifier/index.mjs';
import { route } from './routing/router.mjs';
import { log } from './log.mjs';

/**
 * Ingest a normalized intake item. Returns the routing outcome.
 *
 * Adapters should fill in surface, from, content, hints. id and receivedAt
 * are filled in here if absent.
 */
export async function ingest(partial) {
  const item = {
    id: partial.id ?? `intake-${new Date().toISOString()}-${randomBytes(4).toString('hex')}`,
    receivedAt: partial.receivedAt ?? new Date().toISOString(),
    surface: partial.surface,
    from: partial.from ?? { identifier: 'unknown', display: 'unknown', kind: 'unknown' },
    content: partial.content ?? {},
    hints: partial.hints ?? {},
  };

  log(`pipeline: ingest surface=${item.surface} id=${item.id.slice(-8)}`);

  let classification;
  try {
    classification = await classify(item);
  } catch (e) {
    log(`pipeline: classify failed: ${e.message}`);
    classification = {
      urgency: 'normal',
      domain: 'personal',
      entities: [],
      suggested_route: 'omar-direct',
      action: 'escalate',
      world_touching_action: null,
      reasoning_summary: `Couldn't classify this — sending it to you so it isn't lost.`,
      confidence: 0.0,
      _source: 'pipeline-error',
    };
  }

  let outcome;
  try {
    outcome = await route(item, classification);
  } catch (e) {
    log(`pipeline: route failed: ${e.message}`);
    outcome = { effective_action: 'route-failed', target: null, reply: null, error: e.message };
  }

  return { item, classification, outcome };
}

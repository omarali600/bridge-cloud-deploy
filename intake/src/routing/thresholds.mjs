/**
 * Action thresholds per surface × principal.
 *
 * Persisted to /opt/data/intake/thresholds.json. Live-tunable via the
 * /admin/threshold endpoint without redeploying.
 *
 * Defaults follow capability #29: act unprompted on low-stakes things,
 * ask before anything that touches the world.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.mjs';

const DEFAULTS = {
  surfaces: {
    telegram:     { default_action: 'handle', principal: 'omar',  auto_reply: true  },
    whatsapp:     { default_action: 'handle', principal: 'omar',  auto_reply: true  },
    email:        { default_action: 'queue',  principal: 'omar',  auto_reply: false },
    calendar:     { default_action: 'queue',  principal: 'omar',  auto_reply: false },
    'voice-memo': { default_action: 'handle', principal: 'omar',  auto_reply: false },
    photo:        { default_action: 'queue',  principal: 'omar',  auto_reply: false },
    drive:        { default_action: 'queue',  principal: 'omar',  auto_reply: false },
    sharepoint:   { default_action: 'queue',  principal: 'crrem', auto_reply: false },
    'admin-test': { default_action: 'handle', principal: 'omar',  auto_reply: false },
  },
  principals: {
    omar:  { escalate_above: 'urgent', archive_below: 'low' },
    crrem: { escalate_above: 'urgent', archive_below: 'low' },
  },
  global: {
    // Any action whose label matches one of these forces an escalation rather
    // than a handle. These are the "world-touching" things Beatrix should
    // never do without asking.
    require_omar_approval: [
      'send_external_message',
      'move_money',
      'accept_invitation',
      'decline_invitation',
      'book_flight',
      'book_accommodation',
      'modify_calendar_other',  // adding/moving someone else's calendar entry
      'reply_to_journalist',
      'commit_on_behalf',
    ],
  },
};

let cache = null;
let configPath = null;

export function initThresholds({ stateDir }) {
  configPath = `${stateDir}/intake/thresholds.json`;
  mkdirSync(dirname(configPath), { recursive: true });
  if (existsSync(configPath)) {
    try {
      cache = JSON.parse(readFileSync(configPath, 'utf-8'));
      // Merge in any new defaults that weren't in the persisted file (so adding
      // a new surface in code doesn't require a config edit).
      cache = mergeWithDefaults(cache);
      log(`thresholds: loaded from ${configPath}`);
    } catch (e) {
      log(`thresholds: failed to load (${e.message}); using defaults`);
      cache = structuredClone(DEFAULTS);
    }
  } else {
    cache = structuredClone(DEFAULTS);
    writeFileSync(configPath, JSON.stringify(cache, null, 2));
    log(`thresholds: seeded ${configPath} with defaults`);
  }
}

function mergeWithDefaults(persisted) {
  const merged = structuredClone(DEFAULTS);
  if (persisted.surfaces) Object.assign(merged.surfaces, persisted.surfaces);
  if (persisted.principals) Object.assign(merged.principals, persisted.principals);
  if (persisted.global) Object.assign(merged.global, persisted.global);
  return merged;
}

export function get() {
  return cache ?? structuredClone(DEFAULTS);
}

export function update(patch) {
  if (!cache) cache = structuredClone(DEFAULTS);
  if (patch.surfaces) Object.assign(cache.surfaces, patch.surfaces);
  if (patch.principals) Object.assign(cache.principals, patch.principals);
  if (patch.global) Object.assign(cache.global, patch.global);
  writeFileSync(configPath, JSON.stringify(cache, null, 2));
  return cache;
}

/**
 * Given a surface + intended action, decide whether the action should fire
 * or be escalated to Omar. Returns:
 *   { effective_action, principal, auto_reply, reason }
 */
export function decide(surface, classification) {
  const t = get();
  const surfaceCfg = t.surfaces[surface] ?? t.surfaces['admin-test'];
  const principalCfg = t.principals[surfaceCfg.principal] ?? t.principals.omar;

  let effective = classification.action ?? surfaceCfg.default_action;

  // Urgency-based overrides.
  if (effective === 'handle' && classification.urgency === 'urgent') {
    // Urgent things always at least mirror to Omar (escalate), even if Beatrix
    // also handles them. The router will check this flag.
    return {
      effective_action: 'escalate',
      principal: surfaceCfg.principal,
      auto_reply: surfaceCfg.auto_reply,
      reason: 'Urgent — mirror to Omar regardless of handle.',
    };
  }
  if (classification.urgency === 'archive' || classification.urgency === 'low' && effective !== 'escalate') {
    if (principalCfg.archive_below && classification.urgency === 'archive') {
      return {
        effective_action: 'archive',
        principal: surfaceCfg.principal,
        auto_reply: false,
        reason: 'Urgency below archive threshold.',
      };
    }
  }

  // World-touching action gate.
  if (classification.world_touching_action
      && t.global.require_omar_approval.includes(classification.world_touching_action)) {
    return {
      effective_action: 'escalate',
      principal: surfaceCfg.principal,
      auto_reply: false,
      reason: `World-touching action (${classification.world_touching_action}) requires Omar's approval.`,
    };
  }

  return {
    effective_action: effective,
    principal: surfaceCfg.principal,
    auto_reply: surfaceCfg.auto_reply,
    reason: `Default for surface=${surface} action=${effective}.`,
  };
}

/**
 * Rule-based pre-classifier. Fast, free, deterministic. Catches the obvious
 * patterns so we don't burn an LLM call on every inbound.
 *
 * A rule returns null if it doesn't match, or a partial classification if it
 * does. The output is merged with the LLM's classification (rules win for the
 * fields they assert; LLM fills in the rest).
 */

import { log } from '../log.mjs';

// ─── shared helpers ───

const CRREM_TERMS = [
  'crrem', 'misalignment year', 'asp', 'accredited service provider', 'license partner',
  'v2.04', 'v2.0', 'decarbonization pathway', 'pathway analysis', 'embodied carbon',
  'climate risk', 'real estate carbon', 'pathways tool',
];

const SELF_TELEGRAM_IDS = ['5372586465']; // Omar's Telegram chat id

function lower(s) { return (s || '').toLowerCase(); }

// ─── rules ───

const rules = [
  /**
   * Calendar event invites — anything from calendar surface is a queue-by-default
   * with calendar specialist domain.
   */
  function calendarInviteRule(item) {
    if (item.surface !== 'calendar') return null;
    return {
      domain: 'admin',
      urgency: 'normal',
      action: 'queue',
      suggested_route: 'beatrix',
      reasoning_summary: 'Calendar event — queued for the calendar specialist inside Beatrix.',
      confidence: 0.9,
      _source: 'rule:calendar-invite',
    };
  },

  /**
   * CRREM SharePoint files — anything under /CRREM Vault/ is Clem's.
   */
  function crremSharepointRule(item) {
    if (item.surface !== 'sharepoint') return null;
    const path = item.content?.rawSurfaceMetadata?.path ?? '';
    if (path.toLowerCase().includes('crrem')) {
      return {
        domain: 'crrem-internal',
        urgency: 'normal',
        action: 'queue',
        suggested_route: 'clem',
        reasoning_summary: 'CRREM SharePoint file — routed to Clem.',
        confidence: 0.95,
        _source: 'rule:crrem-sharepoint',
      };
    }
    return null;
  },

  /**
   * Voice memos by default go to Beatrix as raw thought capture (Polanyi
   * capture per vision §5.8). She files to brain and surfaces themes later.
   */
  function voiceMemoRule(item) {
    if (item.surface !== 'voice-memo') return null;
    const transcript = item.content?.transcript ?? '';
    const isCrrem = CRREM_TERMS.some((t) => lower(transcript).includes(t));
    return {
      domain: isCrrem ? 'crrem-internal' : 'personal',
      urgency: 'normal',
      action: 'handle',
      suggested_route: isCrrem ? 'clem' : 'beatrix',
      reasoning_summary: `Voice memo from Omar's phone — ${isCrrem ? 'mentions CRREM, routed to Clem' : 'routed to Beatrix as raw thought capture'}.`,
      confidence: 0.85,
      _source: 'rule:voice-memo',
    };
  },

  /**
   * Photos with a receipt heuristic — large image dimensions but small file
   * size relative to dimensions, or filename hints (Photo_*, IMG_*, *receipt*).
   * Stub for now: any photo with "receipt" in the filename or vision output.
   */
  function receiptPhotoRule(item) {
    if (item.surface !== 'photo') return null;
    const fn = (item.content?.rawSurfaceMetadata?.filename ?? '').toLowerCase();
    const vision = lower(item.content?.vision);
    if (fn.includes('receipt') || vision.includes('receipt') || vision.includes('invoice')) {
      return {
        domain: 'personal',
        urgency: 'low',
        action: 'queue',
        suggested_route: 'beatrix',
        reasoning_summary: 'Photo looks like a receipt — queued for the finance specialist inside Beatrix.',
        confidence: 0.8,
        _source: 'rule:receipt-photo',
      };
    }
    return null;
  },

  /**
   * Self-Telegram messages — anything Omar sends himself in his own chat is
   * routed via LLM (no rule-based override), but with a confidence-bumping
   * hint that the principal is Omar.
   */
  function selfTelegramRule(item) {
    if (item.surface !== 'telegram') return null;
    const id = String(item.from?.identifier ?? '');
    if (SELF_TELEGRAM_IDS.includes(id)) {
      // Don't classify — just hint. Let the LLM decide.
      return {
        _hint_self: true,
      };
    }
    return null;
  },

  /**
   * Admin test surface always handles, never escalates.
   */
  function adminTestRule(item) {
    if (item.surface !== 'admin-test') return null;
    return null; // Let LLM classify; the surface itself signals dry-run.
  },
];

export function preClassify(item) {
  for (const rule of rules) {
    try {
      const result = rule(item);
      if (result) {
        if (Object.keys(result).every((k) => k.startsWith('_'))) {
          // Hint-only rule; keep going and merge with LLM later.
          continue;
        }
        log(`classifier.rules: matched ${result._source} surface=${item.surface}`);
        return result;
      }
    } catch (e) {
      log(`classifier.rules: rule threw: ${e.message}`);
    }
  }
  return null;
}

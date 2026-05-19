/**
 * Top-level classifier. Combines rule-based pre-classification with the LLM.
 *
 * Strategy:
 *   1. Run rule-based pre-classifier. If it returns high-confidence (>= 0.9), skip LLM.
 *   2. Otherwise run the LLM, merge with any rule-asserted fields.
 *   3. Always log both pre-classification and final classification to audit.
 */

import { preClassify } from './rules.mjs';
import { classifyLLM, initLLMClassifier } from './llm.mjs';
import { audit } from '../audit/index.mjs';
import { log } from '../log.mjs';

export function initClassifier(opts) {
  initLLMClassifier(opts);
}

export async function classify(item) {
  const startTs = Date.now();

  // Rule pass.
  const ruleResult = preClassify(item);

  let finalResult;
  if (ruleResult && (ruleResult.confidence ?? 0) >= 0.9) {
    // Skip LLM, use rule result.
    finalResult = { ...ruleResult, world_touching_action: ruleResult.world_touching_action ?? null };
    log(`classifier: rule-only classification (source=${ruleResult._source})`);
  } else {
    // LLM pass. Merge with rule hints if any.
    const llmResult = await classifyLLM(item);
    if (ruleResult) {
      // Rule asserts win for fields the rule set; LLM fills in the rest.
      finalResult = { ...llmResult, ...ruleResult, _source: `combined:${ruleResult._source}+${llmResult._source}` };
    } else {
      finalResult = llmResult;
    }
  }

  finalResult._latency_ms = Date.now() - startTs;

  audit.log({
    action: 'classify',
    target: finalResult.suggested_route,
    reasoning: finalResult.reasoning_summary,
    data: {
      intake_item_id: item.id,
      surface: item.surface,
      classification: finalResult,
      pre_classification: ruleResult,
    },
  });

  return finalResult;
}

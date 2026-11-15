import { decide } from "./policy.mjs";
import { shouldUseExactModel, THRESHOLDS } from "./config.mjs";

/** Stores `value` as the most recently used entry and drops the oldest beyond `max`. */
export function remember(map, key, value, max = 50) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
  return value;
}

const CONTEXT_CHARS = 2000;

/** Whether a conversation's prompt cache is probably still alive, given when it was last used. */
export const cacheIsWarm = (lastAt, now = Date.now()) =>
  lastAt != null && now - lastAt < THRESHOLDS.cacheTtlMs;

/**
 * Policy decides on tiers, but Jev's confidence is for one exact model. Codex lists several
 * models per tier (gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol), so a sure "strong" answer is split
 * between siblings and reads as p=0.35, which trips the low-confidence guard. Claude has one
 * model per tier, so nothing is added there.
 */
export function tierConfidence(jev, models, chosen) {
  const siblings = models.filter((m) => m.tier === chosen.tier && m.id !== chosen.id);
  const extra = siblings.reduce((sum, m) => sum + (jev.probabilities?.[m.id] ?? 0), 0);
  return Math.min(1, jev.confidence + extra);
}

/**
 * Asks Jev about one fresh user turn and resolves the model to run. Shared by both proxies so
 * the Claude and Codex paths cannot drift apart: only how the prompt is read and how the
 * request is rewritten differ between them.
 *
 * @param {object} input
 * @param {Array<{id: string, tier: string}>} input.models  models this account can run
 * @param {string} input.current      tier the conversation is on
 * @param {string} input.currentModel exact model the conversation is on
 * @param {boolean} input.cacheBuilt  whether an earlier routed turn built a cache on `current`
 * @param {(tier: string) => string} input.modelForTier model to use when policy picks a tier
 * @param {string} [input.context]    the assistant reply this prompt answers; Jev only, never policy
 */
export async function routeTurn({
  route,
  prompt,
  models,
  current,
  currentModel,
  contextTokens,
  cacheBuilt,
  modelForTier,
  newest = false,
  context,
}) {
  // Proposals and questions sit at the end of a reply, so its tail is the part worth sending.
  const tail = context && context.length > CONTEXT_CHARS ? `…${context.slice(-CONTEXT_CHARS)}` : context || undefined;
  const asked = await route({ prompt, context: tail, current: currentModel, contextTokens, models });
  const chosen = models.find((model) => model.id === asked?.choice);
  const jev = asked && chosen ? { ...asked, confidence: tierConfidence(asked, models, chosen) } : asked;
  const { tier, reason } = decide({
    prompt,
    jev: jev && { ...jev, choice: chosen?.tier },
    current,
    available: [...new Set(models.map((model) => model.tier))],
    contextTokens,
    cacheBuilt,
  });
  // Codex only: Jev tends to pick older siblings (gpt-5.6-*), which are no cheaper, and the catalog lists newest first,
  // so run the newest model of the accepted tier. Claude keeps the version Jev chose.
  const model = shouldUseExactModel(reason, chosen?.tier, tier)
    ? (newest ? models.find((m) => m.tier === chosen.tier) : chosen).id
    : tier === current
      ? currentModel
      : modelForTier(tier);
  return { tier, reason, model, jev };
}

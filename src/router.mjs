import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  effortEnabled,
  effortQuestion,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

/**
 * Stops asking a failing Jev for a while. Each failed ask costs the full deadline on every turn,
 * so after a few in a row the router keeps the current model without waiting.
 */
export function createBreaker({
  failures = THRESHOLDS.jevBreakerFailures,
  cooldownMs = THRESHOLDS.jevBreakerCooldownMs,
} = {}) {
  let count = 0;
  let openUntil = 0;
  return {
    open: (now = Date.now()) => now < openUntil,
    fail(now = Date.now()) {
      if (++count >= failures) {
        openUntil = now + cooldownMs;
        count = 0;
      }
    },
    ok() {
      count = 0;
    },
  };
}
const breaker = createBreaker();

function buildRequest({ prompt, context, current, contextTokens, models }) {
  return {
    state: {
      // A reply like "ok, do it" or "fix all 6" only means something next to what it answers.
      request: context
        ? `Previous assistant message (context for the request below):\n${context}\n\nUser request:\n${prompt}`
        : prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: {
      ...QUESTIONS,
      model: questionForModels(models),
      ...(effortEnabled() ? { effort: effortQuestion() } : {}),
    },
  };
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, context, current, contextTokens, models }) {
  if (!models?.length || breaker.open()) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const request = buildRequest({ prompt, context, current, contextTokens, models });
  try {
    const result = await getClient().systemOne(request, { signal: abort.signal });
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    breaker.ok();
    return {
      ...answer,
      effort: result.answers.effort?.choice ?? null,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    breaker.fail();
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

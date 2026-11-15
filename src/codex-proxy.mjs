import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { availableTiers, rankOf } from "./config.mjs";
import { forward } from "./forward.mjs";
import { askJev } from "./router.mjs";
import { debug, dumpBody } from "./log.mjs";
import { markManual, recordUsage, writeDecision } from "./status.mjs";
import { cacheIsWarm, remember, routeTurn } from "./turn.mjs";
import { usageFromBody } from "./usage.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
const DEFAULT_MODELS = {
  haiku: "gpt-6-luna",
  sonnet: "gpt-6.1-terra",
  opus: "gpt-6.1-sol",
  fable: "gpt-6-astra",
};
const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  const configured = Object.keys(DEFAULT_MODELS).find((tier) => codexModelOf(tier) === model);
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/** Exact GPT models in Codex's account catalog; configured ids are the cold-start fallback. */
export function codexModels(models = new Map()) {
  const available = [...models.values()]
    .filter((model) => model.slug !== CODEX_AUTO_MODEL && model.supported_in_api !== false && model.visibility !== "hide")
    .map((model) => ({
      id: model.slug,
      tier: codexTierOf(model.slug),
      description: [
        model.display_name,
        model.description,
        model.context_window && `${model.context_window} context tokens`,
      ].filter(Boolean).join("; "),
    }))
    .filter((model) => model.tier);
  return available.length
    ? available
    : Object.keys(DEFAULT_MODELS).map((tier) => ({
        id: codexModelOf(tier),
        tier,
        description: codexModelOf(tier),
      }));
}

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? codexModelOf(tier);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text" || item?.type === "output_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** Text of the assistant reply the new prompt answers, skipping the "[Jev] routed" notes we inject. */
export function codexPreviousReply(body) {
  if (!Array.isArray(body?.input)) return "";
  for (const item of [...body.input].reverse()) {
    if (item?.role !== "assistant") continue;
    const text = textOf(item.content).trim();
    if (text && !text.startsWith("[Jev]")) return text;
  }
  return "";
}

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    // Codex puts the project's AGENTS.md in a user message; a turn with no typed text (an image
    // only) must not fall back to it and send the whole file to Jev as the request.
    if (prompt && !isCodexAuxiliaryPrompt(prompt) && !/^# AGENTS\.md instructions/i.test(prompt)) return prompt;
  }
  return null;
}

export function codexConversationKey(body) {
  const stable =
    body?.client_metadata?.["x-codex-window-id"] ??
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) {
    return catalog;
  }
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  catalog.models.unshift({
    ...template,
    slug: CODEX_AUTO_MODEL,
    display_name: "Jev Router",
    description: "Jev picks the cheapest model that can complete each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
  });
  return catalog;
}

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Sets the request's reasoning effort to what Jev chose, up or down: the jev-router entry has a
 * fixed default effort, so lowering alone would leave hard turns on it. Jev's scale stops at
 * "high", so "high" never overrules a user who chose xhigh/max.
 */
export function setCodexEffort(body, effort) {
  if (!body.reasoning || !["low", "medium", "high"].includes(effort)) return;
  if (effort === "high" && CODEX_EFFORTS.indexOf(body.reasoning.effort) > CODEX_EFFORTS.indexOf("high")) return;
  body.reasoning.effort = effort;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  body.model = model;
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), confidence, reason }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}).`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const isExplainPrompt = (prompt) =>
  prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");

export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route = askJev,
  statusId = "",
} = {}) {
  const states = new Map();
  const models = new Map();

  const isModelsList = (req) => req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");

  // A spawned subagent names its own model (spawn_agent's `model`). As with Claude, that
  // model is a ceiling: Jev may pick cheaper, never dearer. Only a conversation that starts
  // after a routed main conversation counts as a subagent.
  function subagentCeilingOf(body, known) {
    if (body.model === CODEX_AUTO_MODEL || !codexTierOf(body.model)) return null;
    if (known) return known.ceiling ?? null;
    return [...states.values()].some((s) => s.model && !s.ceiling) ? codexTierOf(body.model) : null;
  }

  // Anything that is not the sentinel is a model the user chose: pass it through untouched.
  function passThroughUserChoice(body, key, known) {
    const prompt = codexNewTurnPrompt(body);
    if (!prompt || isExplainPrompt(prompt)) return;
    markManual(statusId);
    // Remember the conversation as manual so a later subagent check does not mistake it.
    if (!known) remember(states, key, { manual: true });
  }

  /** Asks Jev about a fresh user turn and remembers the answer for the turn's follow-ups. */
  async function routeFreshTurn({ body, prompt, key, known, ceiling, candidates, current, currentModel }) {
    const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
    const turn = await routeTurn({
      route,
      prompt,
      models: candidates,
      current,
      currentModel,
      contextTokens,
      cacheBuilt: known?.tier != null && cacheIsWarm(known?.lastAt),
      modelForTier: (t) => modelForTier(candidates, t),
      newest: true,
      context: codexPreviousReply(body),
    });
    let { tier, model } = turn;
    if (ceiling && rankOf(tier) > rankOf(ceiling)) {
      tier = ceiling;
      model = modelForTier(candidates, tier);
    }
    const effort = turn.jev?.effort ?? null;
    remember(states, key, { ...known, tier, model, effort, ...(ceiling ? { ceiling } : {}) });
    debug(`${key} ${current} -> ${tier} (${turn.reason}) | ${prompt.slice(0, 60)}`);
    return {
      tier,
      model,
      effort,
      routing: {
        prompt,
        tier,
        model,
        confidence: turn.jev?.confidence ?? null,
        metrics: turn.jev?.metrics ?? null,
        reason: turn.reason,
        jev: turn.jev ? { request: turn.jev.request, response: turn.jev.response } : null,
        at: Date.now(),
      },
    };
  }

  /**
   * Rewrites a sentinel request to the model chosen for its turn, asking Jev first when the
   * request opens a new turn. Returns the tier that served it, and the decision to announce.
   */
  async function routeAuto(body, key, known, subagentCeiling) {
    const ceiling = subagentCeiling ?? known?.ceiling ?? null;
    const candidates = codexModels(models).filter(
      (model) => availableTiers().includes(model.tier) && (!ceiling || rankOf(model.tier) <= rankOf(ceiling)),
    );
    // Jev leans toward the model it is told is current, so starting on the strongest
    // model made every Codex session answer "strongest". Start in the middle instead.
    const start = ceiling && rankOf(ceiling) < rankOf("sonnet") ? ceiling : "sonnet";
    const currentModel = known?.model ?? modelForTier(candidates, start);
    const current = codexTierOf(currentModel) ?? start;
    const prompt = codexNewTurnPrompt(body);

    const fresh =
      prompt && !isExplainPrompt(prompt)
        ? await routeFreshTurn({ body, prompt, key, known, ceiling, candidates, current, currentModel })
        : null;
    const { tier, model, effort } = fresh ?? { tier: current, model: currentModel, effort: known?.effort ?? null };

    // Any request refreshes the provider's cache; a long idle gap lets it expire.
    const routed = states.get(key);
    if (routed) routed.lastAt = Date.now();
    applyCodexTier(body, tier, models, model);
    setCodexEffort(body, effort);
    if (fresh) {
      // Read after both rewrites, so the decision shows the effort that was actually sent.
      fresh.routing.effort = body.reasoning?.effort ?? null;
      writeDecision(statusId, fresh.routing);
    }
    return { servedTier: tier, routing: fresh?.routing };
  }

  /** Routes a /responses request. Returns the body to send, the serving tier and the decision. */
  async function routeResponses(raw) {
    let body = null;
    try {
      body = JSON.parse(raw.toString());
      if (process.env.JEV_DUMP) dumpBody(body);
      const key = codexConversationKey(body);
      const known = states.get(key);
      const ceiling = subagentCeilingOf(body, known);
      let routed = {};
      if (body.model === CODEX_AUTO_MODEL || ceiling) routed = await routeAuto(body, key, known, ceiling);
      else passThroughUserChoice(body, key, known);
      return { out: Buffer.from(JSON.stringify(body)), ...routed };
    } catch (err) {
      debug(`codex passthrough, could not process body: ${err.message}`);
      // The sentinel is not a real model: sent as is, the request would fail instead of just
      // missing its routing.
      if (body?.model === CODEX_AUTO_MODEL) {
        applyCodexTier(body, "sonnet", models);
        return { out: Buffer.from(JSON.stringify(body)) };
      }
      return { out: raw };
    }
  }

  // Codex lists models first; the proxy adds its own entry and learns the catalog from it.
  function relayModelCatalog(response, res) {
    const headers = { ...response.headers };
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
      let data = Buffer.concat(chunks);
      try {
        const catalog = addJevModel(JSON.parse(data.toString()));
        for (const model of catalog.models) models.set(model.slug, model);
        data = Buffer.from(JSON.stringify(catalog));
        delete headers["content-length"];
      } catch (err) {
        debug(`could not extend Codex model catalog: ${err.message}`);
      }
      res.writeHead(response.statusCode, headers);
      res.end(data);
    });
  }

  // Splices a "[Jev] routed this turn…" note in after the stream's first event. Bytes, not
  // strings: a chunk can end in the middle of a multi-byte character, and decoding it here
  // would replace that character with U+FFFD.
  function relayWithDecision(response, res, routing) {
    let pending = Buffer.alloc(0);
    let inspected = false;
    response.on("data", (chunk) => {
      if (inspected) return void res.write(chunk);
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf("\n\n");
      // No event boundary in the first 64 KB: this is not an SSE stream we can splice into.
      if (end < 0 && pending.length < 65536) return;
      const split = end < 0 ? pending.length : end + 2;
      const first = pending.subarray(0, split);
      res.write(first);
      const isSSE = end >= 0 && /^(?:event|data):/m.test(first.toString());
      if (isSSE) res.write(jevDecisionEvents(routing));
      debug(`codex decision display ${isSSE ? "inject" : "skip"}`);
      if (split < pending.length) res.write(pending.subarray(split));
      pending = Buffer.alloc(0);
      inspected = true;
    });
    response.on("end", () => {
      if (pending.length) {
        debug("codex decision display skip");
        res.write(pending);
      }
      res.end();
    });
  }

  function recordResponseUsage(response, tier) {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () =>
      recordUsage(statusId, tier, usageFromBody(Buffer.concat(chunks), response.headers["content-encoding"])),
    );
  }

  function relay(response, req, res, { routing, servedTier }) {
    if (isModelsList(req)) return relayModelCatalog(response, res);
    // A compressed stream cannot be read or spliced as text, so it is passed through untouched.
    const announce =
      routing && response.statusCode >= 200 && response.statusCode < 300 && !response.headers["content-encoding"];
    const headers = { ...response.headers };
    if (announce) delete headers["content-length"];
    res.writeHead(response.statusCode, headers);
    if (servedTier && response.statusCode === 200) recordResponseUsage(response, servedTier);
    if (announce) relayWithDecision(response, res, routing);
    else response.pipe(res);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const routed =
        req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")
          ? await routeResponses(raw)
          : { out: raw };
      forward({
        target: upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL),
        req,
        res,
        headers: req.headers,
        body: routed.out,
        errorBody: (message) => ({ error: { message, type: "proxy_error" } }),
        onResponse: (response) => relay(response, req, res, routed),
      });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

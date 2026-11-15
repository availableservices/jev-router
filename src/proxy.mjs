import http from "node:http";
import { createHash } from "node:crypto";
import { TIERS, THRESHOLDS, tierOf, idOf, availableTiers, tierSpec, isAuto, rankOf } from "./config.mjs";
import { forward } from "./forward.mjs";
import { askJev } from "./router.mjs";
import { debug, dumpBody, log } from "./log.mjs";
import { markManual, recordUsage, writeDecision } from "./status.mjs";
import { cacheIsWarm, remember, routeTurn } from "./turn.mjs";
import { usageFromBody } from "./usage.mjs";

const EFFORTS = ["low", "medium", "high"];

/**
 * Lowers the request's reasoning effort to what Jev chose, never raises it. Claude Code's own
 * setting is the ceiling, the same way a sub-agent's model is.
 */
export function lowerEffort(body, effort) {
  const current = body.output_config?.effort;
  if (!EFFORTS.includes(effort) || !EFFORTS.includes(current)) return;
  if (EFFORTS.indexOf(effort) < EFFORTS.indexOf(current)) body.output_config.effort = effort;
}

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 *
 * Claude Code appends trailing `system` messages carrying hook output and tools added
 * mid-session, so the turn's user message is not always the last one. Only `system` is
 * skipped: a trailing `assistant` message still means the turn is already under way.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const messages = body?.messages ?? [];
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role === "system") index--;
  const last = messages[index];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  const prompt = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return prompt && !isClaudeAuxiliaryPrompt(prompt) ? prompt : null;
}

/** Text of the assistant reply the new prompt answers, or "" at the start of a conversation. */
export function previousReply(body) {
  const reply = body?.messages?.findLast((message) => message?.role === "assistant");
  if (typeof reply?.content === "string") return reply.content;
  if (!Array.isArray(reply?.content)) return "";
  return reply.content
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Requests Claude Code makes on its own inside the main conversation (next-prompt suggestions,
 * the "welcome back" recap). They carry tools like a real turn, but routing them would let a
 * background chore switch the conversation's model and throw away its prompt cache.
 */
const isClaudeAuxiliaryPrompt = (prompt) =>
  /^\[SUGGESTION MODE:|^The user stepped away and is coming back\./.test(prompt);

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

export async function startProxy({
  upstreamURL = ANTHROPIC_BASE_URL,
  route = askJev,
  catalogTtlMs = THRESHOLDS.catalogTtlMs,
} = {}) {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const catalog = new Map();
  let catalogAt = 0;
  let warnedNoPrompt = false;
  // Touching a conversation keeps it from being evicted while it is still in use.
  const stateFor = (key) => remember(convos, key, convos.get(key) ?? { tier: null });

  const isModelsList = (req) => req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");

  function addToCatalog(models) {
    for (const model of models ?? []) {
      if (tierOf(model?.id)) catalog.set(model.id, model);
    }
  }

  // Claude Code lists models only when it wants them, and `claude -p` never does, so the
  // account's catalog is fetched here with the request's own credentials. Without it routing
  // falls back to the built-in ids, which go stale as soon as a new model ships. It is
  // refreshed after `catalogTtlMs` so a long session also picks up models released meanwhile.
  const HOP_BY_HOP = ["host", "connection", "keep-alive", "content-length", "transfer-encoding", "accept-encoding"];
  async function ensureCatalog(headers) {
    if (catalog.size && Date.now() - catalogAt < catalogTtlMs) return;
    const forwarded = Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_BY_HOP.includes(k)));
    try {
      const response = await fetch(`${upstreamURL.replace(/\/$/, "")}/v1/models`, {
        headers: forwarded,
        signal: AbortSignal.timeout(THRESHOLDS.jevTimeoutMs),
      });
      addToCatalog((await response.json()).data);
    } catch (err) {
      debug(`could not fetch Claude model catalog: ${err.message}`);
    } finally {
      // Back off after a failed refresh only when there is an older catalog to keep using;
      // with none, the next turn should try again rather than stay on the built-in ids.
      if (catalog.size) catalogAt = Date.now();
    }
  }

  // A subagent names its own model, from its agent definition or the Agent tool's `model`.
  // That model is a ceiling, not an order: Jev may pick cheaper, never dearer. Only a
  // conversation that starts after a routed main conversation is a subagent, so a session
  // the user runs by hand from its first turn is left alone.
  function subagentCeilingOf(body, known) {
    if (isAuto(body.model) || !Array.isArray(body.tools)) return null;
    if (known) return known.ceiling ?? null;
    return [...convos.values()].some((s) => s.model && !s.ceiling) ? tierOf(body.model) : null;
  }

  // Anything that is not the sentinel is a model the user chose, and an explicit choice beats
  // the router. That also covers Claude Code's own cheap Haiku calls for titles and summaries,
  // which must never be pinned up to the session's tier.
  function passThroughUserChoice(body, key, known) {
    debug(`passthrough, user selected ${body.model}`);
    // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
    // calls carry no tools and must not flip the status line to manual mid-session.
    if (!Array.isArray(body.tools)) return;
    markManual(sessionOf(body));
    // Remember the conversation as manual, so its later turns are not mistaken for a
    // subagent once the user has picked a model.
    if (known) known.manual = true;
    else remember(convos, key, { tier: null, manual: true });
  }

  // A new conversation starts in the middle: Jev leans toward the model it is told is current
  // ("explain the codebase" measured opus 0.44 when told opus, sonnet 0.6 when told sonnet),
  // so starting on opus pulled borderline turns up to opus.
  const currentTierOf = (state) =>
    state.tier ?? (state.ceiling && rankOf(state.ceiling) < rankOf("sonnet") ? state.ceiling : "sonnet");

  // The request format is not a public contract. A conversation's first tool-bearing
  // request with no readable prompt means routing is silently off, so say so once.
  function warnOnceIfUnroutable(body, state, prompt) {
    if (prompt || state.tier != null || !body.tools?.length || warnedNoPrompt) return;
    warnedNoPrompt = true;
    log(
      "found no user prompt in this request, so it was not routed. Claude Code's request " +
        "format may have changed: re-run with JEV_DUMP=<path> and open an issue with the dump.",
    );
  }

  /** Asks Jev about a fresh user turn, records the answer on `state`, and returns what to publish. */
  async function routeFreshTurn({ body, prompt, state, current, warm, key, headers }) {
    await ensureCatalog(headers);
    const models = claudeModels([...catalog.values()]).filter(
      (model) =>
        availableTiers().includes(model.tier) && (!state.ceiling || rankOf(model.tier) <= rankOf(state.ceiling)),
    );
    const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
    let { tier, reason, model, jev } = await routeTurn({
      route,
      prompt,
      context: previousReply(body),
      models,
      current,
      currentModel: state.model ?? modelForTier(models, current),
      contextTokens,
      cacheBuilt: state.tier != null && warm,
      modelForTier: (t) => modelForTier(models, t),
    });
    if (state.ceiling && rankOf(tier) > rankOf(state.ceiling)) {
      tier = state.ceiling;
      model = modelForTier(models, tier);
      reason = `${reason}/capped-by-subagent`;
    }
    state.tier = tier;
    state.model = model;
    state.effort = jev?.effort ?? null;
    debug(
      `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
        `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
    );
    return {
      prompt,
      model,
      confidence: jev?.confidence ?? null,
      metrics: jev?.metrics ?? null,
      reason,
      jev: jev ? { request: jev.request, response: jev.response } : null,
    };
  }

  /**
   * Rewrites a sentinel request to the model chosen for its turn, asking Jev first when the
   * request opens a new turn. Returns where the response's token usage is filed.
   */
  async function routeAuto(body, key, subagentCeiling, headers) {
    const state = stateFor(key);
    // Any request refreshes the provider's cache; a long idle gap lets it expire.
    const warm = cacheIsWarm(state.lastAt);
    state.lastAt = Date.now();
    state.manual = false;
    if (subagentCeiling) state.ceiling = subagentCeiling;
    // What the prompt cache was built on, which is what a downgrade would discard.
    const current = currentTierOf(state);
    const prompt = newTurnPrompt(body);
    warnOnceIfUnroutable(body, state, prompt);
    const explaining = prompt?.includes("<jev-explain>");
    const fresh = prompt && !explaining ? await routeFreshTurn({ body, prompt, state, current, warm, key, headers }) : null;

    // The sentinel is not a real model, so every routed request must be rewritten,
    // including follow-ups that reuse the tier chosen for the turn.
    const tier = state.tier ?? current;
    const model = state.model ?? idOf(tier);
    debug(`${key} rewrite ${body.model} -> ${model}`);
    applyTier(body, tier, model);
    lowerEffort(body, state.effort);
    const session = sessionOf(body) || key;
    // Publish what went out. Claude Code's UI shows the row you picked, not the tier it resolved
    // to, so the status line is the only place this is visible. `claude -p` omits metadata on
    // the first request, so the conversation key stands in for the session id; it is also what
    // `debug` prints, so it is what a user passes to `jev-explain` for a print-mode run.
    // The effort is read after lowerEffort, so the status line shows what was actually sent.
    if (fresh) writeDecision(session, { tier, ...fresh, effort: body.output_config?.effort ?? null, at: Date.now() });
    return { session, tier };
  }

  /** Routes a /v1/messages request. Returns the body to send and where its usage is filed. */
  async function routeMessages(raw, headers) {
    let body = null;
    try {
      body = JSON.parse(raw.toString());
      // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
      if (process.env.JEV_DUMP) dumpBody(body);
      body.tools?.forEach((t) => sanitizeSchema(t.input_schema));
      const key = conversationKey(body);
      const known = convos.get(key);
      const ceiling = subagentCeilingOf(body, known);
      let usageTarget = null;
      if (isAuto(body.model) || ceiling) usageTarget = await routeAuto(body, key, ceiling, headers);
      else passThroughUserChoice(body, key, known);
      return { out: Buffer.from(JSON.stringify(body)), usageTarget };
    } catch (err) {
      debug(`passthrough, could not process body: ${err.message}`);
      // The sentinel is not a real model: sent as is, the request would fail instead of just
      // missing its routing.
      if (body && isAuto(body.model)) {
        applyTier(body, "sonnet");
        return { out: Buffer.from(JSON.stringify(body)), usageTarget: null };
      }
      return { out: raw, usageTarget: null };
    }
  }

  function relayModelList(up, res) {
    const chunks = [];
    up.on("data", (chunk) => chunks.push(chunk));
    up.on("end", () => {
      const data = Buffer.concat(chunks);
      try {
        addToCatalog(JSON.parse(data.toString()).data);
        if (catalog.size) catalogAt = Date.now();
      } catch (err) {
        debug(`could not read Claude model catalog: ${err.message}`);
      }
      const { "content-length": _dropped, ...headers } = up.headers;
      res.writeHead(up.statusCode, headers);
      res.end(data);
    });
  }

  // Report the model the API itself says it used, so the routing can be confirmed from the
  // wire rather than trusted from our own decision log. Claude Code's UI always shows the model
  // it asked for, never the one we rewrote to.
  function debugServedModel(up) {
    let seen = false;
    up.on("data", (chunk) => {
      if (seen) return;
      const served = /"model"\s*:\s*"([^"]+)"/.exec(chunk.toString("utf8"));
      if (!served) return;
      seen = true;
      debug(`${up.statusCode} served by ${served[1]}`);
    });
  }

  function recordResponseUsage(up, { session, tier }) {
    const chunks = [];
    up.on("data", (chunk) => chunks.push(chunk));
    up.on("end", () => recordUsage(session, tier, usageFromBody(Buffer.concat(chunks), up.headers["content-encoding"])));
  }

  function relay(up, req, res, usageTarget) {
    if (isModelsList(req)) return relayModelList(up, res);
    res.writeHead(up.statusCode, up.headers);
    if (process.env.JEV_DEBUG) debugServedModel(up);
    if (usageTarget && up.statusCode === 200) recordResponseUsage(up, usageTarget);
    up.pipe(res);
  }

  function upstreamHeaders(req) {
    const headers = { ...req.headers };
    // The model list is parsed here, and under JEV_DEBUG the stream is read back to see which
    // model served it, so neither can arrive compressed. Not worth the bandwidth otherwise.
    if (isModelsList(req) || process.env.JEV_DEBUG) delete headers["accept-encoding"];
    return headers;
  }

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const { out, usageTarget } = /^\/v1\/messages/.test(req.url ?? "")
        ? await routeMessages(raw, req.headers)
        : { out: raw, usageTarget: null };
      forward({
        target: upstreamURL,
        req,
        res,
        headers: upstreamHeaders(req),
        body: out,
        errorBody: (message) => ({ type: "error", error: { message } }),
        onResponse: (up) => relay(up, req, res, usageTarget),
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

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  conversationKey,
  previousReply,
  sessionOf,
  startProxy,
} from "../src/proxy.mjs";
import { tierOf } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, pruneStale, STATUS_DIR } from "../src/status.mjs";
import { mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf("jev-router"), null, "the sentinel is not a real tier");
  assert.equal(tierOf(undefined), null);
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          data: [
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          ],
        }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-4-8"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

// `claude -p` never lists models, so the catalog must come from the proxy itself, with the
// caller's credentials, and a model that did not exist when the code was written must work.
test("fetches the account catalog itself when Claude Code never asked for it", async (t) => {
  const seen = [];
  let auth;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) {
        auth = req.headers["x-api-key"];
        return res.end(JSON.stringify({ data: [{ id: "claude-opus-6-0" }, { id: "claude-haiku-6-0" }] }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-6-0"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), ["claude-opus-6-0", "claude-haiku-6-0"]);
      return { choice: "claude-opus-6-0", confidence: 0.9, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "refactor the parser" }],
    }),
  });

  assert.equal(auth, "sk-test", "the catalog is fetched with the caller's credentials");
  assert.equal(seen[0].model, "claude-opus-6-0");
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("previousReply reads the text of the last assistant message, not its tool calls", () => {
  const body = withTools([
    { role: "user", content: "audit the page" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "text", text: "I found 6 issues." }] },
    { role: "user", content: "fix all 6" },
  ]);
  assert.equal(previousReply(body), "I found 6 issues.");
  assert.equal(previousReply(withTools([{ role: "user", content: "hi" }])), "");
});

test("sanitizeSchema rewrites draft-04 boolean bounds anywhere in a schema", () => {
  const cases = [
    [{ minimum: 0, exclusiveMinimum: true }, { exclusiveMinimum: 0 }],
    [{ maximum: 10, exclusiveMaximum: false }, { maximum: 10 }],
    [{ exclusiveMinimum: 5 }, { exclusiveMinimum: 5 }],
  ];
  for (const [input, expected] of cases) {
    const schema = { anyOf: [{ items: input }], extra: null, n: 3 }; // nested, with primitives
    sanitizeSchema(schema);
    assert.deepEqual(schema.anyOf[0].items, expected);
  }
  assert.doesNotThrow(() => sanitizeSchema(null));
});

test("newTurnPrompt returns only the text of a genuinely new user turn", () => {
  const user = (content) => ({ role: "user", content });
  const toolResult = user([{ type: "tool_result", tool_use_id: "t1", content: "done" }]);
  const cases = [
    ["plain string", withTools([user("fix the bug")]), "fix the bug"],
    ["text block", withTools([user([{ type: "text", text: "fix the bug" }])]), "fix the bug"],
    // Claude Code appends these for SessionStart hook output and tools added mid-session.
    ["behind trailing system messages", withTools([user("fix the bug"), { role: "system", content: "hook" }]), "fix the bug"],
    ["system reminders stripped", withTools([user("fix the bug\n<system-reminder>be\ncareful</system-reminder>")]), "fix the bug"],
    ["tool continuation", withTools([user("fix"), { role: "assistant", content: "x" }, toolResult]), null],
    ["continuation behind a system message", withTools([user("fix"), toolResult, { role: "system", content: "hook" }]), null],
    ["auxiliary call without tools", { messages: [user("summarise this")] }, null],
    ["last message from the assistant", withTools([{ role: "assistant", content: "thinking" }]), null],
    ["empty", withTools([user("   ")]), null],
    ["only a system reminder", withTools([user("<system-reminder>noise</system-reminder>")]), null],
    ["suggestion chore", withTools([user("[SUGGESTION MODE: Suggest what the user might type]")]), null],
    ["welcome-back recap", withTools([user("The user stepped away and is coming back. Recap.")]), null],
    ["malformed", undefined, null],
    ["no messages", { tools: [], messages: [] }, null],
  ];
  for (const [name, body, expected] of cases) assert.equal(newTurnPrompt(body), expected, name);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("refetches the account catalog once it is older than the TTL", async (t) => {
  let listing = [{ id: "claude-opus-5-5" }];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(req.url.startsWith("/v1/models") ? JSON.stringify({ data: listing }) : "{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const offered = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    catalogTtlMs: 0,
    route: async ({ models }) => {
      offered.push(models.map((model) => model.id));
      return null;
    },
  });
  t.after(close);

  const turn = (text) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-router", tools: [{ name: "Bash" }], messages: [{ role: "user", content: text }] }),
    });
  await turn("first question");
  listing = [{ id: "claude-opus-5-5" }, { id: "claude-opus-6-0" }];
  await turn("second question");

  assert.deepEqual(offered[0], ["claude-opus-5-5"]);
  assert.deepEqual(offered[1], ["claude-opus-5-5", "claude-opus-6-0"], "a model released mid-session is picked up");
});

test("warns once when a request carries tools but no readable prompt", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("{}"));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => assert.fail("nothing to route"),
  });
  t.after(close);

  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  try {
    for (let i = 0; i < 2; i++) {
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "jev-router",
          tools: [{ name: "Bash" }],
          messages: [{ role: "mystery", content: "an unknown message role" }],
        }),
      });
    }
  } finally {
    process.stderr.write = write;
  }
  assert.equal(lines.filter((line) => line.includes("found no user prompt")).length, 1);
});

// A subagent names its own model; that model is a ceiling. Helpers below run one proxy with a
// fixed account catalog and record what reached the upstream API.
async function ceilingProxy(t, route) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) {
        return res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }] }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end('{"id":"msg_1","type":"message"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const proxy = await startProxy({ upstreamURL: `http://127.0.0.1:${upstream.address().port}`, route });
  t.after(proxy.close);
  const send = (model, text, session) =>
    fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        tools: [{ name: "Bash" }],
        messages: [{ role: "user", content: text }],
      }),
    });
  return { seen, send };
}

test("a subagent's explicit model is a ceiling: Jev never picks above it", async (t) => {
  const asked = [];
  const { seen, send } = await ceilingProxy(t, async ({ prompt, models }) => {
    asked.push({ prompt, ids: models.map((model) => model.id) });
    return { choice: "claude-opus-5-5", confidence: 0.95, ms: 1 };
  });
  const session = `ceiling-${process.pid}-a`;
  await send("jev-router", "main task", session);
  await send("claude-sonnet-5-5", "research the library", session);

  assert.deepEqual(asked[1].ids, ["claude-haiku-5-5", "claude-sonnet-5-5"], "Opus is not offered to Jev");
  assert.equal(seen.at(-1).model, "claude-sonnet-5-5", "Jev's Opus choice falls back to the ceiling");
});

test("a subagent's explicit model still lets Jev pick a cheaper one", async (t) => {
  const { seen, send } = await ceilingProxy(t, async ({ prompt }) => ({
    choice: prompt.startsWith("research") ? "claude-haiku-5-5" : "claude-opus-5-5",
    confidence: 0.95,
    ms: 1,
  }));
  const session = `ceiling-${process.pid}-b`;
  await send("jev-router", "main task", session);
  await send("claude-opus-5-5", "research the library", session);

  assert.equal(seen.at(-1).model, "claude-haiku-5-5");
  assert.notEqual(readStatus(session)?.manual, true, "a subagent does not mark the session manual");
});

test("a session the user runs by hand from the first turn is not treated as a subagent", async (t) => {
  let routed = false;
  const { seen, send } = await ceilingProxy(t, async () => {
    routed = true;
    return null;
  });
  const session = `ceiling-${process.pid}-c`;
  await send("claude-opus-5-5", "a question I chose the model for", session);

  assert.equal(routed, false);
  assert.equal(seen.at(-1).model, "claude-opus-5-5");
  assert.equal(readStatus(session)?.manual, true);
});

test("picking a model by hand in a routed conversation still wins over the router", async (t) => {
  const { seen, send } = await ceilingProxy(t, async () => ({ choice: "claude-haiku-5-5", confidence: 0.95, ms: 1 }));
  const session = `ceiling-${process.pid}-d`;
  await send("jev-router", "main task", session);
  await send("claude-opus-5-5", "main task", session);

  assert.equal(seen.at(-1).model, "claude-opus-5-5");
  assert.equal(readStatus(session)?.manual, true);
});

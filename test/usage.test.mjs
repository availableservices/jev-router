import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { costOf, parseUsage, priceTable } from "../src/usage.mjs";
import { heldReason, summarize, formatReport } from "../src/report.mjs";
import { readStatus, recordUsage, writeDecision, markManual } from "../src/status.mjs";
import { lowerEffort } from "../src/proxy.mjs";

const sse = (...events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("reads Claude's streamed usage: input from start, output from the final delta", () => {
  const text = sse(
    { type: "message_start", message: { usage: { input_tokens: 25, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 57 } },
  );
  assert.deepEqual(parseUsage(text), { input: 25, output: 57, cacheRead: 900, cacheWrite: 40 });
});

test("reads a whole (non-streamed) Claude response", () => {
  const text = JSON.stringify({ usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  assert.deepEqual(parseUsage(text), { input: 3, output: 7, cacheRead: 0, cacheWrite: 0 });
});

test("reads Codex's completed event and keeps cached input out of the uncached count", () => {
  const text = sse({
    type: "response.completed",
    response: { usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 800 } } },
  });
  assert.deepEqual(parseUsage(text), { input: 200, output: 200, cacheRead: 800, cacheWrite: 0 });
});

test("a body with no usage, or garbage, reads as zero", () => {
  assert.deepEqual(parseUsage("event: ping\ndata: not json\n\n"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("cost is per million tokens and absent without a price", () => {
  const usage = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(costOf(usage, { input: 1, output: 4 }), 3);
  assert.equal(costOf(usage, undefined), null);
  assert.deepEqual(priceTable({ JEV_PRICES: '{"haiku":{"input":1}}' }), { haiku: { input: 1 } });
  assert.deepEqual(priceTable({ JEV_PRICES: "not json" }), {});
});

test("token totals survive a later routing decision and a switch to manual", () => {
  const session = `usage-${process.pid}-a`;
  writeDecision(session, { tier: "haiku", reason: "jev", at: 1 });
  recordUsage(session, "haiku", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  recordUsage(session, "haiku", { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 });
  writeDecision(session, { tier: "opus", reason: "jev", at: 2 });
  markManual(session);
  const status = readStatus(session);
  assert.equal(status.usage.haiku.input, 12);
  assert.equal(status.usage.haiku.requests, 2);
  assert.equal(status.manual, true);
  assert.equal(status.history.length, 2);
});

test("the report adds up sessions and names the reasons routing held a model", () => {
  const sessions = [
    {
      usage: { haiku: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, requests: 2 } },
      history: [{ tier: "haiku", reason: "jev" }, { tier: "opus", reason: "downgrade-not-worth-cache-rebuild" }],
    },
    {
      usage: { haiku: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 } },
      manual: true,
      history: [{ reason: "low-confidence-no-downgrade" }],
    },
  ];
  const s = summarize(sessions, { haiku: { input: 1 } });
  assert.equal(s.usage.haiku.input, 150);
  assert.equal(s.usage.haiku.requests, 3);
  assert.equal(s.manual, 1);
  assert.deepEqual(s.held, { "cache rebuild avoided": 1, "low confidence": 1 });
  assert.equal(s.decisions.unknown, 1, "a decision from an older file is counted, not dropped");
  assert.match(formatReport(s), /Estimated cost: 0\.000150/);
});

test("the report says why no cost is shown when prices are missing", () => {
  const s = summarize([{ usage: { sonnet: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } } }], {});
  assert.match(formatReport(s), /no price for sonnet/);
  assert.equal(heldReason("jev"), null);
});

test("lowering effort only ever lowers it", () => {
  const body = () => ({ output_config: { effort: "high" } });
  let b = body(); lowerEffort(b, "low"); assert.equal(b.output_config.effort, "low");
  b = body(); lowerEffort(b, "medium"); assert.equal(b.output_config.effort, "medium");
  b = body(); lowerEffort(b, "high"); assert.equal(b.output_config.effort, "high");
  b = { output_config: { effort: "low" } }; lowerEffort(b, "high"); assert.equal(b.output_config.effort, "low", "never raised");
  b = { output_config: { effort: "high" } }; lowerEffort(b, "bogus"); assert.equal(b.output_config.effort, "high");
  b = { model: "claude-haiku-5-5" }; lowerEffort(b, "low"); assert.equal(b.output_config, undefined, "no effort field to lower");
});

test("the status line explains a held downgrade and says what to do", () => {
  const session = `statusline-${process.pid}`;
  writeDecision(session, { tier: "opus", model: "claude-opus-5-5", reason: "downgrade-not-worth-cache-rebuild", confidence: 0.9, effort: "low", at: 1 });
  const bin = fileURLToPath(new URL("../bin/jev-statusline.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [bin], { input: JSON.stringify({ session_id: session }), encoding: "utf8" });
  assert.match(run.stdout, /downgrade-not-worth-cache-rebuild: \/compact or \/clear to allow the downgrade/);
  assert.match(run.stdout, /\(p=0\.90 · effort low\)/, "effort sits beside the confidence");
});

test("a routed turn's effort is applied to the request and kept for its follow-ups", async (t) => {
  const { startProxy } = await import("../src/proxy.mjs");
  const http = (await import("node:http")).default;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) {
        return res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }] }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end('{"id":"msg_1","type":"message","usage":{"input_tokens":10,"output_tokens":4}}');
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(() => upstream.close());
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.95, ms: 1, effort: "low" }),
  });
  t.after(close);

  const session = `effort-${process.pid}`;
  const send = (text) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-router",
        metadata: { user_id: JSON.stringify({ session_id: session }) },
        output_config: { effort: "high" },
        tools: [{ name: "Bash" }],
        messages: [{ role: "user", content: text }],
      }),
    });
  await send("rename the variable");
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      metadata: { user_id: JSON.stringify({ session_id: session }) },
      output_config: { effort: "high" },
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "rename the variable" }, { role: "assistant", content: "ok" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "done" }] }],
    }),
  });

  assert.equal(seen[0].output_config.effort, "low");
  assert.equal(seen[1].output_config.effort, "low", "a tool continuation keeps the turn's effort");
  // Both responses count: two requests of 4 output tokens each, against the tier that served them.
  assert.equal(readStatus(session).usage.sonnet.output, 8);
  assert.equal(readStatus(session).usage.sonnet.requests, 2);
  assert.equal(readStatus(session).effort, "low", "the status line shows the effort that was sent");
});

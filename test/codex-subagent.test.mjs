import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startCodexProxy } from "../src/codex-proxy.mjs";

// Shape of a real Codex request, reduced to what routing reads. Agents in one tree share
// prompt_cache_key; each agent has its own window id, which is what tells them apart.
const CATALOG = { models: [{ slug: "gpt-6-luna" }, { slug: "gpt-6.1-terra" }, { slug: "gpt-6.1-sol" }] };
const turn = (model, window, text) => ({
  model,
  prompt_cache_key: "one-tree",
  client_metadata: { "x-codex-window-id": window },
  instructions: "",
  input: [
    { type: "additional_tools", role: "developer", tools: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
  ],
});

test("a Codex subagent's explicit model is a ceiling, and it does not move the main agent", async (t) => {
  const seen = [];
  const asked = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify(CATALOG));
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end("{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: base,
    apiBaseURL: base,
    route: async ({ models }) => {
      asked.push(models.map((model) => model.id));
      return { choice: "gpt-6.1-sol", confidence: 0.95, ms: 1 };
    },
  });
  t.after(close);

  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  await post(turn("jev-router", "window-main", "main task"));
  await post(turn("gpt-6.1-terra", "window-sub", "research the library"));
  // The main agent's next request is a tool continuation: no new prompt, same window.
  const continuation = turn("jev-router", "window-main", "main task");
  continuation.input.push({ type: "function_call_output", call_id: "c1", output: "done" });
  await post(continuation);

  assert.deepEqual(asked[1], ["gpt-6-luna", "gpt-6.1-terra"], "Opus is not offered to Jev for the subagent");
  assert.equal(seen[1].model, "gpt-6.1-terra", "Jev's Opus choice falls back to the ceiling");
  assert.equal(seen[2].model, "gpt-6.1-sol", "the main agent keeps its own model");
});

test("a new Codex session starts on the middle model, so Jev is not anchored to the strongest", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(req.method === "GET" ? JSON.stringify(CATALOG) : "{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const currents = [];
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: base,
    apiBaseURL: base,
    route: async ({ current }) => {
      currents.push(current);
      return { choice: "gpt-6-luna", confidence: 0.9, ms: 1 };
    },
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(turn("jev-router", "window-fresh", "explain the codebase")),
  });
  assert.deepEqual(currents, ["gpt-6.1-terra"]);
});

test("Jev's effort sets Codex's reasoning effort for the turn and its follow-ups, but high never lowers xhigh", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify(CATALOG));
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end("{}");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let effort = "low";
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: base,
    apiBaseURL: base,
    route: async () => ({ choice: "gpt-6-luna", confidence: 0.9, ms: 1, effort }),
  });
  t.after(close);
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const withEffort = (body, level) => ({ ...body, reasoning: { effort: level } });

  await post(withEffort(turn("jev-router", "w1", "rename a variable"), "xhigh"));
  const next = withEffort(turn("jev-router", "w1", "rename a variable"), "xhigh");
  next.input.push({ type: "function_call_output", call_id: "c1", output: "done" });
  await post(next);
  effort = "high";
  await post(withEffort(turn("jev-router", "w2", "debug the race"), "xhigh"));
  effort = "medium";
  await post(withEffort(turn("jev-router", "w3", "add a test"), "low"));

  assert.equal(seen[0].reasoning.effort, "low");
  assert.equal(seen[1].reasoning.effort, "low", "a tool continuation keeps the turn's effort");
  assert.equal(seen[2].reasoning.effort, "xhigh", "Jev's high never overrules the user's higher choice");
  assert.equal(seen[3].reasoning.effort, "medium", "raised from the low default when Jev says medium");
});

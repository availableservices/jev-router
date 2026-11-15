import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { once } from "node:events";
import { startProxy } from "../src/proxy.mjs";
import { startCodexProxy } from "../src/codex-proxy.mjs";
import { createBreaker } from "../src/router.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const CATALOG = {
  models: [
    { slug: "gpt-6-luna", visibility: "list" },
    { slug: "gpt-6.1-terra", visibility: "list" },
    { slug: "gpt-reserve", visibility: "hide" },
    { slug: "gpt-6.1-sol", visibility: "list" },
  ],
};
const codexTurn = (window, text, extra = []) => ({
  model: "jev-router",
  prompt_cache_key: "tree",
  client_metadata: { "x-codex-window-id": window },
  instructions: "",
  input: [
    { type: "additional_tools", role: "developer", tools: [] },
    ...extra,
    { type: "message", role: "user", content: [{ type: "input_text", text }] },
  ],
});

/** Codex upstream: serves the catalog on GET and `respond(req, res, body)` on POST. */
async function codexUpstream(t, respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(CATALOG));
      }
      const body = JSON.parse(Buffer.concat(chunks));
      seen.push(body);
      respond?.(req, res, body);
    });
  });
  await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { seen, base: `http://127.0.0.1:${server.address().port}` };
}

async function codexProxy(t, upstream, route) {
  const { port, close } = await startCodexProxy({ chatgptBaseURL: upstream.base, apiBaseURL: upstream.base, route });
  t.after(close);
  // Codex lists models first; the proxy learns the catalog from that response.
  await fetch(`http://127.0.0.1:${port}/models`).then((r) => r.json());
  return (body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
}

test("Claude: when the client hangs up, the upstream request is cancelled", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      const timer = setInterval(() => res.write("event: ping\ndata: {}\n\n"), 20);
      res.on("close", () => {
        clearInterval(timer);
        upstream.emit("upstream-closed");
      });
    });
  });
  await listen(upstream);
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => null,
  });
  t.after(close);

  const abort = new AbortController();
  const closed = once(upstream, "upstream-closed");
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    signal: abort.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", tools: [{ name: "x" }], messages: [{ role: "user", content: "hi" }] }),
  });
  await response.body.getReader().read(); // the stream is flowing
  abort.abort();
  // Without the fix this never resolves and the test times out.
  await closed;
});

test("Claude: a routing failure never sends the sentinel model upstream", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) return res.end(JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }] }));
      seen.push(JSON.parse(Buffer.concat(chunks)).model);
      res.end("{}");
    });
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => {
      throw new Error("boom");
    },
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-router", tools: [{ name: "x" }], messages: [{ role: "user", content: "rename a var" }] }),
  });
  assert.equal(seen[0], "claude-sonnet-5-5");
});

test("Codex: a compressed response still decodes to what upstream sent", async (t) => {
  const sse = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n';
  const gz = zlib.gzipSync(sse);
  const upstream = await codexUpstream(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
    res.end(gz);
  });
  const send = await codexProxy(t, upstream, async () => ({ choice: "gpt-6-luna", confidence: 0.9, ms: 1 }));
  // fetch decompresses for us; before the fix the proxy mangled the bytes and decoding threw.
  const response = await send(codexTurn("w", "rename a variable"));
  assert.equal(await response.text(), sse);
});

test("Codex: text split mid-character between chunks arrives intact, with the decision injected", async (t) => {
  const text =
    'event: response.created\ndata: {"type":"response.created"}\n\nevent: x\ndata: {"t":"Tiếng Việt"}\n\n';
  const bytes = Buffer.from(text);
  const cut = bytes.indexOf(Buffer.from("ế")) + 1; // inside the 3-byte character
  const upstream = await codexUpstream(t, async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(bytes.subarray(0, cut));
    await sleep(50);
    res.end(bytes.subarray(cut));
  });
  const send = await codexProxy(t, upstream, async () => ({ choice: "gpt-6-luna", confidence: 0.9, ms: 1 }));
  const out = await (await send(codexTurn("w", "rename a variable"))).text();
  assert.ok(out.includes("Tiếng Việt"));
  assert.ok(!out.includes("�"));
  assert.ok(out.includes("[Jev] routed this turn"));
});

test("Codex: $jev-explain is not routed, and an image-only turn does not send AGENTS.md to Jev", async (t) => {
  const upstream = await codexUpstream(t, (req, res) => res.end("{}"));
  const asked = [];
  const send = await codexProxy(t, upstream, async ({ prompt }) => {
    asked.push(prompt);
    return { choice: "gpt-6-luna", confidence: 0.9, ms: 1 };
  });
  await send(codexTurn("a", "$jev-explain why did it pick that model"));
  const agents = { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\n\nBe nice." }] };
  const imageOnly = codexTurn("b", "");
  imageOnly.input = [imageOnly.input[0], agents, { type: "message", role: "user", content: [{ type: "input_image", image_url: "x" }] }];
  await send(imageOnly);
  assert.deepEqual(asked, []);
  assert.equal(upstream.seen[0].model, "gpt-6.1-terra", "unrouted turns still get a real model");
});

test("Codex: a routing failure never sends the sentinel model upstream", async (t) => {
  const upstream = await codexUpstream(t, (req, res) => res.end("{}"));
  const send = await codexProxy(t, upstream, async () => {
    throw new Error("boom");
  });
  await send(codexTurn("w", "rename a variable"));
  assert.notEqual(upstream.seen[0].model, "jev-router");
});

test("Codex: models hidden from the picker are not offered to Jev", async (t) => {
  const upstream = await codexUpstream(t, (req, res) => res.end("{}"));
  let offered;
  const send = await codexProxy(t, upstream, async ({ models }) => {
    offered = models.map((model) => model.id);
    return { choice: "gpt-6-luna", confidence: 0.9, ms: 1 };
  });
  await send(codexTurn("w", "rename a variable"));
  assert.ok(!offered.includes("gpt-reserve"));
  assert.ok(offered.includes("gpt-6.1-terra"));
});

test("Claude: a new conversation starts on the middle model, so Jev is not anchored to opus", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) {
        return res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }] }));
      }
      res.end("{}");
    });
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const currents = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ current }) => {
      currents.push(current);
      return null;
    },
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-router", tools: [{ name: "x" }], messages: [{ role: "user", content: "explain the codebase" }] }),
  });
  assert.deepEqual(currents, ["claude-sonnet-5-5"]);
});

test("the breaker opens after repeated failures, closes after the cooldown, and resets on success", () => {
  const breaker = createBreaker({ failures: 3, cooldownMs: 1_000 });
  breaker.fail(0);
  breaker.fail(0);
  breaker.ok();
  breaker.fail(0);
  breaker.fail(0);
  assert.equal(breaker.open(1), false, "a success in between resets the count");
  breaker.fail(0);
  assert.equal(breaker.open(500), true);
  assert.equal(breaker.open(1_001), false);
});

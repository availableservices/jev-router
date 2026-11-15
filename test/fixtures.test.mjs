// Canary tests against request bodies recorded from the real CLIs (see test/fixtures/redact.mjs).
// The other suites build requests by hand, so they only prove the code agrees with itself;
// these prove it still agrees with what Claude Code and Codex actually send. When a CLI
// update breaks routing, record a fresh dump, redact it, and replace the fixture.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTurnPrompt, startProxy } from "../src/proxy.mjs";
import { codexNewTurnPrompt, startCodexProxy } from "../src/codex-proxy.mjs";
import { dumpBody } from "../src/log.mjs";
import { redact } from "./fixtures/redact.mjs";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** Upstream that records every body it receives and answers with an empty message. */
async function recordingUpstream(t, models = []) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return res.end(JSON.stringify({ data: models }));
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

test("Claude Code: reads the prompt from a real request that ends in system messages", () => {
  const body = load("claude-print-request.json");
  assert.equal(body.messages.at(-1).role, "system", "the fixture must keep the shape that broke routing");
  assert.equal(newTurnPrompt(body), "what is 2+2?");
});

test("Claude Code: a real request routes end to end", async (t) => {
  const upstream = await recordingUpstream(t, [{ id: "claude-haiku-9-9" }, { id: "claude-opus-9-9" }]);
  let asked;
  const { port, close } = await startProxy({
    upstreamURL: upstream.url,
    route: async ({ prompt, models }) => {
      asked = { prompt, ids: models.map((model) => model.id) };
      return { choice: "claude-haiku-9-9", confidence: 0.95, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(load("claude-print-request.json")),
  });

  assert.equal(asked?.prompt, "what is 2+2?", "Jev was asked about the user's prompt");
  assert.deepEqual(asked.ids, ["claude-haiku-9-9", "claude-opus-9-9"]);
  assert.equal(upstream.seen[0].model, "claude-haiku-9-9");
});

test("Claude Code: a tool continuation of the real request is not routed again", () => {
  const body = load("claude-print-request.json");
  body.messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "4" }] },
    { role: "system", content: [{ type: "text", text: "hook output" }] },
  );
  assert.equal(newTurnPrompt(body), null);
});

test("Codex: reads the prompt from a real request", () => {
  assert.equal(codexNewTurnPrompt(load("codex-exec-request.json")), "what is 2+2?");
});

test("Codex: a real request routes end to end", async (t) => {
  const upstream = await recordingUpstream(t);
  let asked;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: upstream.url,
    apiBaseURL: upstream.url,
    route: async ({ prompt, models }) => {
      asked = { prompt, models };
      return { choice: models.find((model) => model.tier === "sonnet").id, confidence: 0.95, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(load("codex-exec-request.json")),
  });

  assert.equal(asked?.prompt, "what is 2+2?");
  assert.equal(upstream.seen[0].model, asked.models.find((model) => model.tier === "sonnet").id);
});

test("fixtures carry no identifiers", () => {
  for (const name of ["claude-print-request.json", "codex-exec-request.json"]) {
    const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /@[\w-]+\.\w+|device_id":"[0-9a-f]{8}|account_uuid":"[0-9a-f]{8}/, name);
  }
});

test("redact keeps structure and the chosen prompt, and drops everything else", () => {
  const out = redact(
    {
      metadata: { user_id: JSON.stringify({ device_id: "dev-secret", account_uuid: "acct-secret", session_id: "s" }) },
      messages: [{ role: "user", content: [{ type: "text", text: "my secret plan" }, { type: "text", text: "keep me" }] }],
      tools: [{ name: "a", input_schema: { big: 1 } }, { name: "b" }, { name: "c" }],
      client_metadata: { "x-codex-turn-metadata": "install-secret" },
    },
    { keep: "keep me" },
  );
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /dev-secret|acct-secret|my secret plan|install-secret/);
  assert.match(text, /keep me/);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.tools.length, 2);
  assert.deepEqual(out.tools[0].input_schema, { type: "object" });
});

test("JEV_DUMP files are written for the owner only", { skip: process.platform === "win32" }, () => {
  const base = `jev-dump-test-${process.pid}`;
  process.env.JEV_DUMP = join(tmpdir(), base);
  try {
    dumpBody({ messages: [] });
  } finally {
    delete process.env.JEV_DUMP;
  }
  const [name] = readdirSync(tmpdir()).filter((entry) => entry.startsWith(`${base}.`));
  assert.ok(name, "a dump file was written");
  const file = join(tmpdir(), name);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  rmSync(file);
});

test("a failed JEV_DUMP write never throws into the request path", () => {
  process.env.JEV_DUMP = join(tmpdir(), "jev-no-such-dir", "nested", "dump");
  try {
    assert.doesNotThrow(() => dumpBody({ messages: [] }));
  } finally {
    delete process.env.JEV_DUMP;
  }
});

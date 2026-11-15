import test from "node:test";
import assert from "node:assert/strict";
import { failures, routingFired, runDoctor, whyNotRouted } from "../src/doctor.mjs";

const answer = async () => ({ choice: "claude-haiku-5-5", confidence: 0.93, ms: 210 });
const installed = { file: "/usr/bin/tool" };
const byName = (checks, name) => checks.find((check) => check.name.startsWith(name));

test("a healthy install has no failures", async () => {
  const checks = await runDoctor({ env: { JEV_API_KEY: "k" }, ask: answer, claude: installed, codex: installed });
  assert.deepEqual(failures(checks), []);
  assert.match(byName(checks, "Jev answers").detail, /210ms, chose claude-haiku-5-5 \(p=0\.93\)/);
});

test("a missing key fails and never calls Jev", async () => {
  const checks = await runDoctor({
    env: {},
    ask: () => assert.fail("must not call Jev without a key"),
    claude: installed,
  });
  assert.equal(byName(checks, "Jev API key").ok, false);
  assert.equal(byName(checks, "Jev answers"), undefined);
  assert.equal(failures(checks).length, 1);
});

test("the TypeSafe key name is accepted too", async () => {
  const checks = await runDoctor({ env: { TYPESAFE_API_KEY: "k" }, ask: answer, claude: installed });
  assert.equal(byName(checks, "Jev API key").ok, true);
});

test("an unreachable Jev fails with a reason", async () => {
  const checks = await runDoctor({ env: { JEV_API_KEY: "k" }, ask: async () => null, claude: installed });
  assert.equal(byName(checks, "Jev answers").ok, false);
  assert.match(byName(checks, "Jev answers").detail, /network/);
});

test("a CLI the user does not use is a warning, not a failure", async () => {
  const checks = await runDoctor({ env: { JEV_API_KEY: "k" }, ask: answer, claude: installed, codex: null });
  assert.equal(byName(checks, "Codex").ok, false);
  assert.deepEqual(failures(checks), []);
});

test("an old Node version fails", async () => {
  const checks = await runDoctor({ env: { JEV_API_KEY: "k" }, ask: answer, nodeVersion: "20.11.0" });
  assert.equal(byName(checks, "Node.js").ok, false);
  const newer = await runDoctor({ env: { JEV_API_KEY: "k" }, ask: answer, nodeVersion: "22.1.0" });
  assert.equal(byName(newer, "Node.js").ok, true);
});

test("routingFired recognises both CLIs' debug lines and nothing else", () => {
  assert.equal(routingFired("[jev] 0b3e678fe4d4 328ms p=1.00 opus -> haiku (jev) ctx~11548 | hi"), true);
  assert.equal(routingFired("[jev] b21e5fe73768 opus -> opus (downgrade-not-worth-cache-rebuild/no-change) | hi"), true);
  assert.equal(routingFired("[jev] 0b3e678fe4d4 rewrite jev-router -> claude-opus-5-5"), false);
  assert.equal(routingFired("[jev] 200 served by claude-opus-5-5"), false);
});

test("whyNotRouted points at a changed request format when the proxy said so", () => {
  assert.match(whyNotRouted("[jev] found no user prompt in this request"), /request format has changed/);
  assert.match(whyNotRouted(""), /no routing decision was logged/);
});

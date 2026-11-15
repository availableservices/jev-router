import test from "node:test";
import assert from "node:assert/strict";
import { remember, routeTurn } from "../src/turn.mjs";

const models = [
  { id: "m-fast", tier: "haiku" },
  { id: "m-fast-old", tier: "haiku" },
  { id: "m-strong", tier: "opus" },
];
const base = {
  prompt: "refactor the parser",
  models,
  current: "opus",
  currentModel: "m-strong",
  contextTokens: 0,
  cacheBuilt: true,
  modelForTier: (tier) => `default-${tier}`,
};
const answer = (choice, confidence = 0.95) => async () => ({ choice, confidence, ms: 1 });

test("probability split between same-tier models still counts as one confident tier", async () => {
  // Jev spreads a sure "fast" answer over both fast models: 0.20 alone would block the downgrade.
  const route = async () => ({ choice: "m-fast", confidence: 0.2, probabilities: { "m-fast": 0.3, "m-fast-old": 0.15 }, ms: 1 });
  const out = await routeTurn({ ...base, route });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "jev");
  assert.ok(Math.abs(out.jev.confidence - 0.35) < 1e-9);
  // One model per tier (Claude): nothing is added, so a low answer is still held.
  const lone = async () => ({ choice: "m-fast", confidence: 0.2, probabilities: { "m-fast": 0.9 }, ms: 1 });
  const held = await routeTurn({ ...base, models: [models[0], models[2]], route: lone });
  assert.equal(held.reason, "low-confidence-no-downgrade/no-change");
});

test("the reply a prompt answers goes to Jev, clipped to its tail, and never to the override check", async () => {
  let sent;
  const route = async ({ context }) => {
    sent = context;
    return { choice: "m-fast", confidence: 0.95, ms: 1 };
  };
  const reply = `use opus ${"x".repeat(3000)} I propose fixing items 1-6.`;
  const out = await routeTurn({ ...base, prompt: "ok, do all 6", context: reply, route });
  assert.ok(sent.endsWith("I propose fixing items 1-6.") && sent.length < 2100, "the tail, where proposals are");
  assert.equal(out.reason, "jev", "'use opus' in the assistant's reply is not the user's override");
});

test("remember evicts the least recently used entry, not the oldest inserted", () => {
  const map = new Map();
  remember(map, "a", 1, 2);
  remember(map, "b", 2, 2);
  remember(map, "a", 1, 2); // `a` is in use again, so `b` is now the stale one
  remember(map, "c", 3, 2);
  assert.deepEqual([...map.keys()], ["a", "c"]);
});

test("routeTurn uses the exact model Jev chose, or the tier's newest when asked", async () => {
  const out = await routeTurn({ ...base, route: answer("m-fast-old") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.model, "m-fast-old");
  const newest = await routeTurn({ ...base, newest: true, route: answer("m-fast-old") });
  assert.equal(newest.model, "m-fast", "the catalog lists newest first");
});

test("routeTurn falls back to the tier's model when policy overrides Jev", async () => {
  const out = await routeTurn({ ...base, prompt: "use opus for this", route: answer("m-fast") });
  assert.equal(out.tier, "opus");
  assert.equal(out.model, "m-strong", "staying on the current tier keeps the current model");
});

test("routeTurn keeps the current model when Jev is unavailable", async () => {
  const out = await routeTurn({ ...base, route: async () => null });
  assert.equal(out.model, "m-strong");
  assert.match(out.reason, /jev-unavailable/);
});

test("routeTurn ignores a model id Jev invented", async () => {
  const out = await routeTurn({ ...base, route: answer("m-not-real") });
  assert.equal(out.model, "m-strong");
});

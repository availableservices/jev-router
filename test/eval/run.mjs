// Scores Jev's routing against hand-labelled prompts, through the same policy the proxies use.
//
//   npm run eval                     Claude models
//   npm run eval -- --codex          your Codex catalog (~/.codex/models_cache.json)
//   npm run eval -- --current opus   start from another tier, to see how much Jev leans on it
//   npm run eval -- --group hard     only one group of prompts.json
//
// The labels in prompts.json are judgement calls, not ground truth: edit them to match what
// you would want for your own work. `expect` and `effort` may list several acceptable answers.
// The `fable` tier is opt-in and is not scored.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "../../src/codex-cli.mjs";
import { TIERS, availableTiers, rankOf } from "../../src/config.mjs";
import { codexModels } from "../../src/codex-proxy.mjs";
import { askJev } from "../../src/router.mjs";
import { routeTurn } from "../../src/turn.mjs";

const { values: args } = parseArgs({
  options: {
    codex: { type: "boolean", default: false },
    current: { type: "string", default: "sonnet" },
    group: { type: "string" },
  },
});

loadEnv();
if (!(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY)) {
  console.error("no JEV_API_KEY: add it to .env or ~/.jev-router.env");
  process.exit(1);
}

function codexCatalog() {
  try {
    const { models } = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8"));
    return new Map(models.map((model) => [model.slug, model]));
  } catch {
    return new Map(); // codexModels falls back to the built-in ids
  }
}

// Claude: one model per tier is enough to score tier choice. Codex: the real catalog, versions
// included, because that is where same-tier models split Jev's confidence.
const models = (
  args.codex
    ? codexModels(codexCatalog())
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }))
).filter((model) => availableTiers().includes(model.tier));
const modelForTier = (tier) => models.find((model) => model.tier === tier)?.id;

const cases = JSON.parse(readFileSync(new URL("./prompts.json", import.meta.url), "utf8")).filter(
  (c) => !args.group || c.group === args.group,
);
const list = (value) => [value].flat();

const rows = [];
for (const c of cases) {
  const turn = await routeTurn({
    route: askJev,
    prompt: c.prompt,
    context: c.context,
    models,
    current: args.current,
    currentModel: modelForTier(args.current),
    contextTokens: 0,
    cacheBuilt: false,
    modelForTier,
    newest: args.codex,
  });
  const ok = list(c.expect);
  const verdict = !turn.jev
    ? "no-answer"
    : ok.includes(turn.tier)
      ? "exact"
      : rankOf(turn.tier) > Math.max(...ok.map(rankOf))
        ? "over"
        : "under";
  const effort = turn.jev?.effort ?? null;
  rows.push({
    ...c,
    verdict,
    got: turn.tier,
    model: turn.model,
    effort,
    effortOk: c.effort == null || effort == null ? null : list(c.effort).includes(effort),
    confidence: turn.jev?.confidence,
    ms: turn.jev?.ms,
  });
}

for (const row of rows) {
  const p = row.confidence == null ? "  n/a" : row.confidence.toFixed(2).padStart(5);
  const effort = row.effort == null ? "-" : `${row.effort}${row.effortOk === false ? "!" : ""}`;
  console.log(
    `${row.verdict.padEnd(9)} ${row.group.padEnd(8)} want=${list(row.expect).join("|").padEnd(12)} ` +
      `got=${row.got.padEnd(6)} ${String(row.model).padEnd(18)} p=${p} effort=${effort.padEnd(7)} | ${row.prompt}`,
  );
}

const count = (verdict) => rows.filter((row) => row.verdict === verdict).length;
const scored = rows.filter((row) => row.effortOk != null);
const times = rows.map((row) => row.ms).filter(Number.isFinite).sort((a, b) => a - b);
console.log(
  `\n${rows.length} prompts (${args.codex ? "Codex" : "Claude"}, starting on ${args.current}): ` +
    `${count("exact")} exact, ${count("over")} over-provisioned (paid for more than needed), ` +
    `${count("under")} under-provisioned (risk of a weaker answer), ${count("no-answer")} unanswered`,
);
if (scored.length) {
  console.log(`effort: ${scored.filter((row) => row.effortOk).length}/${scored.length} as labelled ("!" marks a miss)`);
}
if (times.length) console.log(`median Jev latency: ${times[Math.floor(times.length / 2)]}ms`);
process.exitCode = count("under") || count("no-answer") ? 1 : 0;

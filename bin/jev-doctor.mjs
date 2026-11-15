#!/usr/bin/env node
// Checks that jev-router is set up and, with --live, that routing really fires end to end.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, resolveCodex } from "../src/codex-cli.mjs";
import { resolveClaude } from "../src/claude-cli.mjs";
import { failures, routingFired, runDoctor, whyNotRouted } from "../src/doctor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

loadEnv();
const claude = resolveClaude();
const codex = resolveCodex();
const checks = await runDoctor({ claude, codex });

// A real one-line prompt through the real launcher. Setup checks cannot see a CLI whose
// request format changed, so this is the only check that proves routing is actually on.
function live(name, launcher, args) {
  const run = spawnSync(process.execPath, [join(HERE, launcher), ...args], {
    env: { ...process.env, JEV_DEBUG: "1" },
    encoding: "utf8",
    timeout: 180_000,
  });
  const log = `${run.stderr ?? ""}${run.stdout ?? ""}`;
  const decision = log.split("\n").find((line) => routingFired(line));
  checks.push({
    name: `${name} routes a real prompt`,
    ok: Boolean(decision),
    detail: decision ? decision.replace(/^\[jev\] \S+ /, "").slice(0, 90) : whyNotRouted(log),
  });
}

if (process.argv.includes("--live")) {
  const hasKey = Boolean(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY);
  if (!hasKey) {
    checks.push({ name: "Live routing", ok: false, detail: "skipped: no Jev API key" });
  } else {
    if (claude) live("jev-claude", "jev-claude.mjs", ["-p", "reply with the single word ok"]);
    if (codex) live("jev-codex", "jev-codex.mjs", ["exec", "reply with the single word ok"]);
  }
}

for (const check of checks) {
  const mark = check.ok ? "ok  " : check.optional ? "warn" : "FAIL";
  console.log(`${mark}  ${check.name}: ${check.detail}`);
}
if (!process.argv.includes("--live")) {
  console.log("\nRun `jev-doctor --live` to send one real prompt through each CLI and confirm routing fires.");
}
process.exitCode = failures(checks).length ? 1 : 0;

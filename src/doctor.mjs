import { TIERS } from "./config.mjs";
import { askJev } from "./router.mjs";

const SAMPLE_PROMPT = "rename the variable `x` to `count` in utils.js";

/**
 * Checks what a working install depends on, one result per line. `optional` checks describe a
 * CLI the user may simply not use, so failing one is a warning rather than a broken install.
 *
 * @returns {Promise<Array<{name: string, ok: boolean, detail: string, optional?: boolean}>>}
 */
export async function runDoctor({
  env = process.env,
  nodeVersion = process.versions.node,
  ask = askJev,
  claude = null,
  codex = null,
} = {}) {
  const checks = [];
  const add = (name, ok, detail, optional = false) => checks.push({ name, ok, detail, optional });

  const [major, minor] = nodeVersion.split(".").map(Number);
  add("Node.js 20.12 or newer", major > 20 || (major === 20 && minor >= 12), `v${nodeVersion}`);

  const key = env.JEV_API_KEY ?? env.TYPESAFE_API_KEY;
  add("Jev API key", Boolean(key), key ? "set" : "missing; add JEV_API_KEY=... to ~/.jev-router.env");
  if (key) {
    const models = TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
    const answer = await ask({ prompt: SAMPLE_PROMPT, current: "sonnet", contextTokens: 0, models });
    add(
      "Jev answers",
      Boolean(answer),
      answer
        ? `${answer.ms}ms, chose ${answer.choice} (p=${answer.confidence.toFixed(2)})`
        : "no answer before the deadline; check the key and the network",
    );
  }

  add("Claude Code on PATH", Boolean(claude), claude?.file ?? "not found; jev-claude needs it", true);
  // A PowerShell-script install is launched through powershell.exe; the script is what to show.
  add("Codex on PATH", Boolean(codex), codex?.prefix?.at(-1) ?? codex?.file ?? "not found; jev-codex needs it", true);
  return checks;
}

/** Whether a debug log shows a routing decision being made, which is what `--live` looks for. */
export const routingFired = (log) => /\[jev\] .* -> \w+ \([\w/+-]+\)/.test(log);

/** The checks that mean the install does not work. */
export const failures = (checks) => checks.filter((check) => !check.ok && !check.optional);

/** Plain-language reason a live run did not route, using what the proxy itself reported. */
export const whyNotRouted = (log) =>
  /found no user prompt/.test(log)
    ? "the CLI's request format has changed; re-run with JEV_DUMP=<path> and open an issue with the dump"
    : "no routing decision was logged; check the key and that the CLI used the jev-router model";

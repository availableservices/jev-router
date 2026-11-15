import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATUS_DIR } from "./status.mjs";
import { costOf } from "./usage.mjs";

// Held reasons worth counting, matched against the reason strings the policy writes.
const HELD = [
  ["cache-rebuild", "cache rebuild avoided"],
  ["low-confidence", "low confidence"],
  ["override", "explicit override"],
  ["jev-unavailable", "Jev unavailable"],
];

export const heldReason = (reason = "") => HELD.find(([key]) => reason.includes(key))?.[1] ?? null;

/** Every session status file this machine has, Claude and Codex alike. */
export function loadSessions(dir = STATUS_DIR) {
  const sessions = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name === "settings.json") continue;
    try {
      sessions.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      // A file being rewritten or from another tool: skip it.
    }
  }
  return sessions;
}

/**
 * Totals across sessions. Token counts are running totals per session. Decision counts come
 * from each session's recent history, which keeps the last 20 decisions.
 */
export function summarize(sessions, prices = {}) {
  const usage = {};
  const decisions = {};
  const held = {};
  let manual = 0;
  for (const session of sessions) {
    if (session.manual) manual++;
    for (const [tier, row] of Object.entries(session.usage ?? {})) {
      const total = (usage[tier] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
      for (const k of Object.keys(total)) total[k] += row[k] ?? 0;
    }
    for (const decision of session.history ?? []) {
      const tier = decision.tier ?? "unknown"; // older status files predate the tier field
      decisions[tier] = (decisions[tier] ?? 0) + 1;
      const why = heldReason(decision.reason);
      if (why) held[why] = (held[why] ?? 0) + 1;
    }
  }
  const tiers = Object.keys(usage);
  const unpriced = tiers.filter((tier) => !prices[tier]);
  const cost = unpriced.length || !tiers.length ? null : tiers.reduce((sum, tier) => sum + costOf(usage[tier], prices[tier]), 0);
  return { sessions: sessions.length, manual, usage, decisions, held, cost, unpriced };
}

const count = (n) => Number(n).toLocaleString("en-US");

export function formatReport(s) {
  const lines = [`jev-report: ${s.sessions} session(s), ${s.manual} driven by hand`, ""];
  lines.push("Tokens by tier (running totals):");
  if (!Object.keys(s.usage).length) lines.push("  no token counts recorded yet");
  for (const [tier, row] of Object.entries(s.usage)) {
    lines.push(
      `  ${tier.padEnd(7)} requests ${count(row.requests)}  input ${count(row.input)}  ` +
        `output ${count(row.output)}  cache read ${count(row.cacheRead)}  cache write ${count(row.cacheWrite)}`,
    );
  }
  lines.push("");
  if (s.cost == null) {
    const why = s.unpriced.length ? `no price for ${s.unpriced.join(", ")}` : "no usage yet";
    lines.push(`Estimated cost: not shown (${why}). Set JEV_PRICES to see it.`);
  } else {
    lines.push(`Estimated cost: ${s.cost.toFixed(6)} (from JEV_PRICES, per million tokens)`);
  }
  lines.push("");
  lines.push("Routing decisions (recent history):");
  const tiers = Object.entries(s.decisions);
  lines.push(tiers.length ? `  ${tiers.map(([tier, n]) => `${tier} ${n}`).join("  ")}` : "  none yet");
  const held = Object.entries(s.held);
  if (held.length) lines.push(`  held: ${held.map(([why, n]) => `${why} ${n}`).join(", ")}`);
  return lines.join("\n");
}

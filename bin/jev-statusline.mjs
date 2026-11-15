#!/usr/bin/env node
// Status line for Claude Code. Claude Code pipes session JSON on stdin and renders whatever
// this prints. See https://code.claude.com/docs/en/statusline
import { readStatus } from "../src/status.mjs";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const COLOR = { haiku: "\x1b[32m", sonnet: "\x1b[36m", opus: "\x1b[35m", fable: "\x1b[33m" };

// A status line replaces Claude Code's footer hints, so echo the basics it stops showing.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);

let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
} catch {
  // Malformed input still gets a usable line below.
}

const status = readStatus(input.session_id);
const dir = (input.workspace?.current_dir ?? input.cwd ?? "").split(/[\\/]/).pop();
const pct = Math.round(input.context_window?.used_percentage ?? 0);

let routed = `${DIM}jev: waiting for first prompt${RESET}`;
if (status?.manual) {
  // The user picked this model with /model, so show their choice rather than a tier.
  routed = `${DIM}⏸ manual${RESET} ${input.model?.display_name ?? ""}`.trimEnd();
} else if (status) {
  const color = COLOR[status.tier] ?? "";
  // Confidence and the effort actually sent sit together: both say how hard Jev judged the turn.
  const facts = [];
  if (status.confidence != null) facts.push(`p=${status.confidence.toFixed(2)}`);
  if (status.effort) facts.push(`effort ${status.effort}`);
  const p = facts.length ? ` ${DIM}(${facts.join(" · ")})${RESET}` : "";
  // Only name the reason when routing declined to do the obvious thing, so the common case
  // stays short and the interesting case explains itself.
  const held =
    status.reason &&
    status.reason !== "jev" &&
    status.reason !== "jev/no-change" &&
    !status.reason.includes("override");
  // A held downgrade is the one case the user can act on: compacting or clearing makes it cheap.
  const hint = status.reason.includes("cache-rebuild") ? ": /compact or /clear to allow the downgrade" : "";
  const why = held ? ` ${DIM}(${status.reason.split("/")[0]}${hint})${RESET}` : "";
  routed = `${color}${status.model ?? status.tier}${RESET}${p}${why}`;
}

process.stdout.write(`${routed} ${DIM}·${RESET} ${dir} ${DIM}· ${pct}% context${RESET}\n`);

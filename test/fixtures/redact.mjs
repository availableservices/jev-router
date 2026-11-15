// Turns a JEV_DUMP request into a committable fixture: the structure stays, the content goes.
//
//   JEV_DUMP=/tmp/req jev-claude -p "what is 2+2?"
//   node test/fixtures/redact.mjs /tmp/req.<ms>.json test/fixtures/claude-print-request.json "what is 2+2?"
//
// Only the prompt passed as the third argument is kept verbatim. Check the output before you
// commit it: this removes the fields known to carry identifiers or private text, nothing more.
import { readFileSync, writeFileSync } from "node:fs";

const REDACTED = "<redacted>";
const SESSION = "00000000-0000-4000-8000-000000000000";
const TEXT_KEYS = new Set(["text", "instructions", "description", "content", "name", "id"]);

export function redact(value, { keep, key = "", inClientMetadata = false } = {}) {
  if (Array.isArray(value)) {
    const items = key === "tools" ? value.slice(0, 2) : value; // schemas are large and uninteresting
    return items.map((item) => redact(item, { keep, key, inClientMetadata }));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === "input_schema") return [k, { type: "object" }];
        if (k === "prompt_cache_key") return [k, SESSION];
        // Claude Code packs device and account ids into a JSON string; session_id is what the
        // proxy reads, so it stays in a recognisable shape.
        if (k === "user_id" && typeof v === "string") {
          return [k, JSON.stringify({ device_id: REDACTED, account_uuid: REDACTED, session_id: SESSION })];
        }
        return [k, redact(v, { keep, key: k, inClientMetadata: inClientMetadata || k === "client_metadata" })];
      }),
    );
  }
  if (typeof value !== "string") return value;
  if (inClientMetadata) return REDACTED;
  if (!TEXT_KEYS.has(key)) return value;
  if (value === keep) return value;
  return value.includes("<system-reminder>") ? "<system-reminder>redacted</system-reminder>" : REDACTED;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("redact.mjs")) {
  const [, , input, output, keep] = process.argv;
  if (!input || !output || !keep) {
    console.error('usage: node test/fixtures/redact.mjs <dump.json> <out.json> "<prompt to keep>"');
    process.exit(1);
  }
  const fixture = redact(JSON.parse(readFileSync(input, "utf8")), { keep });
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${output}`);
}

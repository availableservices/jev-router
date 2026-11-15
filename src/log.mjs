import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_FILE = join(homedir(), ".jev-claude.log");

// Claude Code owns the terminal in interactive mode and redraws over anything we print, so
// writing to stderr there corrupts its UI. Log to a file instead and leave stderr alone.
// In print mode (`-p`) there is no TUI to damage, so stderr stays convenient for piping.
const interactive = process.stdout.isTTY;

export function log(line) {
  const text = `[jev] ${line}\n`;
  if (!interactive) return void process.stderr.write(text);
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}`);
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Saves a request body under `JEV_DUMP` to diagnose wire-format changes. Bodies hold the
 * user's prompt, so the file is owner-only, and a failed dump must never fail the request.
 */
export function dumpBody(body) {
  try {
    writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`could not write JEV_DUMP file: ${err.message}`);
  }
}

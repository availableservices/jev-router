// Preloaded into every test process: points the OS temp dir at a throwaway folder, so status
// files written by tests never land in the user's real status dir (which jev-report reads).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jev-test-"));
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

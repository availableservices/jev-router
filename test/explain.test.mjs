import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatExplanation } from "../src/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    model: "claude-sonnet-5-5",
    confidence: 0.94,
    reason: "low-confidence-no-downgrade",
    jev: {
      request: { state: { session: { current_model: "haiku", context_tokens: 6200 } } },
      response: { answers: { model: { choice: "claude-haiku-5-5" } } },
    },
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current tier: HAIKU/);
  assert.match(output, /Context tokens: 6200/);
  // Jev's recommendation and the model policy selected must be reported separately.
  assert.match(output, /Recommended model:\s+│\n│ CLAUDE-HAIKU-5-5/);
  assert.match(output, /Selected model:\s+│\n│ CLAUDE-SONNET-5-5/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: low confidence; held/);
});

test("falls back to the selected tier when Jev's own answer was not recorded", () => {
  assert.match(formatExplanation({ tier: "opus", confidence: 0.5 }), /Recommended model: OPUS/);
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});

test("Claude skill pre-approves its read-only explanation command", () => {
  const skill = readFileSync(new URL("../.claude/skills/jev-explain/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^allowed-tools: Bash\(node \*\)$/m);
});

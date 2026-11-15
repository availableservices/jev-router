# jev-router

Automatic per-turn model routing for Claude Code and OpenAI Codex. Jev sends simple work to
the fast tier and difficult work to the strong tier, while preserving each CLI's native
interface, tools, sessions, permissions, and authentication.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `jev-claude` | Claude Code | Existing `claude login` | Status line |
| `jev-codex` | OpenAI Codex | Existing `codex login` | Commentary line |

Both commands launch the real upstream CLI. Jev only chooses the model for a fresh user turn.

## Quick start

Requires Node.js 20.12+ and at least one supported CLI:
[Claude Code](https://code.claude.com/docs/en/setup) or
[OpenAI Codex](https://developers.openai.com/codex/cli).

### 1. npm package

```bash
npm install -g jev-router
echo "JEV_API_KEY=..." > ~/.jev-router.env
```

### 2. Local repository

```bash
git clone https://github.com/gargpratyush/jev-router.git
cd jev-router
npm install
npm link
echo "JEV_API_KEY=..." > ~/.jev-router.env
```

On Windows PowerShell:

```powershell
Set-Content "$HOME\.jev-router.env" "JEV_API_KEY=..."
```

Get a key from [TypeSafe](https://docs.typesafe.ai). Then launch either interface from any
repository:

```bash
jev-claude
jev-codex
```

No Anthropic or OpenAI API key is required when the corresponding CLI is already logged in
with a subscription. Every CLI argument is forwarded:

```bash
jev-claude --resume
jev-claude -p "fix the failing test"
jev-codex resume --last
jev-codex exec "fix the failing test"
```

For a local checkout, `npm link` installs both commands. Without it, run
`node bin/jev-claude.mjs` or `node bin/jev-codex.mjs`.

Run `jev-doctor` after installing (or `jev-doctor --live` to send one real prompt through each
CLI) to confirm the key works and routing actually fires.

## Claude Code interface

![Jev Router in the Claude Code model picker](docs/model-picker.png)

`jev-claude` launches Claude Code with **Jev Router** selected in `/model`. Selecting another
model pauses routing; selecting **Jev Router** resumes it.

The injected status line shows the model used for the last turn:

```text
⚡ haiku p=0.98 · my-project · 8% context
⏸ manual Opus 4.6 · my-project · 21% context
```

Claude Code otherwise remains unchanged, including its keybindings, tools, permission prompts,
`/compact`, `/resume`, and session handling. An existing custom `statusLine` is preserved;
set `JEV_NO_STATUSLINE=1` to disable Jev's status line.

The explanation skill is bundled with the npm package and loaded automatically: run
`/jev-explain` in `jev-claude`, or `$jev-explain` in `jev-codex`, to see the factors behind
the last routing decision:

```text
┌─────────────────────────────────┐
│ Jev Router                      │
│                                 │
│ Jev request                     │
│ Prompt: explain the router      │
│ Current tier: HAIKU             │
│ Context tokens: 6200            │
│                                 │
│ Jev response                    │
│ Task complexity     0.82        │
│ Reasoning required  0.91        │
│ Tool complexity     0.64        │
│ Context size        0.31        │
│                                 │
│ Recommended model:              │
│ CLAUDE-SONNET-5-5               │
│ Selected model:                 │
│ CLAUDE-SONNET-5-5               │
│                                 │
│ Confidence: 94%                 │
│ Decision: Jev recommendation    │
└─────────────────────────────────┘
```

The report is rendered locally from the exact prompt, System One request, and System One
response saved when routing occurred. Recent decisions are retained per CLI session; invoking
the explanation skill does not ask Jev to score the prompt again.

### Explanation data location

Both `jev-claude` and `jev-codex` keep up to 20 recent routing exchanges in one JSON file per
CLI session under Node.js's operating-system temporary directory:

| Platform | Default location |
| --- | --- |
| Windows | `%TEMP%\jev-claude\<session-id>.json` |
| macOS | `$TMPDIR/jev-claude/<session-id>.json` (normally under `/var/folders/.../T`) |
| Ubuntu/Linux | `${TMPDIR:-/tmp}/jev-claude/<session-id>.json` |

Print the exact directory selected on the current machine with:

```bash
node -e "console.log(require('node:path').join(require('node:os').tmpdir(), 'jev-claude'))"
```

Claude filenames use Claude Code's session UUID. Codex filenames use
`codex-<jev-codex-process-id>.json`. These temporary files contain prompt text and Jev's exact
request and response, so they are readable only by you (the directory is created with mode 700 and each
file with 600). Files not updated for 7 days are deleted automatically, and the operating system
may also remove them during normal temporary-file cleanup.

> Choosing a model with `Enter` can save it as Claude Code's default. `jev-claude` restores
> the previous default on exit so `jev-router` cannot break plain `claude`.

## OpenAI Codex interface

![Jev Router in the OpenAI Codex model picker](docs/codex-model-picker.png)

`jev-codex` launches Codex with a temporary **Jev Router** provider and selects `jev-router`.
The native `/model` picker still contains the models available to the account. Selecting a
concrete model pauses routing; selecting **Jev Router** resumes it.

Each fresh decision appears as Codex commentary:

```text
[Jev] routed this turn to gpt-5.6-sol (jev, confidence 0.91).
```

`jev-codex` installs or refreshes the packaged `$jev-explain` skill when it starts, so it is
available from any repository without separate setup.

Codex's footer shows `jev-router` because it displays the selected picker entry,
not the model chosen behind that provider. If Jev is unavailable, the commentary names the
fallback model and explains how to set `JEV_API_KEY`.

## How it works

Each command starts a loopback proxy, launches the real CLI, and forwards the CLI's existing
authorization headers without reading, storing, or modifying them.

```text
you -> Claude Code -> jev-claude proxy -> Anthropic
                         |
                         +-> Jev: choose a tier

you -> OpenAI Codex -> jev-codex proxy -> OpenAI
                         |
                         +-> Jev: choose a tier
```

Claude Code uses `ANTHROPIC_BASE_URL`; Codex uses a temporary custom provider with
`requires_openai_auth=true`. Claude and Codex both use `jev-router` as the
routing sentinel.
Any concrete model selected by the user passes through unchanged.

## Routing policy

One Jev call per fresh user turn selects a shared abstract tier:

| Tier | Claude Code default | Codex default |
| --- | --- | --- |
| Fast | Haiku | `gpt-5.6-luna` |
| Balanced | Sonnet | `gpt-5.6-terra` |
| Strong | Opus | `gpt-5.6-sol` |
| Long | Fable | `gpt-6-astra` |

`src/policy.mjs` then applies these rules:

- explicit requests such as `use opus`, `switch to luna`, or `use the strong model` win (everyday words like "with fast invalidation" do not);
- failure, timeout, or an unrecognised Jev answer keeps the current model;
- low confidence never downgrades and caps upgrades at the balanced tier;
- large conversations refuse downgrades that would waste more prompt-cache work than they save;
- unavailable tiers step upward rather than silently choosing a weaker model;
- the long tier is disabled unless `JEV_ALLOW_FABLE=1`.

Tool-loop continuations keep the tier chosen at the start of the turn. Main conversations and
sub-agents are pinned separately.

A sub-agent that names its own model (in its agent definition, or through the Agent tool's
`model` parameter) keeps that model as a **ceiling**: Jev may choose a cheaper model for it but
never a dearer one, so a research agent declared as Opus can run on Haiku when Jev judges that
enough. A conversation counts as a sub-agent only if it starts after a routed main conversation
in the same `jev-claude` session. A session the user drives by hand from its first turn is left
alone. Choosing a model in `/model` during a routed conversation still wins.

Codex subagents are capped the same way. Each agent has its own window id, so a subagent gets its
own routing state while sharing its tree's prompt cache. Routing is fail-open: Jev failure never blocks the CLI.

## Configuration

| Variable | Interface | Effect |
| --- | --- | --- |
| `JEV_API_KEY` | Both | Enables routing. `TYPESAFE_API_KEY` also works. |
| `JEV_ALLOW_FABLE` | Both | Enables the opt-in long tier. |
| `JEV_DEBUG` | Both | Logs decisions and rewrites to `~/.jev-claude.log` in interactive sessions. |
| `JEV_DUMP` | Both | Dumps request bodies (owner-only files) for debugging wire-format changes. |
| `JEV_NO_STATUSLINE` | Claude | Disables the injected Claude status line. |
| `JEV_CODEX_FAST_MODEL` | Codex | Fast model; defaults to `gpt-5.6-luna`. |
| `JEV_CODEX_BALANCED_MODEL` | Codex | Balanced model; defaults to `gpt-5.6-terra`. |
| `JEV_CODEX_STRONG_MODEL` | Codex | Strong model; defaults to `gpt-5.6-sol`. |
| `JEV_CODEX_LONG_MODEL` | Codex | Long model; defaults to `gpt-6-astra`. |
| `JEV_EFFORT` | Both | On by default: Jev also picks the reasoning effort of a turn. Set to `0` to turn it off. Claude: only lowers Claude Code's own setting. Codex: sets low/medium/high (the `jev-router` entry has a fixed default), and `high` never lowers xhigh or above. |
| `JEV_PRICES` | Both | Per-million-token prices as JSON, e.g. `{"haiku":{"input":1,"output":5}}`. Without it `jev-report` shows token counts but no cost. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, `~/.jev-router.env`, and the legacy `~/.jev-claude.env`.

Tier definitions, Jev's question, confidence thresholds, and timeouts live in `src/config.mjs`.
Both launchers send Jev the exact models in the signed-in account's native catalog, so model
versions such as `claude-opus-4-8` and `claude-opus-5` remain separate choices.

`jev-claude` fetches that catalog itself, with the CLI's own credentials, on the first routed
turn (print mode never asks for it) and refreshes it hourly, so a newly released model is picked
up without a code change. Codex's catalog is the one the CLI requests at startup. The static ids
in `src/config.mjs` and `src/codex-proxy.mjs` are a last resort for when no catalog is available.

## Compatibility notes

- Claude Code needs schema normalisation for older MCP JSON Schema fields when a custom base
  URL is active.
- Claude Code appends `system` messages (hook output, tools added mid-session) after the
  user's prompt, so the proxy looks past them to find the turn's prompt. If a request carries
  tools but no readable prompt, the proxy logs a one-time warning rather than silently not
  routing; run `jev-doctor --live` to confirm routing fires.
- Claude request fields unsupported by a routed tier, such as adaptive thinking on Haiku,
  are removed before forwarding.
- Codex's current request format stores tool definitions inside its Responses API input.
- Codex's ChatGPT backend may stream SSE without a `Content-Type` header; the proxy detects
  the event stream from its first frame.
- Codex workspace-specific enterprise origins are internal to its built-in provider and
  cannot be reproduced by a custom provider.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env

npm test                 # offline: policy, request formats, rewriting, recorded CLI requests
npm run eval             # scores Jev's tier choice on labelled prompts (needs a key)
node bin/jev-doctor.mjs --live
node bin/jev-claude.mjs -p "what is 2+2?"
node bin/jev-codex.mjs exec "what is 2+2?"
```

The test suite covers shared policy, both request formats, model rewriting, capability
handling, settings restoration, Codex authentication forwarding, native model-picker
injection, and decision display.

### Usage and cost

`jev-report` sums token counts per tier across every session on this machine: requests, input,
output, and cache reads and writes. Each proxy reads these from the upstream's final usage event,
so the figures are what the API reported, not estimates. A cost is shown only when you supply
prices in `JEV_PRICES`, because prices change and no default is shipped. Decision counts come
from each session's last 20 decisions.

Jev also picks the effort of each turn unless `JEV_EFFORT=0`. On Claude it only ever lowers Claude Code's
own setting. On Codex it sets low, medium or high directly, so you do not need to adjust the effort of
`jev-router` yourself.

### Checking an install

`jev-doctor` checks Node, the Jev key, that Jev answers, and that each CLI is on `PATH`.
`jev-doctor --live` also sends one real prompt through each installed CLI and fails unless a
routing decision is logged, which is the only check that notices a CLI whose request format
changed. Both exit non-zero on failure.

### Scoring Jev

`npm run eval` runs the labelled prompts in `test/eval/prompts.json` through the same policy
the proxies use and reports exact, over-provisioned (paid for more than needed), and
under-provisioned (risk of a weaker answer) choices, how often the effort matched, plus median
Jev latency. `-- --codex` scores against your Codex catalog, `-- --current opus` starts from
another tier, and `-- --group hard` runs one group. Add the prompts you type most to
`prompts.json`; `expect` and `effort` may list several acceptable answers. The labels are
judgement calls: edit them to match your own work before reading anything into the numbers,
and rerun after changing `THRESHOLDS` or the questions in `src/config.mjs`.

### When a CLI update breaks routing

The unit tests build requests by hand, so they cannot notice a format change on their own.
`test/fixtures.test.mjs` runs against requests recorded from the real CLIs instead. To refresh
them:

```bash
JEV_DUMP=/tmp/req jev-claude -p "what is 2+2?"
node test/fixtures/redact.mjs /tmp/req.<ms>.json test/fixtures/claude-print-request.json "what is 2+2?"
```

`redact.mjs` keeps the structure and the one prompt you name and drops everything else. Read
the result before committing it: it removes the fields known to hold identifiers or private
text, nothing more.

## Limitations

- The user's prompt text is sent to TypeSafe for the routing decision. Nothing else is.
- Jev adds latency only to the first request of a turn; tool-loop continuations add none.
- Claude Code and Codex request formats are not public contracts. Use `JEV_DUMP` to diagnose
  upstream changes.
- Last verified on Windows against Claude Code v2.1.325 and OpenAI Codex v0.169.0. The recorded
  requests in `test/fixtures` come from these versions.

## Contributing

Issues and pull requests are welcome. Use [Issues](https://github.com/gargpratyush/jev-router/issues)
to report bugs, request improvements, or ask questions. Include the relevant Claude Code or
Codex version, reproduction steps, expected behavior, and useful logs with secrets removed.

For a pull request:

1. Open an issue first - all PRs by contributors should be linked with an approved issue. Explain the problem and validation in the issue description.
2. Fork the repository and create a focused branch from `master`.
3. Make the smallest change that solves the problem.
4. Run `npm test` and include tests for non-trivial behavior changes.
5. Claude/Copilot/Codex shall not be the contributors. 

Please do not commit API keys or other secrets. All contributions require review, and only the
repository owner can merge pull requests.

## License

MIT

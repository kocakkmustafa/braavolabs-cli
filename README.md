# @braavolabs/cli

Braavolabs CLI — one terminal command, `braavo`, for both the multi-model council and pipeline control.

Support: [support@yulalab.com](mailto:support@yulalab.com).

## Overview

`braavo` is a single, near-dependency-free (Node 24.22.0+) CLI with two families of commands. The one
runtime dependency is `zod`, used only by the opt-in companion relay bridge (`spawn --bridge`,
see below) to validate the relay contract — every other command remains built on Node built-ins
alone.

**Council** — multi-model orchestration & BYOK keys
- Compare models side-by-side (`ask`), route cheapest-capable-first (`cascade`)
- View cost & token savings over time (`savings`)
- Store local provider API keys (macOS Keychain / chmod-600 file) — keys never leave your machine
- **Serverless modes (Lane-A):** `local` (keyless, offline, straight to Ollama) and
  `direct` (BYOK, one-shot completion straight to a provider) — no Braavolabs server involved
- **Safe-spawn (Lane-B):** `spawn` runs your own already-authenticated `claude`/`codex` CLI
  as an opaque child process — no vendor OAuth, output never parsed, token files never touched.
  **`--bridge`** is an opt-in exception that mirrors the session to a companion (mobile panel)
  over the relay control plane — see [spawn](#spawn) below
- **Repo-aware prompting:** `--repo` prepends a compact git snapshot (branch, status, recent
  commits, diff --stat, ≤4KB) to `ask`/`local`/`direct`/`fix`
- **Suggest-a-fix:** `fix` runs your own test command and, only on failure, asks a model for a
  fix — suggestion-only, never applied
- **MCP client:** `mcp` is a dependency-free Model Context Protocol stdio client (register
  servers, list & call their tools)

**Pipelines** — run & agent steering (ops)
- Start runs, steer live agents, manage handoffs across provider boundaries
- Inspect external connections
- Self-host capable (custom API base)

## Installation

```bash
pnpm build
# Binary is now at:
#   ./dist/braavo.js    → symlink to ~/.local/bin/braavo (or use directly)

# Or install globally:
pnpm build && npm link
```

`braavo` requires Node 24.22.0 or later and is near-dependency-free — `zod` is its one runtime dependency,
used only by the opt-in `spawn --bridge` companion relay (see [spawn](#spawn)).

## Quick Start

### Version, API address and script exits

The command contract in this section describes this source tree. Check the
release notes for the npm version that includes it; a local source build is
not proof that the same changes have been published.

`braavo --version` (or `braavo -v`) prints the installed package version and
exits successfully. It does not read or change your saved config or contact an
API. Use it alongside the package's release notes when reporting a problem.

`--api <url>` selects and saves the API address. Otherwise a saved config URL
is used; `BRAAVO_API_URL` supplies the default only when no URL is saved. An
unknown HTTPS host requires an explicit, **bare** `--allow-custom-host` flag:

```bash
# Select and trust a self-hosted address; login prompts for credentials.
braavo login --api https://your-api.example/api/v1 --allow-custom-host

# If the intended address is already configured, repeating --api is optional.
braavo login --allow-custom-host
```

The warning shows the effective origin before credentials are sent. The flag
is saved with that URL. Passing `--api` again without the flag clears earlier
custom-host consent. A string value such as `--allow-custom-host true` is not
consent. Plain HTTP outside loopback remains refused, even with the flag, and
API redirects are not followed.

Scripts can distinguish these exit statuses:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unclassified runtime or local diagnostic failure |
| 2 | Unknown command, missing argument or invalid invocation |
| 3 | Missing authentication or API rejection of the token |
| 4 | Mutation refused without explicit confirmation |
| 5 | API host refused for credential safety |
| 6 | API resource not found or not visible to this tenant |
| 7 | Other API error reported by the shared client |
| 8 | Local evidence verification failed |

Commands that require authentication check it before their arguments. Existing
provider-specific and legacy runtime errors may use the general code 1.
`--json` result commands write their JSON document to stdout; errors and progress
use stderr. A refused command may have empty stdout, so inspect the exit status
before attempting to parse a result.

### Language and bounded waiting

`braavo --lang tr help` selects Turkish. Supported codes are `tr`, `en`,
`es-419`, `pt-BR`, `de`, `fr`, `ja`, `ar`, `it`, `ko`, `id`, `pl`, `hi`, and
`zh-Hans`. `BRAAVO_LOCALE` sets the default;
an explicit `--lang` takes precedence. Unknown codes warn and fall back to English.
Put the option before `spawn <vendor>`; arguments after the vendor or an MCP
`--` separator belong to the child. `braavo <command> --help` shows command help
without reading saved config or making requests. Provider output, command names,
protocol values, JSON results, and exit codes keep their original form. Human
numbers and USD amounts use the chosen locale; human dates explicitly show UTC.
Missing or invalid human numbers remain unknown rather than appearing as zero.
Case, underscore and supported regional aliases are accepted (for example
`ko_KR`, `hi-IN`, `id-ID`, `zh-CN`, and `zh-SG`). Unicode extensions do not
override the catalogue's number formatting. `zh`, `zh-CN`, `zh-SG`, and
`zh-Hans-CN` select Simplified Chinese; `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`,
`pt-PT`, and `es-ES` fall back to English with a warning.

`BRAAVO_THEME=light|dark|system` selects a session-only foreground palette.
The default is `system`: recognized `COLORFGBG` background indices `0` (dark)
and `7`/`15` (light) select a palette; absent, malformed or unrecognized metadata
keeps the terminal’s default foreground. Invalid theme values follow `system`.
No terminal queries or persistent settings are used. Explicit light/dark
palettes target at least 4.5:1 against standard white/black backgrounds; custom
terminal colors still need visual verification. Secondary text uses a readable
foreground instead of terminal-dependent faint styling.
The terminal background stays unchanged. `NO_COLOR` or `BRAAVO_NO_COLOR`
disables color and animation; `BRAAVO_REDUCED_MOTION` disables animation.
Redirected streams stay plain. A non-animated wait prints its initial status once.
Help prose wraps at the terminal width; command syntax stays intact. Animated
labels are shortened without splitting grapheme clusters. Cell widths are
estimates: actual light/dark contrast, Arabic bidi, fonts and assistive technology
still need testing in real terminals. Arabic interpolated values use Unicode
directional isolates; JSON and provider content keep their original bytes.

Ordinary API requests have a 30-second total deadline, including response bodies,
refresh waiting and replay. Shared refresh work has its own 30-second limit;
one cancelled caller does not cancel other callers' refresh. Local/direct/cascade
completion requests allow 120 seconds. Compare polling stops after five minutes
and run watching after 30 minutes. Ctrl-C stops supported inference/polling waits
locally. A timeout or cancelled wait does not prove that remote work stopped;
inspect status before retrying a mutation or use the explicit cancel/stop command.
An established relay SSE stream stays open until caller cancellation, EOF or a
transport failure; its header deadline does not cut off healthy streams.

`fix` bounds its direct shell process to 120 seconds and Node's 1 MiB `maxBuffer`
option. An incomplete execution never calls a model. This is not a process-tree
sandbox or a guarantee that independently spawned descendants stopped. MCP
responses are limited to 1 MiB per UTF-8 frame. The optional companion mirror
allows at most eight pending output posts and 128 KiB per chunk; excess chunks
are omitted with a local warning. Local vendor output is unchanged. The mirror
is best-effort and is not a durable transcript or chat-history backup.

### Appearance and motion

Interactive progress uses a small Braavolabs coin sequence (`◉ ◐ │ ◑ ◉`) on
stderr, with muted blue and warm bronze accents. It runs only when both stdout
and stderr are terminals; redirected output and JSON command results stay clean.
`NO_COLOR` or `BRAAVO_NO_COLOR` disables color and motion (including an empty
value), and `TERM=dumb` keeps output plain. Set `BRAAVO_REDUCED_MOTION=1` to
keep terminal colors while disabling the animation. Finishing the indicator
does not itself print or imply a successful operation.

### Council

```bash
# Log in (token or email/password)
braavo login --api https://your-api.com --token "eyJ..."

# Set a default company (optional, can be overridden per-command)
braavo use coy_123abc

# Ask a question to multiple models
braavo ask "Explain OAuth 2.0" --models OPENAI/gpt-4o,GROQ/llama-3.3-70b-versatile

# Cascade: cheapest model that meets your confidence threshold
braavo cascade "Summarize the Anthropic research paper" --threshold 0.9

# View cost savings over the last 7 days
braavo savings --days 7

# Manage local API keys (never sent to the server)
braavo keys add anthropic --key "sk-ant-v0..."
braavo keys list
braavo keys rm anthropic

# Media orchestration (BYOK — image via fal.ai FLUX, voice via Google/ElevenLabs).
# Always previews the cost first; only spends when you pass --yes.
braavo media-key add FAL "key-..."             # server-side, tenant-scoped media key
braavo image "a fox in the snow" --model fal-ai/flux/dev --size 1024x768   # preview only
braavo image "a fox in the snow" --yes                                     # generate → CDN URL
braavo voice "hello world" --provider ELEVENLABS --voice Rachel --out hi.mp3 --yes
braavo media-key list

# Serverless: talk straight to a local Ollama daemon (no key, no server)
braavo local "Explain OAuth 2.0"

# Serverless: one-shot BYOK completion straight to a provider
braavo direct anthropic "Explain OAuth 2.0"

# Run your OWN authenticated vendor CLI as an opaque child (no vendor OAuth)
braavo spawn claude "refactor this module"
braavo spawn --list

# Prepend a compact git snapshot (branch/status/commits/diff --stat, ≤4KB) to the prompt
braavo ask "why is CI red?" --repo

# Run YOUR test command; on failure, get a suggested fix (never auto-applied)
braavo fix --cmd "pnpm test" --repo

# Dependency-free Model Context Protocol stdio client
braavo mcp add fs -- npx -y @modelcontextprotocol/server-filesystem /tmp
braavo mcp tools fs
braavo mcp call fs read_file --json '{"path":"/tmp/notes.txt"}'

# List local Ollama models + which BYOK providers have a stored key
braavo models
```

`--models` accepts 1–3 distinct `PROVIDER/model` pairs from your tenant's configured AI providers, in the requested order. These are exact configured pairs, not an arbitrary model catalog or aliases. Unknown, unavailable, ambiguous, duplicate, and over-limit selections are rejected before inference. Explicit selection requires a platform supporting `/research/compare/selected`; an older platform returns an error with no automatic fallback. Without `--models`, the platform keeps automatic first-N provider selection. The synthesizer still uses the tenant-default provider chain, including its existing failover behavior.

`ask --models CEREBRAS/gpt-oss-120b --reasoning-effort high` explicitly selects `low`, `medium`, or `high` effort for every selected candidate. The initial verified profile is exactly `CEREBRAS/gpt-oss-120b` at `https://api.cerebras.ai/v1`; tenant proxies and other provider/model combinations reject explicit effort before inference. Omit the flag to retain provider defaults. The tenant-default synthesizer receives no candidate effort. This requires a platform supporting the nested `reasoningEffort` selector field; an older strict selector API rejects the request, with no automatic fallback. Effort selects a model control, not a guaranteed reasoning-token budget or quality level.


`braavo cancel <researchId> --yes [--json]` requests a soft cancellation of research or compare work. The server returns `CANCELLED`, or preserves `COMPLETED` / `FAILED` if it already finished. A successful cancellation response acknowledges the stored status; an in-flight provider call may still finish. Ctrl-C during `ask` exits with code 130 and stops the local wait. If a session ID is known, the CLI prints the explicit cancel command.

### Pipelines

```bash
# View your account
braavo whoami

# List recent runs
braavo runs

# Trigger a pipeline
braavo run pipeline_abc123 --yes

# Steer a live run (send a real-time message to the agent)
braavo steer run_xyz789 "Try a different approach"

# Hand off a run to another provider (e.g., self-hosted Ollama)
braavo handoff run_xyz789 --reason "Need local inference"
braavo continue run_xyz789 --provider OLLAMA --model llama2

# Manage external connections
braavo connections
```

## Council Commands

### login

Authenticate with email/password or JWT token.

```bash
braavo login --email user@example.com --password "..."
braavo login --token "eyJ0eXAiOiJKV1QiL..."
braavo login --api https://internal.example.com --token "..."
```

Stores credentials in `~/.braavo/config.json` (with refresh-token support). Uses transparent single-retry on 401 to refresh expired tokens.

### logout

Clear stored credentials immediately, then attempt server-side refresh-token revocation.

```bash
braavo logout
```

### use

Set the default company for `ask` and `cascade` commands.

```bash
braavo use company_xyz
```

Overridable per-command: `braavo ask "..." --company company_abc`

### ask

Compare responses across multiple models (async poll).

```bash
braavo ask "What's a good state machine library?" --models OPENAI/gpt-4o,GROQ/llama-3.3-70b-versatile
```

Shows side-by-side answers from each model, plus a synthesis (if the server provides one), and token/cost savings vs. baseline.

### cascade

Cheap-first routing with optional escalation.

Starts with the cheapest model that meets your confidence threshold; escalates to expensive models only if low confidence is returned.

```bash
braavo cascade "Explain DNS resolution" --threshold 0.85
braavo cascade "Write Rust code" --threshold 0.9 --second-opinion
braavo cascade "..." --budget 2.50
```

Shows the chosen model, confidence score, total cost, and any escalation attempts.

### savings

View cost & token savings from cascade routing over a date range.

```bash
braavo savings
braavo savings --days 30
```

Breakdown includes:
- Actual cost (what was spent)
- Baseline cost (what would have been spent on expensive models)
- Saved amount & percentage
- Saved tokens
- Savings by tactic: cheap routing, prompt caching, retrieval optimizations

### keys

Store, list, and remove local API keys for external providers.

```bash
braavo keys add openai --key "sk-proj-abc..."
braavo keys add anthropic --key "sk-ant-v0..."
braavo keys list
braavo keys rm openai
```

#### Key Storage

**macOS:** Keys live in the login keychain (service "braavo-cli"), indexed by a names-only file `~/.braavo/keys-index.json`. The secret value is never stored in plaintext.

**Other platforms:** Keys are stored in `~/.braavo/keys.json` with permissions `chmod 600` (owner read/write only). You'll see a warning that they're not in the OS keychain.

**Important:** Keys are never sent to the Braavolabs server. They're stored and used locally only — for Lane-A direct-provider integrations or local model inference.

When you run `braavo keys list`, only a masked fingerprint (first-4 and last-4 characters) is displayed. The full secret is never echoed.

### local

Serverless, keyless, offline: send a question directly to a local [Ollama](https://ollama.com) daemon. No login, no BYOK key, no network call beyond `localhost`.

```bash
braavo local "Explain OAuth 2.0"
braavo local "Explain OAuth 2.0" --model llama3.1
braavo local "..." --host http://192.168.1.50:11434
```

- Talks to Ollama's native API: `GET /api/tags` to discover installed models, `POST /api/chat` (`stream:false`) for the completion.
- `--model` picks the model; if omitted, braavo uses the first model returned by `/api/tags` (i.e. whatever you have installed — it never guesses a name that isn't there).
- Base URL resolution: `--host` flag > `OLLAMA_HOST` env var > `http://localhost:11434`.
- If Ollama isn't running (or unreachable at the resolved host), braavo fails honestly: `Ollama not reachable — is it running?` — it does not retry silently or fabricate a response.

### monitor

Prototype: watch web pages (a competitor's pricing page, a changelog, a campaign page) and only involve a model when something actually changed. Local only — no login, no server round-trip.

```bash
braavo monitor add https://rival.example/pricing --every 6h --label Rival
braavo monitor add https://rival.example/changelog --notify release
braavo monitor list
braavo monitor check            # check every monitor now
braavo monitor check --due      # only those whose interval has passed (for cron/launchd)
braavo monitor check --summarize [--model <name>] [--host <url>]   # local Ollama summary of real changes
braavo monitor log <id>
braavo monitor rm <id>
```

- The check is model-free: fetch, extract signals, compare with the last snapshot.
- `--notify` picks what counts as news (comma list, default `price,plans,promo,release`):
  - `price` — currency+amount tokens appear or disappear;
  - `plans` — headings whose section carries a price are added or removed;
  - `promo` — struck-through prices, whole-number discount percentages (5–90%), promo/sale/offer/countdown containers;
  - `release` — new version numbers in headings or new dated `<time datetime>` entries (old entries scrolling off are ignored);
  - `text` — any visible-text change (noisiest).
  Signals are structural, so they work in any page language. `--price` is shorthand for `--notify price`.
- Noise is ignored: cookie/consent banners, `<time>` text, countdown digits, clock times and numeric dates.
- `--every` accepts `30m`, `6h`, `1d` (minimum `15m`, default `6h`). There is no background scheduler yet; run `braavo monitor check --due` from cron or launchd.
- `--summarize` asks a local Ollama model only for monitors that changed. Page lines are passed as untrusted data and the model is told not to follow instructions inside them.
- Only plain `http(s)` URLs without embedded credentials; pages over 2 MB are refused. State lives in `~/.braavo/monitor/` (files `0600`, directories `0700`): `monitors.json`, `<id>/last.txt`, `<id>/state.json`, `ledger.jsonl` (last 500 checks).

### daemon

Early slice of the local AI-company runtime. Everything runs on your machine; Braavolabs' cloud never executes agents.

```bash
braavo daemon start     # detached; prints pid and port
braavo daemon status [--json]
braavo daemon stop
braavo daemon run [--relay]       # foreground (desktop sidecar, launchd/systemd)
braavo daemon install [--relay] [--dry-run]   # macOS: per-user LaunchAgent, starts at login
braavo daemon uninstall
```

- Local API on `127.0.0.1` only, random port, bearer token in `~/.braavo/daemon/token` (`0600`); browser origins and foreign `Host` headers are refused.
- Data in `~/.braavo/braavo.db` (SQLite, WAL, owner-only): companies, agents with reporting lines, tasks, routines and their execution ledger, conversations (full-text search), costs and activity.
- Routines tick every 60 s. After a sleep only the latest missed firing runs, once, and is reported; the others are recorded as skipped. Routines cannot create routines. `POST /v1/routines/:id/run` runs one now without moving its schedule.
- A due routine makes one model call for its agent (provider, model and effort from the agent) and stores the reply as a searchable conversation with a token cost event. Keys come from `braavo keys add <provider>` (macOS keychain) and are only sent to that provider; local providers (Ollama, LM Studio) need none. Supported: Anthropic (official SDK), OpenAI, Groq, Cerebras, Mistral, OpenRouter, DeepSeek, Kimi, Qwen, Zhipu, Ollama, LM Studio. Routine preflight checks and an agent tool loop are not implemented yet; USD cost is not computed yet (tokens only).
- `install` writes `~/Library/LaunchAgents/com.braavolabs.daemon.plist` (no secrets, no environment) and loads it into your login session; the daemon restarts only after a crash. `--dry-run` prints the plist without installing.
- Chat: multi-turn, streamed conversations on your own keys or local models (see `chat` below and [docs/DAEMON-CHAT.md](docs/DAEMON-CHAT.md) for the API the desktop and mobile apps use).
- `--relay` (opt-in, needs `braavo login`) registers one relay session so the mobile app can chat with this computer. Outbound connections only; each message from the phone is a turn in the current conversation (`/new`, `/model PROVIDER/model`), stop aborts the turn.

### setup

```bash
braavo setup [--json]          # daemon, stored key names, Ollama / LM Studio models, suggested model per tier, next step
braavo models pull qwen3:8b    # pull a model into your local Ollama (progress shown)
```

Everything runs on your own keys or local models; `setup` tells you which of the two you have and what to do when you have neither.

### code

Our own coding agent on your own key or local model. It reads, searches and edits files under one directory, shows every change as a diff and asks before writing.

```bash
braavo code "use a template string in greet()" [--dir .] [--model OLLAMA/qwen3-coder:30b]
braavo code "how would you split this module?" --plan    # read-only tools, ends with a plan
braavo code "…" --yes                                     # apply without asking (non-interactive)
braavo code undo                                          # restore every file the last run changed
```

- `AGENTS.md` / `CLAUDE.md` in the directory and its parents are given to the model as project instructions.
- Paths never leave the directory (no `..`, absolute paths, links out, or `.git`). Before each write the previous content is saved under `~/.braavo/checkpoints/`.
- `--allow-web docs.example.com,developer.mozilla.org` gives the agent a `web_fetch` tool for those domains only (redirects re-checked, private addresses refused, text marked untrusted).
- `--review-model PROVIDER/model` has a second model review every diff first; a "risky" verdict is shown with its reason and always needs your confirmation, even with `--yes` (refused without a terminal).
- Hooks: `~/.braavo/hooks.json` → `{"preWrite": ["<cmd>"], "postWrite": ["<cmd>"]}`. A failing `preWrite` command refuses the write; `postWrite` output (formatter, tests) goes back to the agent. The file path is in `BRAAVO_FILE`. A project's own `.braavo/hooks.json` runs only with `--project-hooks`.
- `--shell`: the agent may run commands (tests, builds) in an OS sandbox — macOS `sandbox-exec`, Linux `bwrap`; without one the tool is off. No network, writes only inside the project (not `.git`) and temp, credential folders (`~/.braavo`, `~/.ssh`, `~/.aws`, …) unreadable, and no API keys in the environment. You confirm every command in the terminal; `--yes` never covers commands, and files a command changes are not part of `braavo code undo`.
- No shell tool yet; running commands waits for the daemon sandbox.

### company

Your company on this computer ("Şirket / Company"): the seven starter agents (General Manager; Market Analyst; Content and Social Media Lead with the Customer Voice Analyst; Finance Tracker; Technical Lead with the Release and Dependency Tracker), their routines and an org panel. Needs the daemon.

```bash
braavo company init "YULA Lab" --watch https://rival.example/pricing,https://rival.example/changelog --timezone Europe/Istanbul
braavo company init "YULA Lab" --watch @KAYNAKLAR.md     # every http(s) URL in the file (max 20)
braavo company show [--json]                              # org tree with model · effort · status, routines, activity
braavo company set market-analyst --model OLLAMA/qwen3:8b --effort low
braavo company set "Finance Tracker" --pause | --resume
braavo company watch "Rivals of app X" --urls @app-x/KAYNAKLAR.md --every 6h
braavo company run "Watch competitors"                    # run a routine now
braavo company findings [--role market-analyst]
braavo company prices [--url <page>]                     # competitor price history (from the watch routines)
braavo company tui                                        # live panel: agents, budgets, tasks (keys at the bottom)
braavo company budget 50                                  # company budget, USD/month (80% warns, 100% pauses)
braavo company task add "Draft the launch post" --agent Writer
braavo company memory edit company.md --text @about.md    # company memory (see below)
braavo company memory core Writer --text "Sign posts as YULA Lab."
braavo company memory search "launch checklist"
braavo company hire-cli gemini --workdir ~/code/app --approvals edits   # your own Claude Code / Codex / Gemini CLI as an employee (ACP)
braavo company approvals ; braavo company approve <id> [--deny]           # what CLI employees wait for
braavo company goal add "Launch the pricing page" --run                   # the General Manager plans, delegates and re-plans
braavo company trigger add rss https://rival.example/feed --agent "Market Analyst" --every 1h
braavo company trigger add files ~/Invoices --agent "Finance Tracker" --pattern "*.pdf"
```

- Models come only from your own keys and local models (Ollama, LM Studio). An agent with neither opens in `error` and `init` lists what it needs.
- Watch routines check pages model-free; the model is called only when a price, plan, promotion or release changed. Findings are appended to `~/.braavo/memory/<company>/findings/<role>.md` and shown as a macOS notification (and on the phone with `daemon run --relay`).
- Calendar routines (e.g. Monday 09:00) run in the time zone you give; after sleep the latest missed run happens once.
- **CLI employees** run tasks through the Agent Client Protocol in their own folder with their own sign-in (Gemini: `gemini --acp`; Claude Code and Codex through the `claude-code-acp` / `codex-acp` adapters; launchers can be changed in `~/.braavo/adapters.json`). Reads run; edits run under `--approvals edits`; commands, deletes and fetches wait for your approval (panel, phone or `braavo company approve`) and are refused after 10 minutes. Tool calls, diffs and decisions are kept as task events (`braavo company task show <id>`).
- **Goals:** the manager keeps a task ledger (facts, assumptions, plan) and a progress ledger, runs the steps as tasks, re-plans after two steps without progress and stops as `STALLED` after three re-plans. The ledger is mirrored to `notes/goal-<id>.md`.
- **Triggers** open a task when a feed has a new item, a page's text changes (read through the agent browser policy) or a matching file appears in a folder; the first check only records what is there, outside text is fenced as untrusted, and each trigger opens at most 20 tasks a day.
- **Agent browser:** a task that links to pages gets their text, read under the URL policy in `~/.braavo/browser.json` (`allow`, `deny` host patterns such as `example.com` or `*.gov`; banking, payment and government sites are denied by default; local and private addresses are never read) and fenced as untrusted content the agent must not take instructions from.
- **Company memory** lives in `~/.braavo/memory/<company>/` as plain Markdown (open it in Obsidian or any editor): `company.md`, `departments/<name>.md`, `agents/<agent>/core.md` (≤2000 characters) and `agents/<agent>/notes.md`. An agent reads its company, department and core notes as a snapshot taken when a conversation starts; a task also gets the notes that match it, and a finished task is added to the agent's `notes.md`. Every change is committed to a git repository in that folder (when git is installed) and indexed for full-text search. Long conversations are folded past about 24k tokens: the durable facts go into the agent's journal first, then the older turns become a summary (messages are never deleted). Every night a "Consolidate memory" routine moves old journal entries to `agents/<agent>/archive/<yyyy-mm>.md` and, when the agent has a usable model, summarises them. Optional meaning search: `braavo company memory embed nomic-embed-text` (any Ollama embedding model) adds local embeddings fused with the keyword results; while the model is off or unreachable, search stays keyword-only.

### chat

Multi-turn chat through the local daemon. History lives in `~/.braavo/braavo.db` and is shared with the desktop and mobile apps.

```bash
braavo chat                                  # interactive; /new, /model P/m, /export [json], /exit; Ctrl-C stops a reply
braavo chat "question" [--model PROVIDER/model] [--effort low|medium|high]
braavo chat --continue last "follow-up"      # or --continue <conversationId>
echo "text" | braavo chat --continue last
braavo chat list | show <id> | search <text> [--json]
```

- Without `--model`, the model is suggested from the keys you stored (`braavo keys add`) and the models you pulled into Ollama or LM Studio; with neither, the command tells you what to set up.
- The conversation id is printed to stderr after a one-shot message (`--quiet` hides it).

### direct

Serverless BYOK: a single-shot completion straight to a provider's own API, using a key from `braavo keys`. The Braavolabs server is never contacted.

```bash
braavo direct anthropic "Explain OAuth 2.0"
braavo direct openai "Explain OAuth 2.0" --model gpt-4o
braavo direct groq "Explain OAuth 2.0"
```

Supported providers (Lane-A v1): `anthropic`, `openai`, `groq`.

| Provider | Endpoint | Auth | Default `--model` |
|---|---|---|---|
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | `x-api-key` header | `claude-sonnet-5-5` |
| `openai` | `POST https://api.openai.com/v1/chat/completions` | `Authorization: Bearer` | `gpt-4o-mini` |
| `groq` | `POST https://api.groq.com/openai/v1/chat/completions` (openai-compatible) | `Authorization: Bearer` | `llama-3.1-8b-instant` |

Notes:
- Requires a key stored via `braavo keys add <provider>` first; otherwise braavo tells you exactly that: `no key stored — run: braavo keys add <provider>`.
- The default models above are **documented, stable snapshots — not a claim that they're the newest available**. Check the provider's own model list and pass `--model <name>` to use something else.
- The key is read from local storage, used only in that provider's own auth header for this one request, and is never printed, logged, or included in any error message.

### spawn

Run **your own, already-authenticated** vendor CLI (`claude` or `codex`) as a child process. `braavo` is a thin, opaque passthrough — it does **not** re-implement the vendor, and it does **not** perform any vendor OAuth. You must have logged in with the official binary beforehand.

```bash
braavo spawn claude "refactor this module"      # anything after the vendor is passed verbatim
braavo spawn codex --model o4-mini "write tests"
braavo spawn claude --dir ./packages/api "..."  # run the session in a specific directory
braavo spawn claude --quiet "..."               # suppress the one-line risk note
braavo spawn claude --bridge "..."              # opt-in: mirror the session to a companion (see below)
braavo spawn --list                             # which vendor CLIs are installed (+ version)
```

- **`--dir <path>`** sets the working directory for the session (default: current cwd). This flag is consumed by braavo and **not** forwarded to the vendor; every other token after the vendor name is passed through unchanged.
- **`--quiet`** suppresses the one-line ToS-risk note printed before the session.
- Before each run, braavo reminds you that your own account and the provider's terms apply. This is not a provider authorization or a legal compliance guarantee.
- If the binary isn't found (or the spawn fails), braavo degrades gracefully and points you at API-key mode, e.g. `braavo direct anthropic "<question>"` — it never fabricates a result.
- `braavo` exits with the child's own exit code.

#### `--bridge` (opt-in companion relay)

By default `spawn` is the opaque `stdio:"inherit"` passthrough described below — braavo never reads
a byte of the vendor's output. **`--bridge`** is a narrow, deliberate, opt-in exception: it TEEs the
vendor's stdout/stderr to BOTH your terminal (unchanged — you still see everything live) AND a
companion (mobile panel) over the sealed relay control plane, so you can watch and steer a spawned
session remotely.

- Requires login (`braavo login`) — registering the session with the relay needs the same bearer
  token every other authenticated command uses.
- The mirrored output passes through client-side pattern redaction (`sk-…`/`Bearer …`/long opaque
  tokens); the relay server redacts again independently. Short or split secrets and personal
  content can remain. Opt in only for output you intend to send through the cloud relay.
- Bridge mode uses pipes and does not forward local stdin or provide a PTY. Interactive local
  vendor prompts are not supported by this path; real vendor/phone acceptance remains required.
- A companion `steer` command writes the message straight into the vendor's stdin (as if you'd typed
  it); a companion `kill` command sends `SIGTERM`. A companion `approve`/`reject` command is a
  **logged no-op** — braavo's spawn has no local approval gate of its own; the vendor CLI manages its
  own approvals internally.
- A relay outage never blocks or kills the session — the vendor CLI keeps running companion-less if
  the relay is unreachable.
- Opening the command stream applies the configured API host consent and rejects redirects.
  An expired access token gets one refresh attempt per request; a temporary refresh
  408/429/5xx failure preserves its status so the stream can retry with backoff.
  Unsubscribing or replacing the active
  session suppresses commands from its old stream. Dropped streams reconnect with backoff from
  0.5 to 10 seconds and resume after the last delivered command sequence. Duplicate and stale
  replay frames are ignored; a server `done` marker ends the subscription. Recovery is limited
  by the server's replay buffer (250 commands, one-hour retention). Replay retention does not
  establish sequence-counter lifetime or full recovery after a new server boot. The CLI does
  not automatically register a new session after a terminal missing-session response. Local
  mock tests do not establish real phone/provider delivery or prove a command was applied.
- Implementation: `src/forge/relay-protocol.ts` / `relay-bridge.ts` / `relay-transport.ts` (the CLI-side
  mirror of the sealed relay contract, ported from the Braavolabs Desktop app's own companion bridge)
  and `spawnVendorBridged` in `src/forge/spawn.ts`.

#### Lane-B safety contract

`braavo spawn` is a **SAFE-SPAWN adapter**, not an automation of someone else's account. The rules below are enforced by the implementation (`src/forge/spawn.ts`) and are non-negotiable:

**MUST**
- Run **only** the official vendor binary, discovered on `PATH` (or at a neutral bin dir such as `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`).
- Pass all vendor arguments as an **argument array** (execFile/spawn semantics) — never via a shell — so there is no command-injection seam.
- Treat the child's `stdout`/`stderr` as an **opaque stream**: `stdio: "inherit"`, rendered straight to your terminal, never captured.
- Run each session in the user-provided working directory (`--dir`, or the current cwd).
- Remind users that their account and the provider's terms apply before running.
- Degrade gracefully to API-key mode when the binary is absent or the spawn fails.
- Propagate the child's **exit code** verbatim.

**MUST NOT**
- Perform, initiate, or broker any **vendor OAuth / sign-in**. The user authenticates with the official binary themselves, out of band.
- **Read, parse, or scrape** the child's output for tokens, identity, or anything else — and never write that output to disk, telemetry, or any server. (`--bridge`, opt-in only, is the one deliberate exception: it relays a TEE'd, client-side-redacted copy of the output to a companion over the sealed relay — see above — but still never parses it for content, never writes it to disk, and the default, non-`--bridge` path is byte-for-byte unchanged.)
- Touch OAuth **token/cookie files** (`~/.claude*`, `~/.codex*`, credentials, `auth.json`) — **not even to read them**. Binary discovery looks only at `PATH` and neutral bin dirs, never inside a vendor config directory. `spawn --list` reports *installed-or-not only*; it deliberately does **not** probe login state.
- Impose directory isolation the user didn't ask for.
- Add a runtime dependency to the default, opaque passthrough — that path stays dependency-free (Node built-ins only). `--bridge` is the one opt-in exception, adding `zod` to validate the relay contract (same trade-off the Braavolabs Desktop app made for its own companion bridge).

### --repo (structured git context)

`ask`, `local`, `direct`, and `fix` accept `--repo`. When set, braavo gathers a compact, factual snapshot of the **current git work tree** and prepends it to the prompt so the model reasons about your actual state instead of guessing:

```bash
braavo ask "why is CI failing?" --repo
braavo local "suggest a commit message" --repo
braavo direct anthropic "review my staged changes" --repo
braavo fix --cmd "pnpm test" --repo
```

The block contains: current **branch**, `git status --porcelain`, the **last 5 commits** (`git log -5 --oneline`), and both **staged** and **unstaged** `diff --stat`.

- Every git call is an **execFile arg-array** — no shell, no injection seam (`src/forge/repo.ts`).
- The block is capped at **~4KB**. On overflow it is cut and marked with an honest `[truncated …]` line — braavo tells you it dropped context rather than silently trimming.
- If the current directory is **not** a git repository, braavo stops with an honest error (`not a git repository: <cwd>`) rather than fabricating a "clean tree".

### fix

Run **your own** test command; if it fails, send the failing output (plus optional `--repo` context) to a model and print a **suggested** fix. `braavo` **never edits a file or applies a patch** — the suggestion is yours to review and apply.

```bash
braavo fix --cmd "pnpm test"                              # backend defaults to --via ask (server cascade)
braavo fix --cmd "pnpm test" --via local                  # local Ollama
braavo fix --cmd "pnpm test" --via direct --provider anthropic
braavo fix --cmd "vitest run packages/cli" --repo         # include git context in the payload
```

- **Security:** `--cmd` is **your own command**, executed with `sh -c` exactly as written. `braavo` adds nothing to it — treat it like any shell command you'd run yourself, and don't paste a command you wouldn't run by hand.
- **Cost honesty:** if the command exits **0**, braavo prints `✓ tests already green` and **never calls a model** — no spend on a passing suite.
- **Suggestion-only:** on failure the output is prefixed with a steel `suggestion only — review before applying` note; braavo prints the model's proposed change and exits with the command's own exit code. It does not write to disk.
- **`--via`** selects the backend that turns the failure into a suggestion: `ask` (Braavolabs server cascade, needs login), `local` (Ollama), or `direct` (BYOK, needs `--provider`). Only the tail (~80 lines) of the output is sent.

### mcp

A **dependency-free Model Context Protocol stdio client**. Register MCP servers, list their tools, and call a tool — all over line-delimited JSON-RPC 2.0 spoken to the server's stdin/stdout, built only on Node built-ins.

```bash
# Register a server. The "--" separator is MANDATORY; everything after it is the
# server command + args, stored as a discrete array (no shell, no injection).
braavo mcp add fs -- npx -y @modelcontextprotocol/server-filesystem /tmp

braavo mcp list                       # registered servers
braavo mcp rm fs                      # remove one

braavo mcp tools fs                   # spawn, handshake, tools/list — tabulated
braavo mcp call fs read_file --json '{"path":"/tmp/notes.txt"}'
braavo mcp call fs read_file --json '{"path":"…"}' --timeout 30000
```

- **Config** lives in `~/.braavo/mcp.json` as `{ "<name>": { "command": "...", "args": [...] } }`. The command is always an **argument array** — never a joined string — so there is no shell-injection seam when the server is later spawned.
- **Handshake:** `initialize` (protocolVersion `2024-11-05`, `clientInfo: { name: "braavo" }`) → `notifications/initialized` → `tools/list` | `tools/call`.
- **Timeout:** every request has a timeout (default **10s**, override with `--timeout <ms>`) so a wedged server can't hang the CLI.
- **stderr** from the server is streamed through verbatim in steel for debugging, and is **never** parsed as JSON-RPC — only stdout carries protocol messages.
- A tool result with `isError: true` is printed through the molten error line and braavo exits non-zero.

#### Community skills

```bash
braavo skills search "weekly report"
braavo skills info weekly-report
braavo skills install weekly-report          # shows SKILL.md, files, trust and reports, then asks
braavo skills update                         # newer versions, with the SKILL.md diff, each confirmed
braavo skills report weekly-report --reason "asks for keys" --high
braavo skills check                          # fetch the revocation list now
braavo skills remove weekly-report --yes
```

- Packages come from the Braavolabs skill registry. Nothing is written unless the registry's ed25519 signature verifies with the key built into this CLI, the manifest names the skill and version you asked for, the bundle and every file match their signed SHA-256, and the version is not revoked.
- Installed skills go to `~/.braavo/skills/<name>/` with a `.braavo-skill.json` lock; a skill you wrote yourself is never overwritten. Scripts in a skill are listed, never run.
- The daemon checks the signed revocation list a minute after it starts and then daily. A revoked skill is switched off at once (it disappears from every prompt), removed from your agents, and you get a notification; its files stay until you run `braavo skills remove`.

#### Your company as an MCP server

`braavo mcp serve` speaks MCP over stdio, so Claude Code, Codex, Cursor or any MCP client can use your local company: `company_panel`, `list_tasks`, `create_task` (optionally `run`), `run_task`, `get_task`, `ask_agent`, `read_page`, `list_skills`, `search_memory`, `read_memory`, `write_memory`, `list_companies`. Every tool is a call to the running daemon on loopback, so budgets and the agents' own models apply.

```bash
claude mcp add braavo -- braavo mcp serve      # Claude Code
codex mcp add braavo -- braavo mcp serve       # Codex
```

> **Scope note (deliberately narrow).** This P-C4 slice ships `--repo` context, `fix`, and an MCP stdio client. **Sandbox/isolation parity** for spawned commands and MCP servers (containerized execution, filesystem/network confinement) is **not** in this CLI slice — it is deferred to the **desktop app, Phase D**. Until then, `fix --cmd` and MCP servers run with your own user's privileges; run only commands and servers you trust.

### models

List what's available for the serverless modes: local Ollama models plus which BYOK providers have a key stored.

```bash
braavo models
```

Shows the resolved Ollama host and its installed models (or a clear "not reachable" line if the daemon is down), followed by a per-provider row for `anthropic` / `openai` / `groq` showing whether a key is stored.

## Pipeline Commands

### whoami

```bash
braavo whoami
```

Shows your email, tenant name, and plan.

### runs / run

List recent runs; trigger a new one.

```bash
braavo runs                    # Show last 20 runs
braavo run pipeline_abc --yes   # Start a new run on pipeline_abc
braavo run pipeline_abc --yes --json
braavo watch run_xyz --json    # Wait for a terminal state
braavo stop run_xyz --yes      # Request pipeline cancellation
```

`watch` exits 0 for `COMPLETED` and 1 for `FAILED`, `CANCELLED`, or legacy `STOPPED`. Ctrl-C exits 130 and stops the local watch; use `stop --yes` to cancel the run on the server. Polling stays with the account and API that started the wait.

### steer

Send a real-time message to a live agent.

```bash
braavo steer run_xyz "Try the retrieval-augmented approach"
```

Agent picks it up on its next turn loop.

### handoffs / handoff / continue

Cross-provider handoff (e.g., from cloud to self-hosted Ollama).

```bash
braavo handoffs              # Show all handoffs (claims & history)
braavo handoffs --open       # Show only OPEN handoffs waiting to be claimed

braavo handoff run_xyz       # Freeze run_xyz and open a handoff
braavo handoff run_xyz --reason "Need local GPU inference"

# Then, from another terminal (or machine):
braavo continue run_xyz --provider OLLAMA --model llama2:70b
braavo continue run_xyz --provider OLLAMA --model llama2:70b --base-url http://localhost:11434
```

Handoff flow:
1. `handoff` freezes the run at the next turn boundary and opens a claim slot.
2. `continue` claims that slot, resuming on the new provider/model. An explicit `CHECKPOINT_PENDING` response (or the current server's exact checkpoint-not-frozen message) retries up to five attempts. Other conflicts stop immediately. Authentication, not-found, and API failures retain their documented exit codes; an invalid success response asks you to inspect the run before retrying.

### connections

List external provider connections (API keys, base URLs, etc.).

```bash
braavo connections
```

Shows status, platform (e.g., "OLLAMA", "OPENAI"), label, and base URL.

## Configuration

### Environment Variables

- `BRAAVO_API_URL` — Override the API base (default: `https://braavolabs.com/api/v1`, or from `~/.braavo/config.json`)
- `BRAAVO_KEY` — Provide an API key via env (for `braavo keys add`; if not set, you'll be prompted)
- `OLLAMA_HOST` — Override the local Ollama daemon base for `local` / `fix --via local` / `models` (default `http://localhost:11434`)
- `NO_COLOR` / `BRAAVO_NO_COLOR` — Disable ANSI colors and spinners

### Config Files

- **config:** `~/.braavo/config.json` — API URL, JWT token, refresh token
- **keys:** `~/.braavo/keys-index.json` (macOS) or `~/.braavo/keys.json` (other platforms)
- **mcp:** `~/.braavo/mcp.json` — registered MCP servers

`braavo` supports `--api <url>` at login time to point to a self-hosted instance.

## Non-Interactive Mode (TTY-less)

`braavo` detects whether stdin/stdout are a terminal. In non-interactive environments (e.g., CI, cron, scripts):

- `prompt()` calls (e.g., "Email: ", password input) **will fail** — pass credentials via flags or env:
  ```bash
  braavo login --token "eyJ..." --api https://your.api/v1
  ```

- Output formatting adapts: no ANSI colors/spinners in pipe/file contexts (auto-detected via `isTTY`).

- Errors exit with code 1; success is silent or exits 0.

## Output Examples (Plain Text)

### braavo ask

```
── claude ──
OAuth 2.0 is an open standard for authorization that allows users to grant
third-party applications access to protected resources without sharing their
passwords. The flow involves redirecting users to an authorization server,
where they approve the scope of access requested. The server then issues tokens
that the application can use to access resources on behalf of the user.

── gpt-4 ──
OAuth 2.0 is an authorization protocol used for secure delegated access. Key
components include an authorization server (provider), resource server, client
application, and resource owner. The authorization code grant type is the most
common flow for web applications.

── synthesis ──
OAuth 2.0 enables delegated authorization through token-based access. Users
authenticate once and grant applications permission to access specific resources,
balancing security with convenience.

≈ saved $0.0042 · 1,847 tokens
```

### braavo cascade

```
Rust's ownership model ensures memory safety at compile time. Each value has a
single owner; when it goes out of scope, memory is automatically freed. You can
borrow values immutably (multiple readers) or mutably (single writer), enforced
by the borrow checker.

claude-opus/claude-3-opus-20250514 · tier=4 · confidence=97% · no escalation · $0.0156
```

### braavo savings

```
period               7 days
actual               $3.47
baseline             $12.14
saved                $8.67 (71%)
saved tokens         34,582
── breakdown ──
cheap routing        $5.22
cache                $2.18
retrieval            $1.27
```

### braavo runs

```
COMPLETED     run_abc123def456  pipeline_web_scraper
PENDING       run_xyz789uv      pipeline_email_summarize
IN_PROGRESS   run_qwe456rty     pipeline_rag_indexer
```

### braavo handoffs

```
CLAIMED       h_789abc  run=run_uvw  from=claude→OLLAMA    Needed local GPU inference
OPEN          h_456def  run=run_xyz  from=gpt4             Escalation required
```

## Troubleshooting

**"Not logged in. Run: braavo login"**
- No valid token in `~/.braavo/config.json`
- Use `braavo login --token "..."` or `braavo login --email ... --password ...`

**"API 401: Unauthorized"**
- Token expired; if a refresh token is stored, the CLI retries automatically
- If both tokens are invalid, re-login

**"No company. Run: braavo use <companyId>"**
- No default company set; either:
  - `braavo use <id>` once, or
  - Pass `--company <id>` to each `ask`/`cascade` command

**Keys show as "(missing)" in braavo keys list (macOS)**
- The keychain entry was deleted out-of-band (e.g., Keychain Access.app)
- Re-add: `braavo keys add <provider> --key "..."`

**"Stored in ~/.braavo/keys.json (chmod 600) — no OS keychain on this platform"**
- You're not on macOS; keys are stored in plaintext with restricted permissions
- This is expected. Keep the file secure and back up carefully.

**Cannot write to ~/.braavo/**
- Ensure the directory exists and you have write permissions
- `braavo` auto-creates the directory on first login

## Development

### Build

```bash
pnpm build
```

Compiles TypeScript to `dist/` (single bin at `dist/braavo.js`).

### Test

```bash
pnpm test
```

Runs unit tests (vitest) for arg parsing, key storage, rendering, and client logic.

### Type Check

```bash
npm run lint
# or:
./node_modules/.bin/tsc --noEmit
```

## Notes

- `braavo` is a single CLI covering two families of work: the multi-model **council** (ask/cascade/savings, BYOK keys, serverless local/direct, spawn, fix, MCP) and **pipeline** ops (runs, steering, handoffs, connections).
- Config lives under `~/.braavo/`. The internal source directory is `src/forge/` — an implementation detail, not a product name.
- One runtime dependency: `zod` validates the opt-in companion relay contract; other CLI paths use Node built-ins.
- Transparent token refresh on 401 (single retry) mirrors web/mobile behavior.
- Self-host support: pass `--api <url>` at login time.

## License

Proprietary (Braavolabs).

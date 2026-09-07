# @braavolabs/cli

Braavolabs CLI — one terminal command, `braavo`, for both the multi-model council and pipeline control.

## Overview

`braavo` is a single, near-dependency-free (Node 20+) CLI with two families of commands. The one
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

`braavo` runs on Node 20+ and is near-dependency-free — `zod` is its one runtime dependency,
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
braavo ask "Explain OAuth 2.0" --models claude,gpt4,gemini

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

### Pipelines

```bash
# View your account
braavo whoami

# List recent runs
braavo runs

# Trigger a pipeline
braavo run pipeline_abc123

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

Clear stored credentials (best-effort server-side refresh-token revocation first).

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
braavo ask "What's a good state machine library?" --models claude,gpt4
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
| `anthropic` | `POST https://api.anthropic.com/v1/messages` | `x-api-key` header | `claude-3-5-sonnet-20241022` |
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
- Before each run, braavo prints a single steel line stating the vendor's ToS-risk level (`claude` = SAFE / volatile; `codex` = SAFE / lowest risk).
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
- The mirrored output is **client-side redacted** (`sk-…`/`Bearer …`/long-opaque-token patterns) before
  it ever leaves this process — the relay server redacts again independently, so this is defense in
  depth, not the only guard.
- A companion `steer` command writes the message straight into the vendor's stdin (as if you'd typed
  it); a companion `kill` command sends `SIGTERM`. A companion `approve`/`reject` command is a
  **logged no-op** — braavo's spawn has no local approval gate of its own; the vendor CLI manages its
  own approvals internally.
- A relay outage never blocks or kills the session — the vendor CLI keeps running companion-less if
  the relay is unreachable.
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
- Surface the per-vendor **ToS-risk level** before running.
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
braavo run pipeline_abc        # Start a new run on pipeline_abc
```

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
2. `continue` claims that slot, resuming on the new provider/model. If the checkpoint is still freezing, the API answers `409 CHECKPOINT_PENDING` and `braavo continue` retries a few times automatically.

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
- No runtime dependencies — pure Node with built-in fetch + fs + readline.
- Transparent token refresh on 401 (single retry) mirrors web/mobile behavior.
- Self-host support: pass `--api <url>` at login time.

## License

Proprietary (Braavolabs).

# @ai-company-os/cli

Terminal interface for Braavolabs — two distinct binaries for agent operations and multi-model orchestration.

## Overview

**`braavo`** — Run & pipeline steering (ops CLI)
- Start runs, steer live agents, manage handoffs across provider boundaries
- Dependency-free (Node 20+ only)
- Self-host capable (custom API base)

**`forge`** — Multi-model council & BYOK keys (developer CLI)
- Compare models side-by-side (`ask`), route cheapest-capable-first (`cascade`)
- View cost & token savings over time
- Store local provider API keys (macOS Keychain / chmod-600 file)
- Keys never leave your machine

## Installation

```bash
cd packages/cli
pnpm build
# Binaries are now at:
#   ./dist/index.js    → symlink to ~/.local/bin/braavo (or use directly)
#   ./dist/forge.js    → symlink to ~/.local/bin/forge (or use directly)

# Or install globally:
pnpm build && npm link
```

Both binaries are zero-dependency; they run on Node 20+.

## Quick Start

### forge

```bash
# Log in (token or email/password)
forge login --api https://your-api.com --token "eyJ..."

# Set a default company (optional, can be overridden per-command)
forge use coy_123abc

# Ask a question to multiple models
forge ask "Explain OAuth 2.0" --models claude,gpt4,gemini

# Cascade: cheapest model that meets your confidence threshold
forge cascade "Summarize the Anthropic research paper" --threshold 0.9

# View cost savings over the last 7 days
forge savings --days 7

# Manage local API keys (never sent to the server)
forge keys add anthropic --key "sk-ant-v0..."
forge keys list
forge keys rm anthropic
```

### braavo

```bash
# Log in
braavo login --email you@example.com --password "..."
braavo login --api https://self-host.local/api/v1 --token "eyJ..."

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

## forge Commands

### login

Authenticate with email/password or JWT token.

```bash
forge login --email user@example.com --password "..."
forge login --token "eyJ0eXAiOiJKV1QiL..."
forge login --api https://internal.example.com --token "..."
```

Stores credentials in `~/.forge/config.json` (with refresh-token support). Uses transparent single-retry on 401 to refresh expired tokens.

### use

Set the default company for `ask` and `cascade` commands.

```bash
forge use company_xyz
```

Overridable per-command: `forge ask "..." --company company_abc`

### ask

Compare responses across multiple models (async poll).

```bash
forge ask "What's a good state machine library?" --models claude,gpt4
```

Shows side-by-side answers from each model, plus a synthesis (if the server provides one), and token/cost savings vs. baseline.

### cascade

Cheap-first routing with optional escalation.

Starts with the cheapest model that meets your confidence threshold; escalates to expensive models only if low confidence is returned.

```bash
forge cascade "Explain DNS resolution" --threshold 0.85
forge cascade "Write Rust code" --threshold 0.9 --second-opinion
forge cascade "..." --budget 2.50
```

Shows the chosen model, confidence score, total cost, and any escalation attempts.

### savings

View cost & token savings from cascade routing over a date range.

```bash
forge savings
forge savings --days 30
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
forge keys add openai --key "sk-proj-abc..."
forge keys add anthropic --key "sk-ant-v0..."
forge keys list
forge keys rm openai
```

#### Key Storage

**macOS:** Keys live in the login keychain (service "forge-cli"), indexed by a names-only file `~/.forge/keys-index.json`. The secret value is never stored in plaintext.

**Other platforms:** Keys are stored in `~/.forge/keys.json` with permissions `chmod 600` (owner read/write only). You'll see a warning that they're not in the OS keychain.

**Important:** Keys are never sent to the Braavolabs server. They're stored and used locally only — for future Lane-A direct-provider integrations or local model inference.

When you run `forge keys list`, only a masked fingerprint (first-4 and last-4 characters) is displayed. The full secret is never echoed.

### logout

Clear stored credentials and keys.

```bash
forge logout
```

## braavo Commands

`braavo` is the ops/steering CLI — shorter reference below. See `braavo --help` for full details.

### login / logout / whoami

```bash
braavo login --email user@example.com --password "..."
braavo login --token "eyJ..."
braavo whoami
braavo logout
```

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
2. `continue` claims that slot, resuming on the new provider/model.

### connections

List external provider connections (API keys, base URLs, etc.).

```bash
braavo connections
```

Shows status, platform (e.g., "OLLAMA", "OPENAI"), label, and base URL.

## Configuration

### Environment Variables

**forge**
- `FORGE_API_URL` — Override the API base (default: from config or `~/.forge/config.json`)
- `FORGE_KEY` — Provide an API key via env (for `forge keys add`; if not set, you'll be prompted)

**braavo**
- `BRAAVO_API_URL` — Override the API base (default: `https://braavolabs.com/api/v1`)

### Config Files

- **forge:** `~/.forge/config.json` — API URL, JWT token, refresh token
- **braavo:** `~/.braavo/config.json` — Same structure
- **forge keys:** `~/.forge/keys-index.json` (macOS) or `~/.forge/keys.json` (all platforms)

Both binaries support `--api <url>` at login time to point to a self-hosted instance.

## Non-Interactive Mode (TTY-less)

Both binaries detect whether stdin/stdout are a terminal. In non-interactive environments (e.g., CI, cron, scripts):

- `prompt()` calls (e.g., "Email: ", password input) **will fail with "No TTY"** — pass credentials via flags or env:
  ```bash
  forge login --token "eyJ..." --api https://your.api/v1
  braavo login --token "eyJ..."
  ```

- Output formatting adapts: no ANSI colors/spinners in pipe/file contexts (auto-detected via `isTTY`).

- Errors exit with code 1; success is silent or exits 0.

## Output Examples (Plain Text)

### forge ask

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

### forge cascade

```
Rust's ownership model ensures memory safety at compile time. Each value has a
single owner; when it goes out of scope, memory is automatically freed. You can
borrow values immutably (multiple readers) or mutably (single writer), enforced
by the borrow checker.

claude-opus/claude-3-opus-20250514 · tier=4 · confidence=97% · no escalation · $0.0156
```

### forge savings

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

**"Not logged in. Run: forge login"**
- No valid token in `~/.forge/config.json`
- Use `forge login --token "..."` or `forge login --email ... --password ...`

**"API 401: Unauthorized"**
- Token expired; if a refresh token is stored, the CLI retries automatically
- If both tokens are invalid, re-login

**"No company. Run: forge use <companyId>"**
- No default company set; either:
  - `forge use <id>` once, or
  - Pass `--company <id>` to each `ask`/`cascade` command

**Keys show as "(missing)" in forge keys list (macOS)**
- The keychain entry was deleted out-of-band (e.g., Keychain Access.app)
- Re-add: `forge keys add <provider> --key "..."`

**"Stored in ~/.forge/keys.json (chmod 600) — no OS keychain on this platform"**
- You're not on macOS; keys are stored in plaintext with restricted permissions
- This is expected. Keep the file secure and back up carefully.

**Cannot write to ~/.forge/ or ~/.braavo/**
- Ensure the directory exists and you have write permissions
- Both binaries auto-create the directory on first login

## Development

### Build

```bash
pnpm build
```

Compiles TypeScript to `dist/`.

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

- **forge** and **braavo** are separate CLI tools, not a monolithic interface. Each solves a distinct problem (multi-model steering vs. pipeline ops).
- Both use the same config structure but separate config files (`~/.forge/` vs `~/.braavo/`).
- `braavo` is an **ops** tool meant for control-plane integration; `forge` is a **developer** tool.
- No runtime dependencies — both are pure Node with built-in fetch + fs + readline.
- Transparent token refresh on 401 (single retry) mirrors web/mobile behavior.
- Self-host support: both accept `--api <url>` at login time.

## License

Proprietary (Braavolabs).

# Changelog

All notable changes to `@braavolabs/cli` (the `braavo` command) are documented
here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Versioned entries describe release candidates and published packages; older
development history remains grouped by date.

## Unreleased

### Added
- GitHub triggers: `braavo company trigger add github <owner/repo>` opens tasks
  for new issues, pull requests, comments, reviews, releases, discussions and
  failed workflow runs. Polling (Events API with ETags) by default; `--webhook`
  gives the trigger an HMAC-checked address on the daemon and a one-time secret.
  `braavo github login | status | logout` signs in with the Braavolabs GitHub
  App's device flow; the token stays in the OS keychain.

### Changed
- The macOS keychain lookup no longer prints `security`'s "item not found" line.
- `direct` and `fix --via direct` default Anthropic to
  `claude-sonnet-5-5` (claude-3-5-sonnet is retired) and allow 4096 output
  tokens, since current models think before answering.

### Added
- `code --shell`: the coding agent can run commands (tests, builds) in an OS
  sandbox (macOS `sandbox-exec`, Linux `bwrap`): no network, writes only in
  the project, credential folders unreadable, no API keys in the
  environment, and a terminal confirmation for every command.
- Watch routines treat a price-only change back to a price set seen in the
  last 14 days as "recurring" (slow A/B tests): kept in the price history,
  no finding or notification.
- Competitor price history: watch routines record each page's price set as
  temporal facts (schema 3); `GET /companies/:id/prices`, `company prices`.
- `code --allow-web <domains>` (allowlisted web_fetch) and
  `code --review-model PROVIDER/model` (second model reviews each diff; a
  risky verdict always needs a human).
- Add `setup` (daemon, key names, local models, suggested model per tier,
  next step) and `models pull <name>` (pull into the local Ollama), and
  `chat export <id> [--format md|json]`.
- Add `code`: our own coding agent (read, search, edit, write inside one
  directory) on your own key or local model, with project instructions from
  `AGENTS.md`/`CLAUDE.md`, a diff and a confirmation for every write,
  `--plan` (read-only), and `code undo` from per-write checkpoints.
- Add `company`: create your local company from the seven starter agents
  (`init`, `hire`), see the org panel (`show`), tune agents (`set --model
  --effort --pause/--resume`), add competitor watch routines (`watch --urls
  @file`), run one now (`run`) and read findings (`findings`). The daemon
  gains `POST /companies/:id/hire`, `GET /companies/:id/panel` and
  `PATCH /agents/:id`, calendar routines in the routine's time zone, and web
  preflight that calls the model only when a watched page really changed.
- Add `chat`: multi-turn, streamed chat through the local daemon (`list`,
  `show`, `search`, `--continue`, piped input), models suggested from your own
  keys and pulled local models. The daemon gains the chat API shared with the
  desktop and mobile apps (docs/DAEMON-CHAT.md): conversations, SSE turns,
  abort, idempotent history import and search.
- Add `daemon run|start|install --relay`: opt-in phone chat over the existing
  relay protocol, one relay session per computer.
- Add `daemon run|start|stop|status`: the first slice of the local AI-company
  runtime — loopback-only token-authenticated API, owner-only SQLite store
  (companies, agents with reporting lines, routines and execution ledger,
  conversations with full-text search), and a 60 s scheduler with one
  catch-up run after sleep.
- The daemon now runs due routines for real: one streamed model call per run
  through the shared core client (Anthropic via the official SDK, OpenAI-
  compatible providers, Ollama/LM Studio), with per-agent effort, BYOK keys
  read from `braavo keys` and redacted from errors, and the reply stored as a
  searchable conversation plus a token cost event.
- Add `daemon install|uninstall` (macOS): a per-user LaunchAgent that starts
  the daemon at login and restarts it after a crash; `--dry-run` prints it.
- Add `monitor add|list|rm|check|log` (prototype): model-free web page change
  detection with an optional local Ollama summary of real changes only. Text or
  price mode, `--every` interval with `check --due` for cron/launchd, untrusted
  page content wrapping, 2 MB page cap, `0600` state under `~/.braavo/monitor/`.
  Human output is localized in all 14 languages.
- `monitor add --notify price,plans,promo,release,text` chooses what counts as a
  change per monitor (default: the four structural kinds). Signals come from page
  structure, not keywords; cookie/consent banners, `<time>` text and countdowns
  are ignored. Monitors and state saved by the first prototype keep working.

## 0.2.0 — release candidate

The latest published version is 0.1.1. Version 0.1.2 was prepared as a release
candidate but never published; its changes ship in 0.2.0. The minor version
reflects the raised Node.js requirement.

### Breaking
- Require Node.js 24.22.0 or later (`engines.node >=24.22.0`, previously `>=18`).
  CI runs on Node 24 LTS.

### Added
- Localize human CLI output in 14 languages: `tr`, `en`, `es-419`, `pt-BR`, `de`,
  `fr`, `ja`, `ar`, `it`, `ko`, `id`, `pl`, `hi`, `zh-Hans`. Select one with
  `--lang <code>` or set a default with `BRAAVO_LOCALE`; `--lang` wins. Unknown
  codes warn and fall back to English. Command names, JSON results, protocol
  values, and exit codes stay unchanged.
- Add accessible terminal themes: `BRAAVO_THEME=light|dark|system` selects a
  session-only foreground palette (explicit palettes target at least 4.5:1
  contrast). `NO_COLOR`/`BRAAVO_NO_COLOR` disable color and animation;
  `BRAAVO_REDUCED_MOTION` disables animation. Help prose wraps at the terminal
  width without splitting grapheme clusters.
- Add `cancel <researchId> --yes [--json]` for explicit research soft-cancellation,
  preserving the server's completed/failed status when work already finished.

### Fixed
- Bound request lifecycles with per-command deadlines.
- Stop local `ask`/`watch` waits on Ctrl-C with exit 130 and an explicit remote
  cancel/stop hint; do not implicitly cancel remote work.
- Keep polling with its original account, API, and persisted config owner;
  release interrupted delays and avoid an extra delay after the final attempt.
- Reject malformed start/stop/cancel acknowledgements and polling statuses;
  emit the actual started run response for `run --json`.
- Stop relay retries on malformed refresh JSON/data or persistence failure,
  while preserving retries for dropped network response bodies.
- Preserve transient authentication-refresh HTTP failures so a companion stream
  can reconnect after 408/429/5xx recovery; keep raw response handling and
  permanent authentication rejection behavior.
- Reconnect dropped companion command streams with bounded backoff, resume from
  the last delivered sequence, and suppress duplicate/stale replay commands.
- Stop retrying on terminal relay markers, permanent HTTP failures, unsubscribe,
  logout, or session replacement.

### Tests
- Exercise the compiled CLI's selection, polling, cancellation, Ctrl-C, terminal
  statuses, JSON output, and failure exits with isolated synthetic fixtures;
  cover account replacement and refresh protocol/persistence boundaries.
- Cover disconnect/replay, sequence dedup, terminal markers, cancellation,
  transient/permanent failures, and authentication refresh with injected streams.

### Security
- Upgrade the only runtime dependency, `zod`, from 3.x to 4.6 (GHSA-mrhx-c7xc-m3w5 /
  CVE-2023-54404: unbounded issue collection for oversized arrays). The relay
  protocol schemas have no array schemas, so the path was not reachable; the
  upgrade keeps the published package free of known advisories.
- Development toolchain: `vitest` 4.1.12 and `vite` 7.3.7 (dev-only advisories).

## 0.1.1 — release candidate

### Changed
- Add Braavolabs coin-inspired terminal activity with quiet non-TTY and no-color output.
- Print the package version for both `--version` and `-v`.
- Document config-over-environment API precedence and explicit custom-host trust.

### Fixed
- Return the documented authentication and local-usage exit codes.
- Apply a bare `--allow-custom-host` to the explicitly selected effective host,
  without carrying trust to a different host or allowing plaintext remote HTTP.
- Read the persisted MCP server registry in `doctor`.

### Tests
- Exercise the compiled CLI with isolated config and synthetic network responses;
  keep JSON output on stdout and diagnostics on stderr.

## 2026-07-18

### Changed
- **Forge → Braavolabs rebrand** (#2) — the two bins (`braavo` + `forge`) fold
  into a single `braavo` command; config moves to `~/.braavo`. The internal
  `src/forge/` module path is kept (not user-visible).

### Fixed
- Logout now sends the refresh token in the request body, with a shared-client
  drift-guard, so sign-out revokes server-side even with an expired access
  token (audit #1/C3) (#1).

## 2026-07-17

### Changed
- Extracted from the `braavolabs` monorepo into the standalone
  `kocakkmustafa/braavolabs-cli` repo, with its own CI (pnpm pinned via
  `packageManager`).

### Fixed
- Two live bugs from the ecosystem audit: `flag("true")` collapse and an eager
  auth-gate.
- R3 audit C3: `LoginResult` aligned to server truth; refresh token revoked on
  logout.

### Added
- `forge image` / `forge voice` / `media-key` — terminal surface for the media
  backend.

## 2026-07-15 → 2026-07-16

### Added
- Vibe-coding host bin: `forge local` + `forge direct` (Lane-A serverless
  BYOK), `forge spawn` (Lane-B safe-spawn adapter), `--repo` context + fix
  flow, and an MCP stdio client (P-C2 → P-C4).
- CLI reference manual; test coverage for args, client, renderers, key store.

## 2026-06-01 → 2026-07-03

### Added
- Initial `braavo` CLI (Pillar 7): `login`, `runs`, `run`, `steer`,
  `connections`; later `handoff` / `continue` / `handoffs` (E3).

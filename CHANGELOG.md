# Changelog

All notable changes to `@braavolabs/cli` (the `braavo` command) are documented
here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Versioned entries describe release candidates and published packages; older
development history remains grouped by date.

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

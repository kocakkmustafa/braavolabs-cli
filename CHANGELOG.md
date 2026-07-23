# Changelog

All notable changes to `@braavolabs/cli` (the `braavo` command) are documented
here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).
The package is not yet published to a registry, so entries are grouped by date;
versioned sections start when releases do.

## [Unreleased]

- _(nothing yet)_

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

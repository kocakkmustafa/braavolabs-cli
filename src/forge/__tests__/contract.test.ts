import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DRIFT-GUARD (audit C3). The CLI and Desktop API clients are "verbatim ports"
 * of one another, but nothing stopped them from silently diverging — and they
 * DID: sign-out on Desktop used to clear local tokens WITHOUT calling
 * /auth/logout, so the refresh token stayed valid server-side (the exact hole
 * R3 closed on the CLI + web). This test pins the SHARED contract every
 * authenticated Forge surface must honour, so the next divergence fails CI
 * instead of shipping silently. Keep this list byte-identical to the Desktop's
 * `contract.test.ts` — that duplication IS the guard: one canonical contract,
 * asserted independently in each repo. Surface-specific endpoints (media = CLI,
 * memory = Desktop) are intentional and deliberately NOT asserted here.
 */

// Resolve from the package root (vitest's cwd) — module-system-agnostic, so the
// same shape works in the CLI's commonjs build and the Desktop's ESM/Vite build.
const clientSrc = readFileSync(join(process.cwd(), "src", "forge", "client.ts"), "utf8");

// Endpoints EVERY authenticated surface must wire. Dropping any is a real defect.
const SHARED_ENDPOINTS = [
  "/auth/login", // public credential exchange
  "/auth/refresh", // transparent single-refresh on 401
  "/auth/logout", // server-side refresh-token revocation on sign-out (C3)
  "/research/compare", // async multi-model compare (returns a poll id)
  "/research/${", // GET /research/:id — the dynamic poll endpoint
  "/research/cascade", // synchronous tenant cascade
  "/billing/savings", // tenant savings report
];

// Load-bearing SECURITY invariants inside the shared apiFetch. A refactor that
// drops one is a vulnerability, so pin the literal source, not just behaviour.
const SECURITY_INVARIANTS = [
  '!path.startsWith("/auth/")', // never run the 401-refresh loop on auth endpoints
];

describe("API client contract (drift-guard vs the Desktop port)", () => {
  for (const ep of SHARED_ENDPOINTS) {
    it(`wires the shared endpoint ${ep}`, () => {
      expect(
        clientSrc.includes(ep),
        `client.ts no longer references ${ep} — shared CLI/Desktop contract drift`,
      ).toBe(true);
    });
  }

  for (const inv of SECURITY_INVARIANTS) {
    it(`preserves the security invariant ${inv}`, () => {
      expect(clientSrc.includes(inv), `apiFetch lost the invariant: ${inv}`).toBe(true);
    });
  }

  it("keeps the login call public (auth:false — no bearer sent on sign-in)", () => {
    expect(clientSrc).toMatch(/\/auth\/login[\s\S]{0,200}auth:\s*false/);
  });
});

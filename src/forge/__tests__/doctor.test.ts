import { describe, it, expect } from "vitest";
import { runDoctor } from "../doctor";
import type { Config } from "../config";

/**
 * BR-P1-002 — `braavo doctor` (roadmap §5.2: checks API host fingerprint,
 * keychain/config permission, sandbox, MCP and relay).
 */
const base: Config = { apiUrl: "https://braavolabs.com/api/v1" };
const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
const deadFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

const find = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  checks.find((c) => c.name === name)!;

describe("braavo doctor", () => {
  it("does not require authentication — the usual reason to run it is that auth broke", async () => {
    const checks = await runDoctor(base, okFetch);
    expect(find(checks, "credentials").status).toBe("warn");
    expect(find(checks, "credentials").detail).toMatch(/not logged in/);
  });

  it("passes an official HTTPS host", async () => {
    expect(find(await runDoctor(base, okFetch), "api host").status).toBe("ok");
  });

  it("FAILS an untrusted custom host that has not been opted into", async () => {
    const checks = await runDoctor({ apiUrl: "https://attacker.test/api/v1" }, okFetch);
    expect(find(checks, "api host").status).toBe("fail");
    expect(find(checks, "api host").detail).toMatch(/not an official host/);
  });

  it("downgrades an opted-into custom host to a warning, not a pass", async () => {
    const checks = await runDoctor(
      { apiUrl: "https://forge.acme.example/api/v1", allowCustomHost: true },
      okFetch,
    );
    // A self-hoster should still SEE that they are off the official host.
    expect(find(checks, "api host").status).toBe("warn");
  });

  it("FAILS plaintext HTTP to a non-loopback host", async () => {
    const checks = await runDoctor({ apiUrl: "http://forge.acme.example/api/v1", allowCustomHost: true }, okFetch);
    expect(find(checks, "api host").status).toBe("fail");
    expect(find(checks, "api host").detail).toMatch(/plaintext/);
  });

  it("reports an unreachable API as a failure rather than throwing", async () => {
    const checks = await runDoctor(base, deadFetch);
    expect(find(checks, "api reachable").status).toBe("fail");
    expect(find(checks, "api reachable").detail).toMatch(/ECONNREFUSED/);
  });

  it("NEVER prints the token, not even a prefix", async () => {
    const secret = "super-secret-access-token-value";
    const checks = await runDoctor({ ...base, token: secret, refreshToken: "rt-secret" }, okFetch);
    const rendered = JSON.stringify(checks);
    // doctor output is the single most likely thing to be pasted into a bug
    // report, so presence is reportable and the value never is.
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("rt-secret");
    expect(find(checks, "credentials").status).toBe("ok");
  });

  it("reports the sandbox honestly for this platform", async () => {
    const s = find(await runDoctor(base, okFetch), "sandbox");
    expect(["ok", "warn"]).toContain(s.status);
    expect(s.detail).toContain(process.platform);
  });
});

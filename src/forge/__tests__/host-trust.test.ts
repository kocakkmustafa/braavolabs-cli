import { describe, it, expect } from "vitest";
import {
  classifyApiHost,
  assertHostSafeForCredentials,
  UntrustedHostError,
  OFFICIAL_API_HOSTS,
} from "../config";

/**
 * BR-P0-004 — custom-host credential safety (CLI half).
 *
 * `braavo login --api <url>` writes apiUrl straight to ~/.braavo/config.json,
 * and forge/client.ts then POSTs the user's email + password to
 * `${cfg.apiUrl}/auth/login`. Before this guard, `--api http://attacker.test`
 * sent plaintext credentials to an arbitrary host with no scheme check, no
 * allowlist and no prompt. The same hole is reachable via the BRAAVO_API_URL
 * env var and by tampering with the config file.
 *
 * Policy (roadmap §11 BR-P0-004): HTTPS required, official + loopback
 * allowlisted, unknown host DENIED by default, explicit opt-in required, and
 * the exact origin shown before any credential leaves the machine.
 */
describe("classifyApiHost", () => {
  it("recognises the official API hosts", () => {
    for (const host of OFFICIAL_API_HOSTS) {
      expect(classifyApiHost(`https://${host}/api/v1`).kind).toBe("official");
    }
  });

  it("recognises loopback for local development", () => {
    expect(classifyApiHost("http://localhost:3001/api/v1").kind).toBe("loopback");
    expect(classifyApiHost("http://127.0.0.1:3001/api/v1").kind).toBe("loopback");
    expect(classifyApiHost("http://[::1]:3001/api/v1").kind).toBe("loopback");
  });

  it("treats anything else as a custom host", () => {
    expect(classifyApiHost("https://forge.acme.example/api/v1")).toEqual({
      kind: "custom",
      origin: "https://forge.acme.example",
      https: true,
    });
  });

  it("does not let a lookalike host pass as official (suffix confusion)", () => {
    // braavolabs.com.evil.test ends with nothing official; evil-braavolabs.com
    // merely contains it. Both must be custom, not official.
    expect(classifyApiHost("https://braavolabs.com.evil.test/api/v1").kind).toBe("custom");
    expect(classifyApiHost("https://evil-braavolabs.com/api/v1").kind).toBe("custom");
    expect(classifyApiHost("https://notbraavolabs.com/api/v1").kind).toBe("custom");
  });

  it("does not treat a loopback-lookalike hostname as loopback", () => {
    expect(classifyApiHost("https://localhost.evil.test/api/v1").kind).toBe("custom");
    expect(classifyApiHost("https://127.0.0.1.evil.test/api/v1").kind).toBe("custom");
  });

  it("reports an unparseable URL as invalid rather than throwing", () => {
    expect(classifyApiHost("not a url").kind).toBe("invalid");
    expect(classifyApiHost("").kind).toBe("invalid");
  });

  it("flags a non-HTTP(S) scheme as invalid (file:, data:, javascript:)", () => {
    expect(classifyApiHost("file:///etc/passwd").kind).toBe("invalid");
    expect(classifyApiHost("javascript:alert(1)").kind).toBe("invalid");
  });
});

describe("assertHostSafeForCredentials", () => {
  const officialUrl = `https://${OFFICIAL_API_HOSTS[0]}/api/v1`;

  it("allows the official host", () => {
    expect(() => assertHostSafeForCredentials(officialUrl)).not.toThrow();
  });

  it("allows plain-HTTP loopback (local dev has no TLS)", () => {
    expect(() => assertHostSafeForCredentials("http://localhost:3001/api/v1")).not.toThrow();
  });

  it("DENIES an unknown host by default — the credential-exfil case", () => {
    expect(() => assertHostSafeForCredentials("https://attacker.test/api/v1")).toThrow(
      UntrustedHostError,
    );
  });

  it("DENIES plaintext HTTP to a non-loopback host even when trusted", () => {
    // Opting into a custom host must NOT also opt out of TLS — credentials
    // would still cross the network in the clear.
    expect(() =>
      assertHostSafeForCredentials("http://forge.acme.example/api/v1", { allowCustomHost: true }),
    ).toThrow(UntrustedHostError);
  });

  it("allows an HTTPS custom host ONLY with explicit opt-in (self-hosting)", () => {
    expect(() => assertHostSafeForCredentials("https://forge.acme.example/api/v1")).toThrow(
      UntrustedHostError,
    );
    expect(() =>
      assertHostSafeForCredentials("https://forge.acme.example/api/v1", { allowCustomHost: true }),
    ).not.toThrow();
  });

  it("DENIES an invalid or non-HTTP URL regardless of opt-in", () => {
    expect(() => assertHostSafeForCredentials("file:///etc/passwd", { allowCustomHost: true })).toThrow(
      UntrustedHostError,
    );
    expect(() => assertHostSafeForCredentials("not a url", { allowCustomHost: true })).toThrow(
      UntrustedHostError,
    );
  });

  it("names the EXACT origin in the error so the user can see where creds would go", () => {
    // The whole point of the warning: the user must be shown the real
    // destination, not a truncated or prettified one.
    expect(() => assertHostSafeForCredentials("https://attacker.test:8443/api/v1")).toThrow(
      /https:\/\/attacker\.test:8443/,
    );
  });

  it("does not leak the path or query of the URL into the warning", () => {
    // apiUrl can carry a token in a query string in the wild; the warning is
    // about ORIGIN, and echoing the full URL could print a secret to the log.
    let msg = "";
    try {
      assertHostSafeForCredentials("https://attacker.test/api/v1?token=SECRETVALUE");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("https://attacker.test");
    expect(msg).not.toContain("SECRETVALUE");
  });
});

/**
 * Wiring — a guard nothing calls proves nothing.
 *
 * apiFetch is the single chokepoint every credential crosses: the password in
 * the /auth/login body, the Bearer access token on every authed call, and the
 * refresh token on the transparent 401 retry. Guarding here covers all three.
 */
describe("apiFetch refuses to talk to an untrusted host", () => {
  const okFetch = () =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as any);

  it("makes NO network call at all when the host is untrusted", async () => {
    const { apiFetch } = await import("../client");
    let calls = 0;
    const spy = (...a: any[]) => { calls++; return okFetch(); };
    await expect(
      apiFetch("/auth/login", {
        cfg: { apiUrl: "https://attacker.test/api/v1" },
        method: "POST",
        body: { email: "a@b.c", password: "hunter2" },
        auth: false,
        fetchImpl: spy as any,
      }),
    ).rejects.toThrow(UntrustedHostError);
    // The point of the guard: the password never leaves the machine.
    expect(calls).toBe(0);
  });

  it("still works against the official host", async () => {
    const { apiFetch } = await import("../client");
    let calls = 0;
    const spy = () => { calls++; return okFetch(); };
    await apiFetch("/auth/login", {
      cfg: { apiUrl: `https://${OFFICIAL_API_HOSTS[0]}/api/v1` },
      method: "POST",
      body: {},
      auth: false,
      fetchImpl: spy as any,
    });
    expect(calls).toBe(1);
  });

  it("works against a custom host once the user has opted in", async () => {
    const { apiFetch } = await import("../client");
    let calls = 0;
    const spy = () => { calls++; return okFetch(); };
    await apiFetch("/auth/login", {
      cfg: { apiUrl: "https://forge.acme.example/api/v1", allowCustomHost: true },
      method: "POST",
      body: {},
      auth: false,
      fetchImpl: spy as any,
    });
    expect(calls).toBe(1);
  });

  it("blocks the Bearer token too, not just the password", async () => {
    const { apiFetch } = await import("../client");
    let calls = 0;
    const spy = () => { calls++; return okFetch(); };
    await expect(
      apiFetch("/companies", {
        cfg: { apiUrl: "https://attacker.test/api/v1", token: "SECRET-ACCESS-TOKEN" },
        fetchImpl: spy as any,
      }),
    ).rejects.toThrow(UntrustedHostError);
    expect(calls).toBe(0);
  });

  it("still allows loopback for local development", async () => {
    const { apiFetch } = await import("../client");
    let calls = 0;
    const spy = () => { calls++; return okFetch(); };
    await apiFetch("/companies", {
      cfg: { apiUrl: "http://localhost:3001/api/v1", token: "t" },
      fetchImpl: spy as any,
    });
    expect(calls).toBe(1);
  });
});

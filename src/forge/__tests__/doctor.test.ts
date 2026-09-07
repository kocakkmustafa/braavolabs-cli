import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { runDoctor } from "../doctor";
import { CONFIG_DIR, type Config } from "../config";
import { addMcpServer, loadMcpConfig, MCP_PATH, removeMcpServer, saveMcpConfig } from "../mcp";

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "braavo-doctor-"));
  return { ...actual, CONFIG_DIR: dir, CONFIG_PATH: join(dir, "config.json") };
});

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

beforeEach(() => {
  rmSync(MCP_PATH, { force: true });
  vi.mocked(spawn).mockClear();
});
afterAll(() => rmSync(CONFIG_DIR, { recursive: true, force: true }));

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
  it("reads the same persisted registry as mcp add/list without starting a server", async () => {
    saveMcpConfig(addMcpServer({}, "audit-local", "never-start-this-command", ["private-fixture-argument"]));

    const checks = await runDoctor(base, okFetch);
    expect(find(checks, "mcp servers")).toEqual({
      name: "mcp servers", status: "ok", detail: "1 registered — inspect with: braavo mcp list",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(checks)).not.toContain("private-fixture-argument");

    saveMcpConfig(removeMcpServer(loadMcpConfig(), "audit-local"));
    expect(find(await runDoctor(base, okFetch), "mcp servers").status).toBe("warn");
  });

  it("reports no servers when the registry is absent", async () => {
    expect(find(await runDoctor(base, okFetch), "mcp servers")).toEqual({
      name: "mcp servers", status: "warn", detail: "none registered",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

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

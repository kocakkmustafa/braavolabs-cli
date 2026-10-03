/** Actual config I/O redirected only to an owned synthetic path; never ~/.braavo. */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";

const fixture = vi.hoisted(() => ({ path: "" }));
vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    loadConfig: () => actual.loadConfig(fixture.path),
    saveConfig: (cfg: Config) => actual.saveConfig(cfg, fixture.path),
    clearConfig: () => actual.clearConfig(fixture.path),
    saveConfigIfCurrent: (next: Config, owner: Config) =>
      actual.saveConfigIfCurrent(next, owner, fixture.path),
  };
});
import { apiFetch } from "../client";
import { clearConfig, saveConfig, saveConfigIfCurrent } from "../config";

let directory = "";
beforeEach(() => {
  const lane = dirname(process.cwd());
  directory = mkdtempSync(join(lane, "auth-cli-config-fixture-"));
  fixture.path = join(directory, "config.json");
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function resp(status: number, body: unknown) {
  return { status, ok: status === 200, statusText: String(status), json: async () => body };
}
const cfgA = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "A-old", refreshToken: "A-refresh-old" });

describe("CLI persisted session ownership across config instances", () => {
  it.each(["logout", "account", "api"] as const)("does not overwrite the disk owner after another config writer performs %s", async (change) => {
    const cfg = cfgA(); saveConfig(cfg);
    const refresh = deferred<ReturnType<typeof resp>>(); const started = deferred<void>();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) { started.resolve(); return refresh.promise; }
      return resp(401, {});
    });
    const result = apiFetch("/billing/savings", { cfg, fetchImpl }).catch(error => error);
    await started.promise;
    if (change === "logout") clearConfig();
    else saveConfig(change === "api"
      ? { ...cfgA(), apiUrl: "https://api.braavolabs.com/api/v2" }
      : { ...cfgA(), token: "B-token", refreshToken: "B-refresh" });
    const read = () => { try { return readFileSync(fixture.path, "utf8"); } catch { return null; } };
    const expected = read();
    refresh.resolve(resp(200, { token: "A-new", refreshToken: "A-refresh-new" }));
    const outcome = await result;
    expect(read()).toBe(expected);
    expect(outcome).toMatchObject({ name: "SessionChangedError" });
    expect(cfg.token).toBeUndefined(); expect(cfg.refreshToken).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still persists and replays a normal refresh for its unchanged disk owner", async () => {
    const cfg = cfgA(); saveConfig(cfg);
    const fetchImpl = vi.fn(async (url: string, init: any) => url.endsWith("/auth/refresh")
      ? resp(200, { token: "A-new", refreshToken: "A-refresh-new" })
      : init.headers.Authorization === "Bearer A-new" ? resp(200, { ok: true }) : resp(401, {}));
    expect(await apiFetch("/billing/savings", { cfg, fetchImpl })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toMatchObject({ token: "A-new", refreshToken: "A-refresh-new" });
    expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).sort()).toEqual(["config.json", "config.json.owner"]);
  });

  it("shares one lock across ordinary save, conditional refresh and clear", () => {
    const cfg = cfgA(); saveConfig(cfg);
    const before = readFileSync(fixture.path, "utf8");
    const lockPath = `${fixture.path}.lock`;
    const lock = openSync(lockPath, "wx", 0o600);
    try {
      expect(() => saveConfig({ ...cfg, token: "B-token" })).toThrow(/another process/);
      expect(() => saveConfigIfCurrent({ ...cfg, token: "A-new" }, cfg)).toThrow(/another process/);
      expect(() => clearConfig()).toThrow(/another process/);
      expect(readFileSync(fixture.path, "utf8")).toBe(before);
      expect(existsSync(lockPath)).toBe(true); // A failed contender never removes the owner's lock.
    } finally { closeSync(lock); rmSync(lockPath); }
    clearConfig();
    expect(readdirSync(directory)).toEqual(["config.json.owner"]);
  });

  it("fails closed on corrupted config without replacing it or leaving a lock", () => {
    writeFileSync(fixture.path, "{invalid", { mode: 0o600 });
    expect(saveConfigIfCurrent({ ...cfgA(), token: "A-new" }, cfgA())).toBe(false);
    expect(readFileSync(fixture.path, "utf8")).toBe("{invalid");
    expect(readdirSync(directory)).toEqual(["config.json"]);
  });

  it.each(["token", "refreshToken"] as const)("compares the captured disk %s independently", (field) => {
    const owner = cfgA();
    const changed = { ...owner, [field]: "another-session-value" }; saveConfig(changed);
    expect(saveConfigIfCurrent({ ...owner, token: "A-new" }, owner)).toBe(false);
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toEqual(changed);
  });

  it("clears the pending in-memory owner if durable refresh cannot acquire its lock", async () => {
    const cfg = cfgA(); saveConfig(cfg);
    const lockPath = `${fixture.path}.lock`;
    const lock = openSync(lockPath, "wx", 0o600);
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(200, { token: "A-new", refreshToken: "A-refresh-new" }) : resp(401, {}));
    try {
      await expect(apiFetch("/billing/savings", { cfg, fetchImpl })).rejects.toMatchObject({ name: "SessionChangedError" });
      expect(cfg.token).toBeUndefined(); expect(cfg.refreshToken).toBeUndefined();
      expect(JSON.parse(readFileSync(fixture.path, "utf8")).token).toBe("A-old");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { closeSync(lock); rmSync(lockPath); }
  });

  it.each(["same-pair", "logout-then-same-pair"] as const)("rejects a refresh after a distinct durable %s owner restores identical credentials", async (change) => {
    const cfg = cfgA(); saveConfig(cfg);
    const refresh = deferred<ReturnType<typeof resp>>(); const started = deferred<void>();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) { started.resolve(); return refresh.promise; }
      return resp(401, {});
    });
    const result = apiFetch("/billing/savings", { cfg, fetchImpl }).catch(error => error);
    await started.promise;
    if (change === "logout-then-same-pair") clearConfig();
    saveConfig(cfgA());
    const expected = readFileSync(fixture.path, "utf8");
    refresh.resolve(resp(200, { token: "A-new", refreshToken: "A-refresh-new" }));
    expect(await result).toMatchObject({ name: "SessionChangedError" });
    expect(readFileSync(fixture.path, "utf8")).toBe(expected);
    expect(cfg.token).toBeUndefined(); expect(cfg.refreshToken).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves unrelated current disk defaults during an auth-only rotation", async () => {
    const cfg = { ...cfgA(), defaultCompany: "company-old", allowCustomHost: false }; saveConfig(cfg);
    const refresh = deferred<ReturnType<typeof resp>>(); const started = deferred<void>();
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) { started.resolve(); return refresh.promise; }
      return init.headers.Authorization === "Bearer A-new" ? resp(200, { ok: true }) : resp(401, {});
    });
    const result = apiFetch("/billing/savings", { cfg, fetchImpl });
    await started.promise;
    // A non-auth edit does not itself carry another credential owner.
    writeFileSync(fixture.path, JSON.stringify({ ...cfg, defaultCompany: "company-current", allowCustomHost: true }), { mode: 0o600 });
    refresh.resolve(resp(200, { token: "A-new", refreshToken: "A-refresh-new" }));
    expect(await result).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toMatchObject({ token: "A-new", defaultCompany: "company-current", allowCustomHost: true });
  });
});

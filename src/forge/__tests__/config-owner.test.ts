/** Real config disk transactions; rename failures are injected at the filesystem boundary. */
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fault = vi.hoisted(() => ({ renameTarget: "" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: (from: string, to: string) => {
    if (to === fault.renameTarget) throw Object.assign(new Error("Synthetic rename failure"), { code: "EIO" });
    actual.renameSync(from, to);
  } };
});
import { captureConfigOwner, clearConfig, commitLoginIfCurrent, DEFAULT_API, loadConfig, saveConfig, saveConfigIfCurrent, type Config } from "../config";
let directory = ""; let path = "";
const cfgA = (): Config => ({ apiUrl: DEFAULT_API, token: "A-old", refreshToken: "A-refresh-old", defaultCompany: "company-A", allowCustomHost: false });
const pair = { token: "A-new", refreshToken: "A-refresh-new" };
beforeEach(() => {
  directory = mkdtempSync(join(dirname(process.cwd()), "mobile-cli-owner-fixture-"));
  path = join(directory, "config.json");
});
afterEach(() => { fault.renameTarget = ""; rmSync(directory, { recursive: true, force: true }); });
const marker = () => readFileSync(`${path}.owner`, "utf8");
const files = () => readdirSync(directory).sort();

describe("durable non-secret CLI owner", () => {
  it("uses a private marker without changing config shape and persists a tombstone after clear", () => {
    chmodSync(directory, 0o755);
    const cfg = cfgA(); saveConfig(cfg, path);
    const owner = captureConfigOwner(cfg, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(cfgA());
    expect(Object.keys(loadConfig(path)).sort()).toEqual(Object.keys(cfgA()).sort());
    expect(Object.keys(JSON.parse(marker())).sort()).toEqual(["nonce", "version"]);
    expect(marker()).not.toContain("A-old"); expect(marker()).not.toContain("A-refresh-old");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.owner`).mode & 0o777).toBe(0o600);
    clearConfig(path);
    expect(existsSync(path)).toBe(false); expect(files()).toEqual(["config.json.owner"]);
    expect(JSON.parse(marker()).nonce).not.toBe(owner.nonce);
  });

  it("keeps one nonce across normal token rotations, then advances on successful login", () => {
    const cfg = cfgA(); saveConfig(cfg, path); const nonce = marker();
    const old = { ...cfg }; cfg.token = pair.token; cfg.refreshToken = pair.refreshToken;
    expect(saveConfigIfCurrent(cfg, old, path)).toBe(true);
    expect(marker()).toBe(nonce);
    const rotated = { ...cfg }; cfg.token = "A-newer";
    expect(saveConfigIfCurrent(cfg, rotated, path)).toBe(true);
    expect(marker()).toBe(nonce);
    const owner = captureConfigOwner(cfg, path);
    expect(commitLoginIfCurrent(cfg, { token: "B-token", refreshToken: "B-refresh" }, owner, path)).toBe(true);
    expect(marker()).not.toBe(nonce); expect(cfg.token).toBe("B-token");
  });

  it("does not rebind a previously loaded config to an independent same-pair owner", () => {
    saveConfig(cfgA(), path); const cfg = loadConfig(path);
    saveConfig(cfgA(), path);
    expect(() => captureConfigOwner(cfg, path)).toThrow(/Session changed/);
  });

  it("preserves current non-auth defaults during login commit", () => {
    const cfg = cfgA(); saveConfig(cfg, path); const owner = captureConfigOwner(cfg, path);
    writeFileSync(path, JSON.stringify({ ...cfg, defaultCompany: "company-current", allowCustomHost: true }), { mode: 0o600 });
    expect(commitLoginIfCurrent(cfg, pair, owner, path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...cfgA(), ...pair, defaultCompany: "company-current", allowCustomHost: true });
    expect(cfg.defaultCompany).toBe("company-current"); expect(cfg.allowCustomHost).toBe(true);
  });

  it("guards non-auth changes made by a cooperating writer against stale login clobber", () => {
    const cfg = cfgA(); saveConfig(cfg, path); const owner = captureConfigOwner(cfg, path);
    saveConfig({ ...cfg, defaultCompany: "company-current" }, path);
    const current = readFileSync(path, "utf8");
    expect(commitLoginIfCurrent(cfg, pair, owner, path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(current);
  });

  it("removes superseded optional defaults from memory as well as preserving their removal on disk", () => {
    const cfg = cfgA(); saveConfig(cfg, path); const owner = captureConfigOwner(cfg, path);
    writeFileSync(path, JSON.stringify({ apiUrl: cfg.apiUrl, token: cfg.token, refreshToken: cfg.refreshToken }), { mode: 0o600 });
    expect(commitLoginIfCurrent(cfg, pair, owner, path)).toBe(true);
    expect(cfg).toEqual({ apiUrl: DEFAULT_API, ...pair });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(cfg);
  });

  it("shares the same lock for coherent reads, captures, commits and existing writers", () => {
    const cfg = cfgA(); saveConfig(cfg, path); const owner = captureConfigOwner(cfg, path);
    const before = readFileSync(path, "utf8"); const beforeMarker = marker();
    const held = openSync(`${path}.lock`, "wx", 0o600);
    try {
      for (const action of [() => loadConfig(path), () => captureConfigOwner(cfg, path),
        () => commitLoginIfCurrent(cfg, pair, owner, path), () => saveConfig(cfg, path),
        () => saveConfigIfCurrent({ ...cfg, ...pair }, cfg, path), () => clearConfig(path)]) {
        expect(action).toThrow(/another process/);
      }
      expect(readFileSync(path, "utf8")).toBe(before); expect(marker()).toBe(beforeMarker);
      expect(existsSync(`${path}.lock`)).toBe(true);
    } finally { closeSync(held); rmSync(`${path}.lock`); }
  });

  it.each(["save", "login", "logout"] as const)("propagates a failed owner-marker replacement before %s can alter credentials", operation => {
    const cfg = cfgA(); saveConfig(cfg, path); const owner = captureConfigOwner(cfg, path);
    const before = readFileSync(path, "utf8"); const beforeMarker = marker();
    fault.renameTarget = `${path}.owner`;
    expect(() => operation === "save" ? saveConfig({ ...cfg, ...pair }, path)
      : operation === "login" ? commitLoginIfCurrent(cfg, pair, owner, path) : clearConfig(path)).toThrow(/Synthetic rename/);
    expect(readFileSync(path, "utf8")).toBe(before); expect(marker()).toBe(beforeMarker);
    expect(cfg).toEqual(cfgA()); expect(files()).toEqual(["config.json", "config.json.owner"]);
  });

  it.each([true, false])("a failed login config replacement invalidates its old owner without reporting success (initially present=%s)", present => {
    if (present) saveConfig(cfgA(), path);
    const cfg = loadConfig(path); const before = { ...cfg }; const owner = captureConfigOwner(cfg, path);
    const oldMarker = marker(); const contents = present ? readFileSync(path, "utf8") : null;
    fault.renameTarget = path;
    expect(() => commitLoginIfCurrent(cfg, pair, owner, path)).toThrow(/Synthetic rename/);
    expect(marker()).not.toBe(oldMarker); expect(cfg).toEqual(before);
    expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(contents);
    fault.renameTarget = "";
    expect(commitLoginIfCurrent(cfg, pair, owner, path)).toBe(false);
    expect(files()).toEqual(present ? ["config.json", "config.json.owner"] : ["config.json.owner"]);
  });

  it("rejects a removed or corrupted marker without recreating it for a pending commit", () => {
    const cfg = cfgA(); saveConfig(cfg, path); const owner = captureConfigOwner(cfg, path);
    const contents = readFileSync(path, "utf8"); rmSync(`${path}.owner`);
    expect(commitLoginIfCurrent(cfg, pair, owner, path)).toBe(false);
    expect(existsSync(`${path}.owner`)).toBe(false);
    writeFileSync(`${path}.owner`, "{corrupt", { mode: 0o600 });
    expect(() => commitLoginIfCurrent(cfg, pair, owner, path)).toThrow();
    expect(() => clearConfig(path)).toThrow(); expect(() => saveConfig(cfg, path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(contents); expect(marker()).toBe("{corrupt");
  });
});

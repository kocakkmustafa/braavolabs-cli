import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { parseArgs } from "../../forge";
import { loadConfig, saveConfig, DEFAULT_API, type Config } from "../config";

describe("parseArgs", () => {
  it("splits subcommand, positionals and --flag value pairs", () => {
    const r = parseArgs(["ask", "how", "are", "you", "--company", "c1", "--models", "a,b"]);
    expect(r.cmd).toBe("ask");
    expect(r.positionals).toEqual(["how", "are", "you"]);
    expect(r.flags).toEqual({ company: "c1", models: "a,b" });
  });

  it('treats a bare trailing --flag as "true"', () => {
    const r = parseArgs(["cascade", "hi", "--second-opinion"]);
    expect(r.positionals).toEqual(["hi"]);
    expect(r.flags["second-opinion"]).toBe("true");
  });

  it('treats --flag followed by another --flag as "true"', () => {
    const r = parseArgs(["keys", "list", "--verbose", "--json"]);
    expect(r.flags).toEqual({ verbose: "true", json: "true" });
    expect(r.positionals).toEqual(["list"]);
  });

  it("returns undefined cmd for empty argv", () => {
    expect(parseArgs([]).cmd).toBeUndefined();
  });
});

describe("config round-trip", () => {
  const path = join(tmpdir(), `forge-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

  it("saves and reloads the same config (with apiUrl default merged in)", () => {
    const cfg: Config = { apiUrl: "https://host/api/v1", token: "t", refreshToken: "r", defaultCompany: "co" };
    saveConfig(cfg, path);
    const loaded = loadConfig(path);
    expect(loaded).toEqual(cfg);
    rmSync(path, { force: true });
  });

  it("falls back to DEFAULT_API when the file is missing", () => {
    const loaded = loadConfig(join(tmpdir(), "forge-does-not-exist.json"));
    expect(loaded).toEqual({ apiUrl: DEFAULT_API });
  });
});

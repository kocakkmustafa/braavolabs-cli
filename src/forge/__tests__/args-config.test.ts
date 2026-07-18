import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { parseArgs } from "../../braavo";
import { loadConfig, saveConfig, DEFAULT_API, type Config } from "../config";

describe("parseArgs", () => {
  it("splits subcommand, positionals and --flag value pairs", () => {
    const r = parseArgs(["ask", "how", "are", "you", "--company", "c1", "--models", "a,b"]);
    expect(r.cmd).toBe("ask");
    expect(r.positionals).toEqual(["how", "are", "you"]);
    expect(r.flags).toEqual({ company: "c1", models: "a,b" });
  });

  it("stores a bare trailing --flag as boolean true (distinct from a string value)", () => {
    const r = parseArgs(["cascade", "hi", "--second-opinion"]);
    expect(r.positionals).toEqual(["hi"]);
    expect(r.flags["second-opinion"]).toBe(true);
  });

  it("stores --flag followed by another --flag as boolean true", () => {
    const r = parseArgs(["keys", "list", "--verbose", "--json"]);
    expect(r.flags).toEqual({ verbose: true, json: true });
    expect(r.positionals).toEqual(["list"]);
  });

  it('preserves a value that is literally "true" (`--cmd true` must not collapse to undefined)', () => {
    const r = parseArgs(["fix", "--cmd", "true", "--via", "ask"]);
    // The string value "true" is kept as a string — NOT turned into the bare
    // boolean — so `flag(flags,"cmd")` returns "true" and `braavo fix --cmd true`
    // actually runs the `true` command (regression guard for finding C-CLI-1).
    expect(r.flags.cmd).toBe("true");
    expect(typeof r.flags.cmd).toBe("string");
    expect(r.flags.via).toBe("ask");
  });

  it("returns undefined cmd for empty argv", () => {
    expect(parseArgs([]).cmd).toBeUndefined();
  });
});

describe("config round-trip", () => {
  const path = join(tmpdir(), `braavo-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

  it("saves and reloads the same config (with apiUrl default merged in)", () => {
    const cfg: Config = { apiUrl: "https://host/api/v1", token: "t", refreshToken: "r", defaultCompany: "co" };
    saveConfig(cfg, path);
    const loaded = loadConfig(path);
    expect(loaded).toEqual(cfg);
    rmSync(path, { force: true });
  });

  it("falls back to DEFAULT_API when the file is missing", () => {
    const loaded = loadConfig(join(tmpdir(), "braavo-does-not-exist.json"));
    expect(loaded).toEqual({ apiUrl: DEFAULT_API });
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  SPAWN_VENDORS,
  VENDOR_SPECS,
  isSpawnVendor,
  knownPaths,
  findBinary,
  spawnVendor,
  probeVendor,
  type ChildLike,
} from "../spawn";
import { makeUi } from "../ui";
import { renderSpawnList, spawnRiskLine, spawnFallbackLines } from "../../forge";

const colorUi = makeUi({ tty: true });

/** Any green ANSI escape — banned by the terminal-noir palette (rule: no green). */
function assertNoGreen(text: string) {
  expect(text).not.toMatch(/\x1b\[(?:\d+;)*(?:32|92)m/);
  for (const code of ["38;5;2m", "38;5;10m", "38;5;22", "38;5;28", "38;5;34", "38;5;40", "38;5;46"]) {
    expect(text).not.toContain(code);
  }
}

/** Filenames that would be OAuth token/cookie stores — rule (d): never touched. */
const TOKEN_FILE_HINTS = [".credentials", "auth.json", ".claude.json", "cookies", "/.codex/", "/.claude/"];
function assertNoTokenAccess(paths: string[]) {
  for (const p of paths) {
    for (const hint of TOKEN_FILE_HINTS) {
      expect(p).not.toContain(hint);
    }
  }
}

/** Fake ChildProcess whose lifecycle events we drive by hand. */
function fakeChild() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  const child: ChildLike = { on: (ev: string, cb: any) => void (handlers[ev] = cb) } as ChildLike;
  return { child, emit: (ev: string, ...args: any[]) => handlers[ev]?.(...args) };
}

describe("isSpawnVendor / VENDOR_SPECS", () => {
  it("recognizes exactly claude and codex", () => {
    expect(SPAWN_VENDORS).toEqual(["claude", "codex"]);
    expect(isSpawnVendor("claude")).toBe(true);
    expect(isSpawnVendor("codex")).toBe(true);
    expect(isSpawnVendor("gemini")).toBe(false);
  });

  it("carries the per-vendor ToS-risk levels the blueprint mandates (rule f)", () => {
    expect(VENDOR_SPECS.claude.risk).toContain("SAFE");
    expect(VENDOR_SPECS.claude.risk.toLowerCase()).toContain("volatile");
    expect(VENDOR_SPECS.codex.risk).toContain("SAFE");
    expect(VENDOR_SPECS.codex.risk.toLowerCase()).toContain("lowest");
    // Fallback (rule g) points at the API-key path, never a vendor OAuth flow.
    expect(VENDOR_SPECS.claude.fallback).toBe('forge direct anthropic "<question>"');
    expect(VENDOR_SPECS.codex.fallback).toBe('forge direct openai "<question>"');
  });

  it("known paths are neutral bin dirs, never a vendor config/token dir (rule d)", () => {
    assertNoTokenAccess([...knownPaths("claude", "/home/u"), ...knownPaths("codex", "/home/u")]);
  });
});

describe("findBinary — discovery order (rule b)", () => {
  it("returns the PATH hit first and does NOT consult the filesystem", () => {
    const existsSync = vi.fn(() => true);
    const which = vi.fn(() => "/opt/homebrew/bin/claude");
    const path = findBinary("claude", { which, existsSync, home: "/home/u" });
    expect(path).toBe("/opt/homebrew/bin/claude");
    expect(which).toHaveBeenCalledWith("claude");
    expect(existsSync).not.toHaveBeenCalled(); // PATH won → no fs probing at all
  });

  it("falls back to the first existing known bin path when not on PATH", () => {
    const which = vi.fn(() => undefined);
    // Only ~/.local/bin/codex exists.
    const existsSync = vi.fn((p: string) => p === "/home/u/.local/bin/codex");
    const path = findBinary("codex", { which, existsSync, home: "/home/u" });
    expect(path).toBe("/home/u/.local/bin/codex");
  });

  it("returns undefined when the binary is nowhere (drives the fallback, rule g)", () => {
    const which = vi.fn(() => undefined);
    const existsSync = vi.fn(() => false);
    expect(findBinary("claude", { which, existsSync, home: "/home/u" })).toBeUndefined();
  });

  it("never stats a token/cookie file while searching (rule d)", () => {
    const which = vi.fn(() => undefined);
    const probed: string[] = [];
    const existsSync = vi.fn((p: string) => {
      probed.push(p);
      return false;
    });
    findBinary("claude", { which, existsSync, home: "/home/u" });
    findBinary("codex", { which, existsSync, home: "/home/u" });
    expect(probed.length).toBeGreaterThan(0);
    assertNoTokenAccess(probed);
    // Every probed path ends in the bare binary name — pure executable lookups.
    for (const p of probed) expect(p).toMatch(/\/(claude|codex)$/);
  });
});

describe("spawnVendor — opaque passthrough (rules b, c, e)", () => {
  it("passes args VERBATIM as an array (no shell string → no injection)", async () => {
    const { child, emit } = fakeChild();
    let captured: any;
    const spawnImpl = (cmd: string, args: string[], opts: any) => {
      captured = { cmd, args, opts };
      return child;
    };
    const args = ["-p", "hi; rm -rf /", "--model", "sonnet"];
    const p = spawnVendor("/opt/homebrew/bin/claude", args, { cwd: "/work", spawnImpl });
    emit("exit", 0, null);
    await p;
    expect(captured.cmd).toBe("/opt/homebrew/bin/claude");
    expect(captured.args).toEqual(args); // exact array, malicious-looking token stays inert
    expect(typeof captured.cmd).toBe("string");
    expect(Array.isArray(captured.args)).toBe(true);
  });

  it("inherits stdio (opaque stream, never captured) and runs in the given cwd", async () => {
    const { child, emit } = fakeChild();
    let captured: any;
    const spawnImpl = (_c: string, _a: string[], opts: any) => {
      captured = opts;
      return child;
    };
    const p = spawnVendor("/bin/codex", [], { cwd: "/projects/x", spawnImpl });
    emit("exit", 0, null);
    await p;
    expect(captured.stdio).toBe("inherit");
    expect(captured.cwd).toBe("/projects/x");
  });

  it("owns the child exit code verbatim", async () => {
    for (const expected of [0, 2, 137]) {
      const { child, emit } = fakeChild();
      const p = spawnVendor("/bin/claude", [], { spawnImpl: () => child });
      emit("exit", expected, null);
      expect(await p).toBe(expected);
    }
  });

  it("maps a signal-terminated child (code null) to a non-zero code", async () => {
    const { child, emit } = fakeChild();
    const p = spawnVendor("/bin/claude", [], { spawnImpl: () => child });
    emit("exit", null, "SIGINT");
    expect(await p).toBe(1);
  });

  it("rejects when the spawn itself errors (binary vanished / not executable)", async () => {
    const { child, emit } = fakeChild();
    const p = spawnVendor("/bin/claude", [], { spawnImpl: () => child });
    emit("error", new Error("ENOENT"));
    await expect(p).rejects.toThrow("ENOENT");
  });
});

describe("probeVendor — installed-or-not only (rules d, 2)", () => {
  it("reports installed + version, calling --version ONLY on the resolved binary", () => {
    const which = vi.fn(() => "/opt/homebrew/bin/claude");
    const existsSync = vi.fn(() => false);
    const versionCalls: Array<{ path: string; args: string[] }> = [];
    const runVersion = vi.fn((path: string, args: string[]) => {
      versionCalls.push({ path, args });
      return "claude 1.2.3";
    });
    const status = probeVendor("claude", { which, existsSync, home: "/home/u", runVersion });
    expect(status).toMatchObject({ vendor: "claude", installed: true, path: "/opt/homebrew/bin/claude", version: "claude 1.2.3" });
    // version is read from the BINARY, never from a token/login file (rule d).
    expect(versionCalls).toEqual([{ path: "/opt/homebrew/bin/claude", args: ["--version"] }]);
    assertNoTokenAccess(versionCalls.map((c) => c.path));
  });

  it("stays 'installed' (no version) when --version fails — never peeks at login state", () => {
    const which = vi.fn(() => "/bin/codex");
    const runVersion = vi.fn(() => {
      throw new Error("unknown flag");
    });
    const status = probeVendor("codex", { which, existsSync: () => false, home: "/home/u", runVersion });
    expect(status.installed).toBe(true);
    expect(status.version).toBeUndefined();
  });

  it("reports not-installed without ever running a version probe", () => {
    const runVersion = vi.fn();
    const status = probeVendor("claude", { which: () => undefined, existsSync: () => false, home: "/home/u", runVersion });
    expect(status.installed).toBe(false);
    expect(status.path).toBeUndefined();
    expect(runVersion).not.toHaveBeenCalled();
  });
});

describe("spawn renderers (terminal-noir, no green)", () => {
  it("risk line is a single steel line carrying the vendor risk note", () => {
    const line = spawnRiskLine(colorUi, "claude");
    expect(line).toContain("SAFE");
    expect(line).toContain("38;5;245"); // steel
    assertNoGreen(line);
  });

  it("fallback lines name the vendor and the API-key command (rule g)", () => {
    const lines = spawnFallbackLines(colorUi, "codex");
    const joined = lines.join("\n");
    expect(joined).toContain("codex CLI not found");
    expect(joined).toContain('forge direct openai "<question>"');
    assertNoGreen(joined);
  });

  it("--list shows installed/not + risk per vendor, arc-blue but never green", () => {
    const lines = renderSpawnList(colorUi, [
      { vendor: "claude", installed: true, path: "/bin/claude", version: "1.2.3", risk: VENDOR_SPECS.claude.risk },
      { vendor: "codex", installed: false, risk: VENDOR_SPECS.codex.risk },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("claude");
    expect(joined).toContain("installed");
    expect(joined).toContain("1.2.3");
    expect(joined).toContain("not installed");
    expect(joined).toContain("38;5;75"); // arc-blue present → colors really on
    assertNoGreen(joined);
  });
});

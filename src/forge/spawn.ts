/**
 * forge spawn — Lane-B SAFE-SPAWN adapter.
 *
 * Forge runs the user's OWN, already-authenticated vendor CLI (claude / codex)
 * as a child process. It is a thin, opaque passthrough — NOT a re-implementation
 * of the vendor and NOT an OAuth client.
 *
 * The safety contract (enforced by construction here; documented in README):
 *   (a) NO vendor OAuth — the user must have logged in with the official binary
 *       beforehand. Forge never initiates or brokers a vendor sign-in.
 *   (b) Only the official binary (found on PATH, or at a generic bin location)
 *       is spawned as a child process, arguments passed as an array (execFile /
 *       spawn semantics) — never through a shell, so there is no injection seam.
 *   (c) stdout/stderr are an OPAQUE STREAM: we use stdio:"inherit" so the child
 *       talks straight to the terminal. Forge never captures, parses, tees, or
 *       forwards a single byte of that output — nothing to disk, telemetry, or
 *       any server. Token/identity are never extracted from the stream.
 *   (d) OAuth token/cookie files (~/.claude*, ~/.codex*, credentials, auth.json)
 *       are NEVER touched — not even read. Binary discovery deliberately looks
 *       ONLY at PATH and generic bin dirs, never inside a vendor config dir.
 *   (e) Each session runs in the user-supplied working directory (--dir, or the
 *       current cwd). Forge does NOT impose directory isolation; --dir is the
 *       documented knob.
 *   (f) Per-vendor ToS-risk level is surfaced in-product (see VENDOR_SPECS.risk).
 *   (g) If the binary is absent or fails, forge degrades gracefully by pointing
 *       at the API-key path (see VENDOR_SPECS.fallback) — it never fabricates a
 *       result or silently retries.
 *
 * exec / spawn / fs / paths are injectable so tests never touch a real binary,
 * a real keychain, or the real filesystem.
 */
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import { homedir } from "node:os";

export const SPAWN_VENDORS = ["claude", "codex"] as const;
export type SpawnVendor = (typeof SPAWN_VENDORS)[number];

export function isSpawnVendor(v: string): v is SpawnVendor {
  return (SPAWN_VENDORS as readonly string[]).includes(v);
}

export interface VendorSpec {
  /** Executable name as it appears on PATH. */
  bin: string;
  /** One-line ToS-risk note (rule f). Plain text — the UI layer paints it steel. */
  risk: string;
  /** Graceful API-key fallback suggestion (rule g). */
  fallback: string;
  /** Args used only to read a version string for `spawn --list`. */
  versionArgs: string[];
}

export const VENDOR_SPECS: Record<SpawnVendor, VendorSpec> = {
  claude: {
    bin: "claude",
    risk: "ToS risk: SAFE — volatile (policy can shift; runs your own authenticated CLI)",
    fallback: 'forge direct anthropic "<question>"',
    versionArgs: ["--version"],
  },
  codex: {
    bin: "codex",
    risk: "ToS risk: SAFE — lowest risk (runs your own authenticated CLI)",
    fallback: 'forge direct openai "<question>"',
    versionArgs: ["--version"],
  },
};

/**
 * Generic bin locations to probe when a vendor binary is not on PATH.
 *
 * These are deliberately NOT vendor config dirs — we never look inside
 * ~/.claude or ~/.codex (rule d). `.local/bin`, homebrew, `.bun/bin` and
 * `.cargo/bin` are neutral, tool-agnostic install prefixes.
 */
export function knownPaths(vendor: SpawnVendor, home: string): string[] {
  const bin = VENDOR_SPECS[vendor].bin;
  const paths = [
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `${home}/.local/bin/${bin}`,
    `${home}/.bun/bin/${bin}`,
  ];
  if (vendor === "codex") paths.push(`${home}/.cargo/bin/${bin}`);
  return paths;
}

export interface FindDeps {
  /** Resolve a binary via PATH (default: `which <bin>`). Returns undefined if absent. */
  which: (bin: string) => string | undefined;
  existsSync: (p: string) => boolean;
  home: string;
}

function defaultWhich(bin: string): string | undefined {
  try {
    // execFile (arg array) — no shell, so `bin` is never interpolated into a command line.
    const out = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function defaultFindDeps(partial: Partial<FindDeps> = {}): FindDeps {
  return {
    which: partial.which ?? defaultWhich,
    existsSync: partial.existsSync ?? ((p) => fsExistsSync(p)),
    home: partial.home ?? homedir(),
  };
}

/**
 * Locate the official vendor binary: PATH first, then generic bin dirs.
 * Returns the resolved path, or undefined if not installed. Never inspects a
 * vendor config/credential directory.
 */
export function findBinary(vendor: SpawnVendor, partial: Partial<FindDeps> = {}): string | undefined {
  const deps = defaultFindDeps(partial);
  const viaPath = deps.which(VENDOR_SPECS[vendor].bin);
  if (viaPath) return viaPath;
  for (const p of knownPaths(vendor, deps.home)) {
    if (deps.existsSync(p)) return p;
  }
  return undefined;
}

/** Minimal child-process surface used by spawnVendor (so tests inject a fake). */
export interface ChildLike {
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { stdio: "inherit"; cwd: string },
) => ChildLike;

/**
 * Spawn the resolved binary in interactive passthrough mode.
 *
 * stdio:"inherit" hands the child forge's own stdin/stdout/stderr — the stream
 * is never captured or parsed (rule c). Args are an array (rule b: no shell,
 * no injection). Resolves with the child's exit code, which the caller propagates
 * verbatim as forge's own exit code.
 */
export function spawnVendor(
  binPath: string,
  args: string[],
  o: { cwd?: string; spawnImpl?: SpawnImpl } = {},
): Promise<number> {
  const spawnImpl = o.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
  const cwd = o.cwd ?? process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binPath, args, { stdio: "inherit", cwd });
    child.on("error", (err) => reject(err));
    // A signal-terminated child has code === null; surface that as non-zero.
    child.on("exit", (code) => resolve(code === null ? 1 : code));
  });
}

export interface VendorStatus {
  vendor: SpawnVendor;
  installed: boolean;
  path?: string;
  /** Version string if the binary reported one; absence does NOT mean "not installed". */
  version?: string;
  risk: string;
}

export interface ProbeDeps extends Partial<FindDeps> {
  /** Read a version line from the binary (default: `execFile <path> --version`). */
  runVersion?: (path: string, args: string[]) => string;
}

function defaultRunVersion(path: string, args: string[]): string {
  return execFileSync(path, args, { encoding: "utf8" }).trim();
}

/**
 * Report whether a vendor CLI is installed — and its version if it volunteers
 * one. This intentionally reports ONLY installed-or-not: it never probes login
 * state, because doing so would require reading token/cookie files (rule d).
 */
export function probeVendor(vendor: SpawnVendor, deps: ProbeDeps = {}): VendorStatus {
  const spec = VENDOR_SPECS[vendor];
  const path = findBinary(vendor, deps);
  if (!path) return { vendor, installed: false, risk: spec.risk };
  const runVersion = deps.runVersion ?? defaultRunVersion;
  let version: string | undefined;
  try {
    const v = runVersion(path, spec.versionArgs);
    version = v || undefined;
  } catch {
    /* binary present but --version unsupported/failed; still installed */
  }
  return { vendor, installed: true, path, version, risk: spec.risk };
}

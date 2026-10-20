/**
 * braavo spawn — Lane-B SAFE-SPAWN adapter.
 *
 * braavo runs the user's OWN, already-authenticated vendor CLI (claude / codex)
 * as a child process. It is a thin, opaque passthrough — NOT a re-implementation
 * of the vendor and NOT an OAuth client.
 *
 * The safety contract (enforced by construction here; documented in README):
 *   (a) NO vendor OAuth — the user must have logged in with the official binary
 *       beforehand. braavo never initiates or brokers a vendor sign-in.
 *   (b) Only the official binary (found on PATH, or at a generic bin location)
 *       is spawned as a child process, arguments passed as an array (execFile /
 *       spawn semantics) — never through a shell, so there is no injection seam.
 *   (c) stdout/stderr are an OPAQUE STREAM: we use stdio:"inherit" so the child
 *       talks straight to the terminal. braavo never captures, parses, tees, or
 *       forwards a single byte of that output — nothing to disk, telemetry, or
 *       any server. Token/identity are never extracted from the stream.
 *   (d) OAuth token/cookie files (~/.claude*, ~/.codex*, credentials, auth.json)
 *       are NEVER touched — not even read. Binary discovery deliberately looks
 *       ONLY at PATH and generic bin dirs, never inside a vendor config dir.
 *   (e) Each session runs in the user-supplied working directory (--dir, or the
 *       current cwd). braavo does NOT impose directory isolation; --dir is the
 *       documented knob.
 *   (f) Account/provider-terms responsibility is surfaced (VENDOR_SPECS.risk).
 *   (g) If the binary is absent or fails, braavo degrades gracefully by pointing
 *       at the API-key path (see VENDOR_SPECS.fallback) — it never fabricates a
 *       result or silently retries.
 *
 * exec / spawn / fs / paths are injectable so tests never touch a real binary,
 * a real keychain, or the real filesystem.
 */
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { RelayBridge, BridgeHandlers } from "./relay-bridge";

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
    risk: "Official CLI; your account and the provider terms apply.",
    fallback: 'braavo direct anthropic "<question>"',
    versionArgs: ["--version"],
  },
  codex: {
    bin: "codex",
    risk: "Official CLI; your account and the provider terms apply.",
    fallback: 'braavo direct openai "<question>"',
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
    const out = execFileSync("which", [bin], { encoding: "utf8", timeout: 3_000, maxBuffer: 64 * 1024 }).trim();
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
 * stdio:"inherit" hands the child braavo's own stdin/stdout/stderr — the stream
 * is never captured or parsed (rule c). Args are an array (rule b: no shell,
 * no injection). Resolves with the child's exit code, which the caller propagates
 * verbatim as braavo's own exit code.
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

// ── Lane-B, OPT-IN: braavo spawn --bridge (companion relay TEE) ────────────
//
// Everything above (spawnVendor, the default, unchanged) stays the opaque,
// stdio:"inherit" passthrough the README's Lane-B contract mandates: braavo
// never reads a byte of the vendor's output. `--bridge` is a NARROW,
// deliberate, opt-in exception to that rule, made ONLY so a companion
// (mobile panel) can observe a spawned session remotely over the sealed
// relay control plane (relay-bridge.ts/relay-protocol.ts/relay-transport.ts)
// — the output is still never parsed for content and never written to disk;
// it is TEE'd to the terminal (the user still sees everything, unchanged)
// and, client-side redacted, to the relay. A user who never passes --bridge
// gets byte-for-byte the same opaque behavior as before this slice.

/** Minimal readable-stream surface used for the stdout/stderr TEE. */
export interface BridgedStream {
  on(event: "data", cb: (chunk: Buffer | string) => void): void;
}

/** Minimal writable-stream surface used to inject a companion steer message. */
export interface BridgedWritable {
  write(data: string): void;
}

/** Extended child-process surface `spawnVendorBridged` needs: stdout/stderr to
 * TEE, stdin to inject steer messages into, kill() for a companion kill. */
export interface BridgedChildLike {
  stdout: BridgedStream;
  stderr: BridgedStream;
  stdin: BridgedWritable;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): void;
}

export type SpawnImplBridged = (
  cmd: string,
  args: string[],
  opts: { stdio: "pipe"; cwd: string },
) => BridgedChildLike;

/**
 * A mutable box the spawned child is stashed into once it exists, shared
 * between `spawnVendorBridged` (which fills it in the instant the child is
 * created) and the `BridgeHandlers` built by `makeSpawnBridgeHandlers` (which
 * read it on every inbound steer/kill command). This indirection exists
 * because of an ordering constraint: `RelayBridge`'s handlers must be handed
 * to its constructor BEFORE the bridge is passed into `spawnVendorBridged`
 * and the child is spawned — so the handlers can't close directly over
 * `child`, which doesn't exist yet at handler-construction time. The box is
 * the seam: box → handlers → `new RelayBridge(transport, handlers)` →
 * `spawnVendorBridged` fills the box → commands that arrive afterward reach
 * a live child.
 */
export interface ChildRef {
  current: BridgedChildLike | null;
}
export function makeChildRef(): ChildRef {
  return { current: null };
}

/**
 * Build the `BridgeHandlers` for a `spawn --bridge` session.
 *
 *  - `onSteer`: writes the companion's message straight into the vendor
 *    child's stdin (newline-terminated, as if the user had typed it) — lets
 *    a companion mobile panel nudge a running claude/codex session.
 *  - `onKill`: SIGTERMs the child — lets a companion stop a runaway session
 *    remotely.
 *  - `onApprove`/`onReject`: braavo's spawn has NO local approval gate (see
 *    relay-bridge.ts's module header — that's Desktop's concept, not
 *    braavo's). The vendor CLI (claude/codex) makes its OWN approval
 *    decisions internally, out of braavo's sight, so there is nothing local
 *    for these to resolve. A companion approve/reject arriving here is a
 *    LOGGED no-op — `onIgnored` defaults to a one-line stderr note so a
 *    founder watching the terminal knows the command landed and did
 *    nothing, rather than wondering if it silently vanished.
 */
export function makeSpawnBridgeHandlers(
  ref: ChildRef,
  onIgnored: (kind: "approve" | "reject", actionId: string) => void = (kind, actionId) => {
    process.stderr.write(
      `· companion ${kind} ignored — braavo spawn has no local approval gate (actionId ${actionId})\n`,
    );
  },
): BridgeHandlers {
  return {
    onSteer(message: string) {
      // The companion's message is written into the vendor CLI's stdin as if
      // the user typed ONE line. Collapse embedded control chars (newline, CR,
      // ESC, BEL, …) to spaces so a single steer cannot inject MULTIPLE
      // lines/commands into the child — braavo is the last gate before the
      // child's stdin and must not lean solely on the relay's server-side
      // owner-binding (defence in depth). Exactly one trailing "\n" is added.
      const oneLine = message.replace(/[\u0000-\u001F\u007F]/g, " ").trimEnd();
      if (oneLine) ref.current?.stdin.write(`${oneLine}\n`);
    },
    async onApprove(actionId: string) {
      onIgnored("approve", actionId);
    },
    async onReject(actionId: string) {
      onIgnored("reject", actionId);
    },
    async onKill() {
      ref.current?.kill("SIGTERM");
    },
  };
}

export interface SpawnVendorBridgedOptions {
  cwd?: string;
  /** Registered with the relay as the session label (e.g. the vendor name) —
   * shown to the companion so a founder can tell sessions apart. */
  label?: string;
  /** Constructed by the CALLER — `new RelayBridge(transport, handlers)` where
   * `handlers` came from `makeSpawnBridgeHandlers(childRef)` using the SAME
   * `childRef` passed below (see ChildRef's doc comment for why the split). */
  bridge: RelayBridge;
  childRef: ChildRef;
  /** Injectable for tests; defaults to a real `child_process.spawn` with
   * `stdio:"pipe"` (required for the TEE — unlike spawnVendor's "inherit"). */
  spawnImpl?: SpawnImplBridged;
}

/**
 * Spawn the resolved binary in OPT-IN piped mode (`braavo spawn --bridge`).
 * stdout/stderr are TEE'd to BOTH the terminal (`process.stdout`/`stderr` —
 * the user still sees everything live, unchanged from the default) AND the
 * relay bridge (`bridge.emitOutput`, pattern-redacted and bounded — see
 * relay-protocol.ts). This piped mode does not forward local stdin or provide
 * a PTY; only a companion `steer` writes into child stdin (see
 * makeSpawnBridgeHandlers). Interactive local vendor prompts remain unverified.
 *
 * A relay outage must never block or kill the user's vendor CLI session —
 * matches every other best-effort-mirror boundary in this feature
 * (relay-bridge.ts, relay-transport.ts): `bridge.start()`/`setStatus()`
 * failures are caught and logged, never thrown, and the child keeps running
 * companion-less rather than not running at all. Registration happens
 * CONCURRENTLY with spawning the child (not awaited beforehand) so a slow or
 * unreachable relay cannot delay launching the vendor CLI itself — the
 * bridge invalidates a pending registration if the child exits first. A late
 * registration mirrors "ended" without opening a command subscription.
 */
export function spawnVendorBridged(
  binPath: string,
  args: string[],
  o: SpawnVendorBridgedOptions,
): Promise<number> {
  const spawnImpl = o.spawnImpl ?? (nodeSpawn as unknown as SpawnImplBridged);
  const cwd = o.cwd ?? process.cwd();
  const { bridge, childRef } = o;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(binPath, args, { stdio: "pipe", cwd });
    childRef.current = child;

    // Each stream gets its OWN StringDecoder so a multibyte UTF-8 char split
    // across chunk boundaries isn't corrupted (the decoder holds the partial
    // bytes until the rest arrives) — the relay mirror and its redaction always
    // see complete text. The terminal gets the RAW chunk (perfect fidelity,
    // byte-for-byte the same as the default passthrough).
    const tee = (out: NodeJS.WritableStream) => {
      const decoder = new StringDecoder("utf8");
      return (chunk: Buffer | string) => {
        out.write(chunk);
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (text) void bridge.emitOutput(text);
      };
    };
    child.stdout.on("data", tee(process.stdout));
    child.stderr.on("data", tee(process.stderr));

    void (async () => {
      try {
        await bridge.start({ surface: "cli", label: o.label, cwd });
        await bridge.setStatus("running");
      } catch {
        // Best-effort mirror — see the doc comment above. The vendor CLI
        // keeps running whether or not the companion relay is reachable.
        process.stderr.write("· companion relay unreachable — spawn continues without it\n");
      }
    })();

    child.on("error", (err) => {
      childRef.current = null; // a late steer/kill must not touch a dead child
      void bridge.stop().catch(() => {});
      reject(err);
    });
    // A signal-terminated child has code === null; surface that as non-zero,
    // matching spawnVendor. bridge.stop() itself unsubscribes immediately and
    // mirrors status:"ended" (see relay-bridge.ts) — no separate setStatus
    // call is needed here.
    child.on("exit", (code) => {
      childRef.current = null; // a late steer/kill must not touch a dead child
      void (async () => {
        try {
          await bridge.stop();
        } finally {
          resolve(code === null ? 1 : code);
        }
      })();
    });
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

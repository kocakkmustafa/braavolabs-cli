import { describe, it, expect, vi, afterEach } from "vitest";
import {
  makeChildRef,
  makeSpawnBridgeHandlers,
  spawnVendorBridged,
  type BridgedChildLike,
  type SpawnImplBridged,
} from "../spawn";
import { RelayBridge, type RelayTransport } from "../relay-bridge";
import type { SessionEventInput, SessionRegistration } from "../relay-protocol";

const SECRET_KEY = "sk-ant-SUPERSECRET0123456789abcdef0123456789";

/** In-memory fake transport — same shape as relay-bridge.test.ts's helper
 * (kept local/self-contained, matching this test suite's existing style). */
function fakeTransport(sessionId = "sess_bridge_1") {
  const registerCalls: SessionRegistration[] = [];
  const postCalls: SessionEventInput[] = [];
  let onCmd: ((raw: unknown) => void) | null = null;
  let unsubscribed = false;

  const transport: RelayTransport = {
    async register(reg) {
      registerCalls.push(reg);
      return { sessionId };
    },
    async postEvent(_sessionId, ev) {
      postCalls.push(ev);
    },
    subscribeCommands(_sessionId, cb) {
      onCmd = cb;
      return () => {
        unsubscribed = true;
      };
    },
  };

  return {
    transport,
    registerCalls,
    postCalls,
    emitCmd: (raw: unknown) => onCmd?.(raw),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

/** Fake piped child: stdout/stderr `data` emitters, an stdin write sink, a
 * kill-signal recorder, and error/exit emitters — drives BridgedChildLike
 * headlessly, no real process. */
function fakeBridgedChild() {
  const stdoutCbs: Array<(chunk: Buffer | string) => void> = [];
  const stderrCbs: Array<(chunk: Buffer | string) => void> = [];
  const errorCbs: Array<(err: Error) => void> = [];
  const exitCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const stdinWrites: string[] = [];
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];

  const child: BridgedChildLike = {
    stdout: { on: (ev, cb) => { if (ev === "data") stdoutCbs.push(cb); } },
    stderr: { on: (ev, cb) => { if (ev === "data") stderrCbs.push(cb); } },
    stdin: { write: (data: string) => { stdinWrites.push(data); } },
    on: (ev: "error" | "exit", cb: any) => {
      if (ev === "error") errorCbs.push(cb);
      else exitCbs.push(cb);
    },
    kill: (signal) => { killSignals.push(signal); },
  };

  return {
    child,
    emitStdout: (chunk: string) => stdoutCbs.forEach((cb) => cb(chunk)),
    emitStderr: (chunk: string) => stderrCbs.forEach((cb) => cb(chunk)),
    emitExit: (code: number | null, signal: NodeJS.Signals | null = null) => exitCbs.forEach((cb) => cb(code, signal)),
    emitError: (err: Error) => errorCbs.forEach((cb) => cb(err)),
    stdinWrites,
    killSignals,
  };
}

/** Build a (bridge, transport-hooks, childRef) triple wired the same way
 * braavo.ts's `spawn --bridge` production code wires them. */
function setup(onIgnored?: (kind: "approve" | "reject", actionId: string) => void) {
  const fakeT = fakeTransport();
  const childRef = makeChildRef();
  const handlers = makeSpawnBridgeHandlers(childRef, onIgnored ?? (() => {}));
  const bridge = new RelayBridge(fakeT.transport, handlers);
  return { fakeT, childRef, bridge };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Typed loosely — vi.spyOn's overload resolution for process.stdout.write's
// multi-signature type doesn't narrow cleanly across a hoisted `let`; the
// runtime behavior (mock + restore) is all these tests need.
let stdoutSpy: any;
let stderrSpy: any;
afterEach(() => {
  stdoutSpy?.mockRestore();
  stderrSpy?.mockRestore();
});

describe("spawnVendorBridged — TEE (terminal + relay, both directions)", () => {
  it("stdout/stderr chunks go to BOTH process.stdout/stderr AND bridge.emitOutput", async () => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { fakeT, childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const spawnImpl: SpawnImplBridged = () => fake.child;

    const p = spawnVendorBridged("/bin/claude", ["-p", "hi"], { cwd: "/work", bridge, childRef, label: "claude", spawnImpl });
    expect(childRef.current).toBe(fake.child); // filled synchronously, before any command can arrive
    await tick(); // let bridge.start() land (see the "early output" gap test below)

    fake.emitStdout("hello from vendor stdout\n");
    fake.emitStderr("a warning on stderr\n");
    await tick();

    expect(stdoutSpy).toHaveBeenCalledWith("hello from vendor stdout\n");
    expect(stderrSpy).toHaveBeenCalledWith("a warning on stderr\n");

    const outputs = fakeT.postCalls.filter((e) => e.type === "output");
    expect(outputs).toHaveLength(2);
    const decoded = outputs.map((e) => (e.type === "output" ? Buffer.from(e.textB64, "base64").toString("utf8") : ""));
    expect(decoded).toEqual(["hello from vendor stdout\n", "a warning on stderr\n"]);

    fake.emitExit(0);
    expect(await p).toBe(0);
  });

  it("emitOutput applies client-side redaction to a secret in vendor output", async () => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { fakeT, childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick(); // let bridge.start() land

    fake.emitStdout(`using key ${SECRET_KEY} to authenticate\n`);
    await tick();

    // The TERMINAL still gets the raw, unredacted text (braavo never alters
    // what the user sees in their own terminal) — only the relay mirror is redacted.
    expect(stdoutSpy).toHaveBeenCalledWith(`using key ${SECRET_KEY} to authenticate\n`);

    const outputs = fakeT.postCalls.filter((e) => e.type === "output");
    expect(outputs).toHaveLength(1);
    const ev = outputs[0];
    if (ev.type !== "output") throw new Error("unreachable");
    const decoded = Buffer.from(ev.textB64, "base64").toString("utf8");
    expect(decoded).not.toContain(SECRET_KEY);
    expect(decoded).toContain("«redacted»");

    fake.emitExit(0);
    await p;
  });

  it("KNOWN GAP: output emitted before registration lands is silently dropped, not queued", async () => {
    // RelayBridge.post() no-ops until this.sessionId is set (see relay-bridge.ts,
    // "emit* no-ops before start()") — a deliberate, already-tested contract on
    // the ported core. The consequence for spawn --bridge specifically: a vendor
    // CLI that prints instantly (before the register() round-trip lands) has
    // that FIRST burst of output silently un-mirrored to the companion — it is
    // never buffered/replayed once the session id arrives. Terminal output is
    // unaffected (the TEE writes to the terminal unconditionally); only the
    // companion mirror loses this window. Documented here rather than "fixed"
    // silently, matching this feature's own stated policy of surfacing known
    // gaps instead of papering over them (see relay-transport.ts's header).
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { fakeT, childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });

    // Emitted BEFORE the register() microtask has had a chance to resolve.
    fake.emitStdout("instant output before the relay round-trip lands\n");
    await tick(); // now bridge.start() has landed

    expect(fakeT.postCalls.filter((e) => e.type === "output")).toEqual([]);

    fake.emitExit(0);
    await p;
  });
});

describe("spawnVendorBridged — session lifecycle", () => {
  it("registers as surface:cli with the given label/cwd, then mirrors running → ended", async () => {
    const { fakeT, childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/codex", [], { cwd: "/projects/x", label: "codex", bridge, childRef, spawnImpl: () => fake.child });
    await tick();

    expect(fakeT.registerCalls).toEqual([{ surface: "cli", label: "codex", cwd: "/projects/x" }]);
    expect(fakeT.postCalls).toContainEqual({ type: "status", state: "running" });

    fake.emitExit(0);
    expect(await p).toBe(0);
    expect(fakeT.postCalls).toContainEqual({ type: "status", state: "ended" });
    expect(fakeT.unsubscribed).toBe(true);
  });

  it("a relay that never resolves register() does not block the vendor CLI — child still runs and exits normally", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const childRef = makeChildRef();
    const handlers = makeSpawnBridgeHandlers(childRef);
    const neverTransport: RelayTransport = {
      register: () => new Promise(() => {}), // hangs forever
      async postEvent() {},
      subscribeCommands: () => () => {},
    };
    const bridge = new RelayBridge(neverTransport, handlers);
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick();

    fake.emitExit(0);
    expect(await p).toBe(0); // the child's own exit code, unaffected by the stuck relay
  });

  it("owns the child's exit code verbatim, including a signal-terminated (null) exit", async () => {
    const { childRef, bridge } = setup();
    for (const [given, expected] of [[0, 0], [2, 2], [137, 137]] as const) {
      const fake = fakeBridgedChild();
      const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
      await tick();
      fake.emitExit(given);
      expect(await p).toBe(expected);
    }
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick();
    fake.emitExit(null, "SIGINT");
    expect(await p).toBe(1);
  });

  it("rejects when the spawn itself errors (binary vanished / not executable)", async () => {
    const { childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    fake.emitError(new Error("ENOENT"));
    await expect(p).rejects.toThrow("ENOENT");
  });
});

describe("spawnVendorBridged — companion command wiring (via makeSpawnBridgeHandlers)", () => {
  it("a steer command writes newline-terminated straight into the child's stdin", async () => {
    const { fakeT, childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick(); // let bridge.start() finish subscribing before a command arrives

    fakeT.emitCmd({ type: "steer", message: "check the failing test" });
    await tick();
    expect(fake.stdinWrites).toEqual(["check the failing test\n"]);

    fake.emitExit(0);
    await p;
  });

  it("a kill command SIGTERMs the child", async () => {
    const { fakeT, childRef, bridge } = setup();
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick();

    fakeT.emitCmd({ type: "kill" });
    await tick();
    expect(fake.killSignals).toEqual(["SIGTERM"]);

    fake.emitExit(null, "SIGTERM");
    await p;
  });

  it("approve/reject commands are a LOGGED no-op — braavo spawn has no local gate", async () => {
    const ignored: Array<["approve" | "reject", string]> = [];
    const { fakeT, childRef, bridge } = setup((kind, actionId) => ignored.push([kind, actionId]));
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick();

    fakeT.emitCmd({ type: "approve", actionId: "act_1" });
    fakeT.emitCmd({ type: "reject", actionId: "act_2" });
    await tick();

    expect(ignored).toEqual([
      ["approve", "act_1"],
      ["reject", "act_2"],
    ]);
    // Neither command touches the child at all (no stdin write, no kill).
    expect(fake.stdinWrites).toEqual([]);
    expect(fake.killSignals).toEqual([]);

    fake.emitExit(0);
    await p;
  });

  it("default onIgnored logs a steel note to stderr naming the kind and actionId", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const childRef = makeChildRef();
    const handlers = makeSpawnBridgeHandlers(childRef); // default onIgnored
    const fakeT = fakeTransport();
    const bridge = new RelayBridge(fakeT.transport, handlers);
    const fake = fakeBridgedChild();
    const p = spawnVendorBridged("/bin/claude", [], { bridge, childRef, spawnImpl: () => fake.child });
    await tick();

    fakeT.emitCmd({ type: "approve", actionId: "act_abc" });
    await tick();

    expect(stderrSpy.mock.calls.some((c: any[]) => String(c[0]).includes("approve") && String(c[0]).includes("act_abc"))).toBe(true);

    fake.emitExit(0);
    await p;
  });
});

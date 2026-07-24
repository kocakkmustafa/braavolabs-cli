import { describe, it, expect } from "vitest";
import { RelayBridge, type BridgeHandlers, type RelayTransport } from "../relay-bridge";
import type { SessionEventInput, SessionRegistration } from "../relay-protocol";

const SECRET_KEY = "sk-ant-SUPERSECRET0123456789abcdef0123456789";

/** In-memory fake transport — captures every call, exposes `emitCmd` so a
 * test can simulate an inbound ControlCommand exactly like the real
 * fetch+SSE transport would hand a parsed payload to `onCmd`. Same shape as
 * the ported Desktop test's helper (relay-bridge.test.ts, sealed). */
export function fakeTransport(sessionId = "sess_1") {
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

export function fakeHandlers(overrides: Partial<BridgeHandlers> = {}): BridgeHandlers & {
  steered: string[];
  approved: string[];
  rejected: string[];
  killed: number;
} {
  const steered: string[] = [];
  const approved: string[] = [];
  const rejected: string[] = [];
  let killed = 0;
  return {
    steered,
    approved,
    rejected,
    get killed() {
      return killed;
    },
    onSteer: overrides.onSteer ?? ((msg) => steered.push(msg)),
    onApprove: overrides.onApprove ?? (async (id) => { approved.push(id); }),
    onReject: overrides.onReject ?? (async (id) => { rejected.push(id); }),
    onKill: overrides.onKill ?? (async () => { killed += 1; }),
  } as any;
}

describe("RelayBridge — register + subscribe", () => {
  it("start() registers with the transport and returns the minted sessionId", async () => {
    const { transport, registerCalls } = fakeTransport("sess_42");
    const bridge = new RelayBridge(transport, fakeHandlers());
    const out = await bridge.start({ surface: "cli", label: "braavo spawn claude" });
    expect(out.sessionId).toBe("sess_42");
    expect(bridge.getSessionId()).toBe("sess_42");
    expect(registerCalls).toEqual([{ surface: "cli", label: "braavo spawn claude" }]);
  });

  it("subscribes to commands for the minted session id", async () => {
    let subscribedFor: string | undefined;
    const transport: RelayTransport = {
      async register() {
        return { sessionId: "sess_9" };
      },
      async postEvent() {},
      subscribeCommands(sessionId, _cb) {
        subscribedFor = sessionId;
        return () => {};
      },
    };
    const bridge = new RelayBridge(transport, fakeHandlers());
    await bridge.start({ surface: "cli" });
    expect(subscribedFor).toBe("sess_9");
  });

  it("stop() mirrors status:ended then unsubscribes; no-ops if never started", async () => {
    const fake = fakeTransport();
    const bridge = new RelayBridge(fake.transport, fakeHandlers());

    // never started — stop() must not throw or post anything
    await bridge.stop();
    expect(fake.postCalls).toEqual([]);

    await bridge.start({ surface: "cli" });
    expect(fake.unsubscribed).toBe(false);
    await bridge.stop();
    expect(fake.postCalls).toEqual([{ type: "status", state: "ended" }]);
    expect(fake.unsubscribed).toBe(true);
    expect(bridge.getSessionId()).toBeNull();
  });
});

describe("RelayBridge — emit* applies client-side redaction", () => {
  it("emitAudit / emitAgentTurn / emitApprovalRequest never post a raw secret", async () => {
    const { transport, postCalls } = fakeTransport();
    const bridge = new RelayBridge(transport, fakeHandlers());
    await bridge.start({ surface: "cli" });

    await bridge.emitAudit(`granted access with ${SECRET_KEY}`);
    await bridge.emitAgentTurn(`used key ${SECRET_KEY} to fetch data`);
    await bridge.emitApprovalRequest("act_1", "command.run", `run with ${SECRET_KEY}?`);

    for (const ev of postCalls) {
      expect(JSON.stringify(ev)).not.toContain(SECRET_KEY);
    }
  });

  it("emitOutput base64-encodes AND redacts the decoded text (the spawn --bridge TEE path)", async () => {
    const { transport, postCalls } = fakeTransport();
    const bridge = new RelayBridge(transport, fakeHandlers());
    await bridge.start({ surface: "cli" });

    await bridge.emitOutput(`stdout: key=${SECRET_KEY}`);
    expect(postCalls).toHaveLength(1);
    const ev = postCalls[0];
    if (ev.type !== "output") throw new Error("unreachable");
    const decoded = Buffer.from(ev.textB64, "base64").toString("utf8");
    expect(decoded).not.toContain(SECRET_KEY);
    expect(decoded).toContain("«redacted»");
  });

  it("emit* no-ops before start() (no sessionId yet) — never throws", async () => {
    const { transport, postCalls } = fakeTransport();
    const bridge = new RelayBridge(transport, fakeHandlers());
    await expect(bridge.emitAudit("too early")).resolves.toBeUndefined();
    expect(postCalls).toEqual([]);
  });

  it("a postEvent failure is swallowed — never breaks the local caller", async () => {
    const transport: RelayTransport = {
      async register() {
        return { sessionId: "sess_1" };
      },
      async postEvent() {
        throw new Error("network down");
      },
      subscribeCommands() {
        return () => {};
      },
    };
    const bridge = new RelayBridge(transport, fakeHandlers());
    await bridge.start({ surface: "cli" });
    await expect(bridge.emitAudit("hello")).resolves.toBeUndefined();
  });
});

describe("RelayBridge — inbound command dispatch", () => {
  it("routes steer/approve/reject/kill to the matching handler", async () => {
    const { transport, emitCmd } = fakeTransport();
    const handlers = fakeHandlers();
    const bridge = new RelayBridge(transport, handlers);
    await bridge.start({ surface: "cli" });

    emitCmd({ type: "steer", message: "go check the logs" });
    emitCmd({ type: "approve", actionId: "act_1" });
    emitCmd({ type: "reject", actionId: "act_2" });
    emitCmd({ type: "kill" });

    // approve/reject/kill are async — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(handlers.steered).toEqual(["go check the logs"]);
    expect(handlers.approved).toEqual(["act_1"]);
    expect(handlers.rejected).toEqual(["act_2"]);
    expect(handlers.killed).toBe(1);
  });

  it("ignores an unknown/malformed command — never throws, no handler fires", async () => {
    const { transport, emitCmd } = fakeTransport();
    const handlers = fakeHandlers();
    const bridge = new RelayBridge(transport, handlers);
    await bridge.start({ surface: "cli" });

    expect(() => emitCmd({ type: "teleport", coords: [1, 2] })).not.toThrow();
    expect(() => emitCmd({ type: "steer" /* missing message */ })).not.toThrow();
    expect(() => emitCmd(null)).not.toThrow();
    expect(() => emitCmd("just a string")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(handlers.steered).toEqual([]);
    expect(handlers.approved).toEqual([]);
    expect(handlers.rejected).toEqual([]);
    expect(handlers.killed).toBe(0);
  });

  it("a handler that throws does not kill the bridge — the NEXT command still dispatches", async () => {
    const { transport, emitCmd } = fakeTransport();
    const steered: string[] = [];
    const handlers = fakeHandlers({
      onSteer: () => {
        throw new Error("boom — steer handler exploded");
      },
    });
    const bridge = new RelayBridge(transport, handlers);
    await bridge.start({ surface: "cli" });

    expect(() => emitCmd({ type: "steer", message: "first (throws)" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    // bridge is still alive — a second, unrelated command still dispatches.
    emitCmd({ type: "kill" });
    await new Promise((r) => setTimeout(r, 0));
    expect(handlers.killed).toBe(1);
    void steered;
  });

  it("an onApprove/onReject rejection is swallowed too (async handler path)", async () => {
    const { transport, emitCmd } = fakeTransport();
    const handlers = fakeHandlers({
      onApprove: async () => {
        throw new Error("handler unreachable — CLI has no approval gate");
      },
    });
    const bridge = new RelayBridge(transport, handlers);
    await bridge.start({ surface: "cli" });

    expect(() => emitCmd({ type: "approve", actionId: "act_x" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    emitCmd({ type: "kill" });
    await new Promise((r) => setTimeout(r, 0));
    expect(handlers.killed).toBe(1);
  });
});

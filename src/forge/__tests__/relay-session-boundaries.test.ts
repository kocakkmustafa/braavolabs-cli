import { describe, expect, it, vi } from "vitest";
import { createRelayTransport, splitSseEvents } from "../relay-transport";
import { invalidateSession } from "../client";
import { clearConfig, loadConfig, saveConfig, type Config } from "../config";
import { RelayBridge, type RelayTransport } from "../relay-bridge";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfgA = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "A-old", refreshToken: "A-refresh" });
const commandFrame = (command: object, seq = 1) =>
  `id: ${seq}\ndata: ${JSON.stringify({ ...command, sessionId: "id", seq, ts: "now" })}\n\n`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function response(status: number, data: unknown, body?: unknown) {
  return { status, ok: status >= 200 && status < 300, statusText: String(status), json: async () => data, body };
}
function controlledBody() {
  let resolve!: (value: { done: boolean; value?: Uint8Array }) => void;
  const read = vi.fn(() => new Promise<{ done: boolean; value?: Uint8Array }>(done => { resolve = done; }));
  const cancel = vi.fn(async () => resolve?.({ done: true }));
  const releaseLock = vi.fn();
  return { body: { getReader: () => ({ read, cancel, releaseLock }) }, read, cancel, releaseLock,
    send: (text: string) => resolve({ done: false, value: new TextEncoder().encode(text) }) };
}

describe("relay command session boundaries", () => {
  it.each([
    { apiUrl: "https://untrusted.example.invalid/api/v1" },
    { apiUrl: "http://untrusted.example.invalid/api/v1", allowCustomHost: true },
  ])("does not send a bearer credential to an unsafe host $apiUrl", async override => {
    const wire = controlledBody(); const fetchImpl = vi.fn(async () => response(200, {}, wire.body));
    const received = vi.fn();
    const unsubscribe = createRelayTransport({ cfg: { ...cfgA(), ...override }, fetchImpl }).subscribeCommands("id", received);
    await tick(); unsubscribe();
    expect(fetchImpl).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])("does not follow HTTP %s or consume a redirect command stream", async status => {
    const wire = controlledBody(); const fetchImpl = vi.fn(async (_url: string, _init: any) => response(status, {}, wire.body));
    const received = vi.fn();
    const unsubscribe = createRelayTransport({ cfg: cfgA(), fetchImpl }).subscribeCommands("id", received);
    await tick(); unsubscribe();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(wire.read).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])("rejects HTTP %s even when its body contains valid commands", async status => {
    const wire = controlledBody(); const fetchImpl = vi.fn(async () => response(status, { error: "denied" }, wire.body));
    const cfg = { ...cfgA(), refreshToken: undefined }; const received = vi.fn();
    const unsubscribe = createRelayTransport({ cfg, fetchImpl }).subscribeCommands("id", received);
    await tick(); unsubscribe();
    expect(wire.read).not.toHaveBeenCalled(); expect(received).not.toHaveBeenCalled();
  });

  it("refreshes once before opening the stream and keeps that rotated session alive", async () => {
    const cfg = cfgA(); const wire = controlledBody(); const received = vi.fn(); const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init: any) => url.endsWith("/auth/refresh")
      ? response(200, { token: "A-new", refreshToken: "A-refresh-new" })
      : init.headers.Authorization === "Bearer A-new" ? response(200, {}, wire.body) : response(401, {}));
    const unsubscribe = createRelayTransport({ cfg, fetchImpl, save }).subscribeCommands("id", received);
    await tick();
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(save).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ redirect: "manual", headers: { Authorization: "Bearer A-new", Accept: "text/event-stream" } });
    wire.send(commandFrame({ type: "steer", message: "after refresh" })); await tick();
    expect(received).toHaveBeenCalledExactlyOnceWith({ type: "steer", message: "after refresh" });
    unsubscribe(); wire.send(""); await tick();
    expect(wire.cancel).toHaveBeenCalledOnce(); expect(wire.releaseLock).toHaveBeenCalledOnce();
  });

  it.each(["unsubscribe", "logout", "account", "api", "same-pair-restored"])("discards a pending read after %s", async transition => {
    const cfg = cfgA(); const wire = controlledBody(); const received = vi.fn();
    const unsubscribe = createRelayTransport({ cfg, fetchImpl: async () => response(200, {}, wire.body) }).subscribeCommands("id", received);
    await tick(); expect(wire.read).toHaveBeenCalledOnce();
    if (transition === "unsubscribe") unsubscribe();
    if (transition === "logout") { invalidateSession(cfg); cfg.token = undefined; cfg.refreshToken = undefined; }
    if (transition === "account") { cfg.token = "B-token"; cfg.refreshToken = "B-refresh"; }
    if (transition === "api") cfg.apiUrl = "https://api.braavolabs.com/api/v2";
    if (transition === "same-pair-restored") invalidateSession(cfg);
    wire.send(commandFrame({ type: "kill" })); await tick();
    expect(received).not.toHaveBeenCalled(); expect(wire.cancel).toHaveBeenCalledOnce();
    expect(wire.releaseLock).toHaveBeenCalledOnce(); unsubscribe();
  });

  it("stops the remaining commands in a chunk when its first callback unsubscribes", async () => {
    const wire = controlledBody(); const received: unknown[] = [];
    const unsubscribe = createRelayTransport({ cfg: cfgA(), fetchImpl: async () => response(200, {}, wire.body) })
      .subscribeCommands("id", command => { received.push(command); unsubscribe(); });
    await tick(); wire.send(commandFrame({ type: "steer", message: "first" }) + commandFrame({ type: "kill" }, 2)); await tick();
    expect(received).toEqual([{ type: "steer", message: "first" }]);
  });

  it.each(["logout", "replacement"])("blocks a pending command after a separate config writer's %s", async transition => {
    const configPath = join(mkdtempSync(join(tmpdir(), "relay-disk-owner-")), "config.json");
    saveConfig(cfgA(), configPath); const cfg = loadConfig(configPath);
    const wire = controlledBody(); const received = vi.fn();
    const unsubscribe = createRelayTransport({ cfg, fetchImpl: async () => response(200, {}, wire.body) }).subscribeCommands("id", received);
    await tick(); expect(wire.read).toHaveBeenCalledOnce();
    if (transition === "logout") clearConfig(configPath);
    else saveConfig({ ...cfgA(), token: "B-token", refreshToken: "B-refresh" }, configPath);
    expect(cfg.token).toBe("A-old"); // The old process's object was never modified.
    wire.send(commandFrame({ type: "kill" })); await tick();
    expect(received).not.toHaveBeenCalled(); expect(wire.cancel).toHaveBeenCalledOnce(); unsubscribe();
  });

  it("reassembles CRLF frames split between carriage return and newline", () => {
    const first = splitSseEvents('data: {"type":"kill"}\r');
    expect(first.events).toEqual([]);
    expect(splitSseEvents(first.rest + '\n\r\n')).toEqual({ events: ['data: {"type":"kill"}'], rest: "" });
  });

  it.each([{}, { sessionId: null }, { sessionId: 17 }, { sessionId: "  " }])("refuses invalid successful registration %#", async value => {
    const transport = createRelayTransport({ cfg: cfgA(), fetchImpl: async () => response(201, value) });
    await expect(transport.register({ surface: "cli" })).rejects.toMatchObject({ name: "ApiError", status: 502 });
  });
});

describe("bridge registration and shutdown ownership", () => {
  function handlers() {
    return { onSteer: vi.fn(), onApprove: vi.fn(async () => {}), onReject: vi.fn(async () => {}), onKill: vi.fn(async () => {}) };
  }
  it("does not subscribe after a child stops while registration is pending", async () => {
    let registered!: (value: { sessionId: string }) => void;
    const transport: RelayTransport = { register: () => new Promise(resolve => { registered = resolve; }),
      postEvent: vi.fn(async () => {}), subscribeCommands: vi.fn(() => () => {}) };
    const bridge = new RelayBridge(transport, handlers());
    const start = bridge.start({ surface: "cli" }); await bridge.stop(); registered({ sessionId: "late" }); await start;
    expect(transport.subscribeCommands).not.toHaveBeenCalled(); expect(bridge.getSessionId()).toBeNull();
    expect(transport.postEvent).toHaveBeenCalledExactlyOnceWith("late", { type: "status", state: "ended" });
  });

  it("blocks old callbacks before a slow end-status post finishes", async () => {
    let onCmd!: (value: unknown) => void; let posted!: () => void;
    const unsubscribe = vi.fn(); const actions = handlers();
    const transport: RelayTransport = { register: async () => ({ sessionId: "active" }),
      postEvent: () => new Promise(resolve => { posted = resolve; }),
      subscribeCommands: (_id, callback) => { onCmd = callback; return unsubscribe; } };
    const bridge = new RelayBridge(transport, actions); await bridge.start({ surface: "cli" });
    const end = bridge.stop(); onCmd({ type: "kill" }); onCmd({ type: "steer", message: "late" });
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(bridge.getSessionId()).toBeNull();
    expect(actions.onKill).not.toHaveBeenCalled(); expect(actions.onSteer).not.toHaveBeenCalled(); posted(); await end;
  });

  it("does not let a stale registration replace a subsequent session", async () => {
    let registered!: (value: { sessionId: string }) => void; const callbacks: ((value: unknown) => void)[] = [];
    const transport: RelayTransport = {
      register: vi.fn().mockImplementationOnce(() => new Promise(resolve => { registered = resolve; })).mockResolvedValue({ sessionId: "new" }),
      postEvent: vi.fn(async () => {}), subscribeCommands: vi.fn((_id, callback) => { callbacks.push(callback); return () => {}; }),
    };
    const actions = handlers(); const bridge = new RelayBridge(transport, actions);
    const old = bridge.start({ surface: "cli" }); await bridge.stop(); await bridge.start({ surface: "cli" });
    registered({ sessionId: "old" }); await old;
    expect(bridge.getSessionId()).toBe("new"); expect(transport.subscribeCommands).toHaveBeenCalledOnce();
    callbacks[0]({ type: "steer", message: "current" }); expect(actions.onSteer).toHaveBeenCalledExactlyOnceWith("current");
    await bridge.stop();
  });
});

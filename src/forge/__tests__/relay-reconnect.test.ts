import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayTransport } from "../relay-transport";
import { invalidateSession } from "../client";
import { clearConfig, loadConfig, saveConfig, type Config } from "../config";
import { RelayBridge } from "../relay-bridge";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfgA = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "A-old", refreshToken: "A-refresh" });
const response = (status: number, body?: unknown, data: unknown = {}) => ({
  status, ok: status >= 200 && status < 300, statusText: String(status), body, json: async () => data,
});
const frame = (seq: number, command: unknown = { type: "steer", message: `step ${seq}` }, sessionId = "session") =>
  `id: ${seq}\ndata: ${JSON.stringify({ ...(command as object), sessionId, seq, ts: "2026-10-12T00:00:00Z" })}\n\n`;

function stream(chunks: string[], ending: "eof" | "drop" | "wait" = "wait") {
  let index = 0;
  let finish: ((value: { done: boolean }) => void) | undefined;
  const cancel = vi.fn(async () => finish?.({ done: true }));
  const releaseLock = vi.fn();
  return { cancel, releaseLock, getReader: () => ({ cancel, releaseLock,
    read: async () => {
      if (index < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[index++]) };
      if (ending === "drop") throw new TypeError("connection reset");
      if (ending === "eof") return { done: true };
      return new Promise<{ done: boolean }>(resolve => { finish = resolve; });
    },
  }) };
}

describe("relay reconnect, replay and dedup against the server envelope", () => {
  const stops: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  function subscribe(cfg: Config, fetchImpl: any, receive = vi.fn(), save = vi.fn()) {
    const stop = createRelayTransport({ cfg, fetchImpl, save }).subscribeCommands("session", receive);
    stops.push(stop);
    return { stop, receive, save };
  }

  it.each(["eof", "drop"] as const)("resumes after %s and dispatches replayed commands only once", async ending => {
    const first = stream([frame(1), frame(2)], ending);
    const second = stream([frame(2), frame(3)]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, first)).mockResolvedValue(response(200, second));
    const { receive } = subscribe(cfgA(), fetchImpl);
    await flush();
    expect(receive.mock.calls.map(([command]) => command.message)).toEqual(["step 1", "step 2"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://braavolabs.com/api/v1/relay/sessions/session/commands?lastEventId=2");
    expect(receive.mock.calls.map(([command]) => command.message)).toEqual(["step 1", "step 2", "step 3"]);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.releaseLock).toHaveBeenCalledOnce();
  });

  it("keeps identical text with different sequence numbers while suppressing duplicates and stale frames", async () => {
    const command = { type: "steer", message: "same text" };
    const fetchImpl = vi.fn(async () => response(200, stream([frame(1, command), frame(1, command), frame(2, command), frame(1, command)])));
    const { receive } = subscribe(cfgA(), fetchImpl); await flush();
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenNthCalledWith(1, command);
    expect(receive).toHaveBeenNthCalledWith(2, command);
  });

  it("does not advance the cursor on malformed, mismatched or unsequenced commands", async () => {
    const first = stream([
      'id: 999\ndata: {broken\n\n', frame(999, { type: "steer", message: "wrong session" }, "other"),
      frame(999, { type: "unknown" }), frame(999).replace('"seq":999', '"seq":1000'),
      frame(999).replace('"seq":999', '"seq":"999"'),
      'data: {"type":"kill"}\n\n', frame(1),
    ], "eof");
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, first)).mockResolvedValue(response(200, stream([])));
    const { receive } = subscribe(cfgA(), fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "steer", message: "step 1" });
    expect(fetchImpl.mock.calls[1][0]).toContain("lastEventId=1");
  });

  it("discards a partial frame at disconnect and replays the full command", async () => {
    const first = stream([frame(1), frame(2).slice(0, -4)], "drop");
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, first)).mockResolvedValue(response(200, stream([frame(2)])));
    const { receive } = subscribe(cfgA(), fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(receive.mock.calls.map(([command]) => command.message)).toEqual(["step 1", "step 2"]);
    expect(fetchImpl.mock.calls[1][0]).toContain("lastEventId=1");
  });

  it.each(["event: done\n\n", "event: done\ndata: {}\n\n"])("stops permanently on the terminal marker %j", async marker => {
    const body = stream([frame(1), marker, frame(2)], "eof");
    const fetchImpl = vi.fn(async () => response(200, body));
    const { receive } = subscribe(cfgA(), fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "steer", message: "step 1" });
    expect(body.cancel).toHaveBeenCalledOnce(); expect(body.releaseLock).toHaveBeenCalledOnce();
  });

  it.each(["unsubscribe", "logout", "account", "api", "same-pair-restored"])("does not reconnect after %s during backoff", async transition => {
    const cfg = cfgA(); const fetchImpl = vi.fn(async () => response(200, stream([], "eof")));
    const { stop, receive } = subscribe(cfg, fetchImpl); await flush();
    if (transition === "unsubscribe") stop();
    if (transition === "logout") { invalidateSession(cfg); cfg.token = undefined; cfg.refreshToken = undefined; }
    if (transition === "account") { cfg.token = "B-token"; cfg.refreshToken = "B-refresh"; }
    if (transition === "api") cfg.apiUrl = "https://api.braavolabs.com/api/v2";
    if (transition === "same-pair-restored") invalidateSession(cfg);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(receive).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 410])("stops after permanent HTTP %s", async status => {
    const cfg = { ...cfgA(), refreshToken: undefined };
    const fetchImpl = vi.fn(async () => response(status)); subscribe(cfg, fetchImpl);
    await flush(); await vi.advanceTimersByTimeAsync(30_000); expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([408, 429, 503, "network"])("backs off and retries transient %s", async status => {
    const fetchImpl = vi.fn();
    if (status === "network") fetchImpl.mockRejectedValueOnce(new TypeError("offline"));
    else fetchImpl.mockResolvedValueOnce(response(status as number));
    fetchImpl.mockResolvedValue(response(200, stream([frame(1)])));
    const { receive } = subscribe(cfgA(), fetchImpl); await flush();
    await vi.advanceTimersByTimeAsync(499); expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenCalledOnce();
  });

  it("bounds backoff instead of spinning on repeated EOF", async () => {
    const fetchImpl = vi.fn(async () => response(200, stream([], "eof"))); subscribe(cfgA(), fetchImpl);
    await flush(); await vi.advanceTimersByTimeAsync(499); expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000); expect(fetchImpl).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(9_999); expect(fetchImpl).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("refreshes once on reconnect and preserves the delivered cursor", async () => {
    const cfg = cfgA(); let connections = 0;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) return response(200, undefined, { token: "A-new", refreshToken: "A-refresh-new" });
      if (++connections === 1) return response(200, stream([frame(1)], "eof"));
      if (init.headers.Authorization === "Bearer A-old") return response(401);
      return response(200, stream([frame(1), frame(2)]));
    });
    const { receive, save } = subscribe(cfg, fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(4); expect(save).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[3][0]).toContain("lastEventId=1");
    expect(fetchImpl.mock.calls[3][1].headers.Authorization).toBe("Bearer A-new");
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight reconnect and never dispatches its delayed response", async () => {
    let complete!: (value: unknown) => void; let signal!: AbortSignal;
    const second = stream([frame(2)]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, stream([frame(1)], "eof")))
      .mockImplementation((_url, init) => { signal = init.signal; return new Promise(resolve => { complete = resolve; }); });
    const { stop, receive } = subscribe(cfgA(), fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(500);
    stop(); expect(signal.aborted).toBe(true); complete(response(200, second)); await flush();
    expect(receive).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not replay a command when its callback throws after taking effect", async () => {
    const first = stream([frame(1)], "drop"); const receive = vi.fn(() => { throw new Error("callback failed"); });
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, first)).mockResolvedValue(response(200, stream([frame(1), frame(2)])));
    subscribe(cfgA(), fetchImpl, receive); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(receive).toHaveBeenCalledTimes(2); expect(fetchImpl.mock.calls[1][0]).toContain("lastEventId=1");
  });

  it("does not reconnect when a separate process clears the disk owner during backoff", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-reconnect-owner-"));
    try {
      const configPath = join(directory, "config.json"); saveConfig(cfgA(), configPath);
      const cfg = loadConfig(configPath);
      const fetchImpl = vi.fn(async () => response(200, stream([], "eof")));
      subscribe(cfg, fetchImpl); await flush(); clearConfig(configPath);
      expect(cfg.token).toBe("A-old"); await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["unsubscribe", "logout"])("does not replay or dispatch after %s during a shared reconnect refresh", async transition => {
    let complete!: (value: unknown) => void; let connections = 0;
    const cfg = cfgA();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return new Promise(resolve => { complete = resolve; });
      if (++connections === 1) return response(200, stream([frame(1)], "eof"));
      return response(401);
    });
    const { stop, receive, save } = subscribe(cfg, fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    if (transition === "logout") { invalidateSession(cfg); cfg.token = undefined; cfg.refreshToken = undefined; }
    stop();
    complete(response(200, undefined, { token: "A-new", refreshToken: "A-refresh-new" })); await flush();
    // Refresh is shared by requests for this config. Unsubscribe stops this
    // stream's replay, while a still-current owner's rotation may persist.
    if (transition === "logout") { expect(save).not.toHaveBeenCalled(); expect(cfg.token).toBeUndefined(); }
    else { expect(save).toHaveBeenCalledOnce(); expect(cfg.token).toBe("A-new"); }
    expect(receive).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps the encoded session target on reconnect", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(200, stream([frame(1, { type: "kill" }, "a/b c")], "eof")))
      .mockResolvedValue(response(200, stream([])));
    const stop = createRelayTransport({ cfg: cfgA(), fetchImpl }).subscribeCommands("a/b c", vi.fn()); stops.push(stop);
    await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://braavolabs.com/api/v1/relay/sessions/a%2Fb%20c/commands?lastEventId=1");
  });

  it("deduplicates handler side effects through the real bridge across reconnect", async () => {
    let connections = 0; const onSteer = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/relay/sessions")) return response(201, undefined, { sessionId: "session" });
      if (url.endsWith("/events")) return response(202);
      return response(200, ++connections === 1 ? stream([frame(1)], "eof") : stream([frame(1), frame(2)]));
    });
    const bridge = new RelayBridge(createRelayTransport({ cfg: cfgA(), fetchImpl }), {
      onSteer, onApprove: async () => {}, onReject: async () => {}, onKill: async () => {},
    });
    stops.push(() => { void bridge.stop(); });
    await bridge.start({ surface: "cli" }); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(onSteer.mock.calls).toEqual([["step 1"], ["step 2"]]);
    await bridge.stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(connections).toBe(2);
  });

  it.each([408, 429, 500, 503])("recovers a dropped command stream after refresh HTTP %s with its cursor intact", async status => {
    const cfg = cfgA(); let connections = 0, refreshes = 0;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) return ++refreshes === 1 ? response(status)
        : response(200, undefined, { token: "A-new", refreshToken: "A-refresh-new" });
      if (++connections === 1) return response(200, stream([frame(1)], "eof"));
      return init.headers.Authorization === "Bearer A-new"
        ? response(200, stream([frame(1), frame(2)])) : response(401);
    });
    const { receive, save } = subscribe(cfg, fetchImpl); await flush(); await vi.advanceTimersByTimeAsync(500);
    expect(fetchImpl).toHaveBeenCalledTimes(3); expect(save).not.toHaveBeenCalled(); expect(cfg.token).toBe("A-old");
    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "steer", message: "step 1" });
    await vi.advanceTimersByTimeAsync(999); expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(6); expect(refreshes).toBe(2); expect(save).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[5][0]).toContain("lastEventId=1");
    expect(receive.mock.calls.map(([command]) => command.message)).toEqual(["step 1", "step 2"]);
  });

  it("uses backoff for repeated transient refresh failures instead of permanently stopping or spinning", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(url.endsWith("/auth/refresh") ? 503 : 401));
    subscribe(cfgA(), fetchImpl); await flush(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499); expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999); expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(2000); expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it.each(["unsubscribe", "logout", "account", "api"])("does not retry a transient refresh failure after %s", async transition => {
    const cfg = cfgA();
    const fetchImpl = vi.fn(async (url: string) => response(url.endsWith("/auth/refresh") ? 429 : 401));
    const { stop, receive, save } = subscribe(cfg, fetchImpl); await flush();
    if (transition === "logout") { invalidateSession(cfg); cfg.token = undefined; cfg.refreshToken = undefined; }
    if (transition === "account") { cfg.token = "B-token"; cfg.refreshToken = "B-refresh"; }
    if (transition === "api") cfg.apiUrl = "https://api.braavolabs.com/api/v2";
    if (transition === "unsubscribe") stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
  });

});

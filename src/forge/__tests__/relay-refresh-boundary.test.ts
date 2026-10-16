import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, AuthenticationPersistenceError, AuthenticationProtocolError } from "../client";
import { createRelayTransport } from "../relay-transport";

const response = (status: number, data: unknown, body?: unknown) => ({
  status, ok: status >= 200 && status < 300, statusText: String(status), body, json: async () => data,
});
const config = () => ({ apiUrl: "https://braavolabs.com/api/v1", token: "synthetic-old", refreshToken: "synthetic-refresh" });

describe("relay authentication terminal boundaries", () => {
  const stops: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => { for (const stop of stops.splice(0)) stop(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

  it.each([{}, { token: "" }, { token: "synthetic-new", refreshToken: "" }])("stops reconnect after malformed refresh success %j", async data => {
    const cfg = config(); const receive = vi.fn(); const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh") ? response(200, data) : response(401, {}));
    stops.push(createRelayTransport({ cfg, fetchImpl, save }).subscribeCommands("session", receive));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
    expect(cfg).toEqual(config()); expect(vi.getTimerCount()).toBe(0);
  });

  it("stops reconnect after invalid refresh JSON rather than classifying it as a network failure", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? { ...response(200, {}), json: async () => { throw new SyntaxError("synthetic malformed JSON"); } } : response(401, {}));
    stops.push(createRelayTransport({ cfg: config(), fetchImpl, save: vi.fn() }).subscribeCommands("session", vi.fn()));
    await vi.advanceTimersByTimeAsync(30_000); expect(fetchImpl).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a dropped refresh response body while keeping malformed JSON terminal", async () => {
    let refreshes = 0; const cfg = config(); const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) {
        if (++refreshes === 1) return { ...response(200, {}), json: async () => { throw new TypeError("synthetic dropped body"); } };
        return response(200, { token: "synthetic-new", refreshToken: "synthetic-refresh-new" });
      }
      let sent = false;
      return init.headers.Authorization !== "Bearer synthetic-new" ? response(401, {})
        : response(200, {}, { getReader: () => ({
          read: async () => sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode("event: done\n\n") }),
          cancel: async () => {}, releaseLock: () => {},
        }) });
    });
    stops.push(createRelayTransport({ cfg, fetchImpl, save }).subscribeCommands("session", vi.fn()));
    await vi.advanceTimersByTimeAsync(499); expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(fetchImpl).toHaveBeenCalledTimes(5); expect(save).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reconnects with an unpersisted rotated pair after an injected save fails", async () => {
    const cfg = config(); const receive = vi.fn(); const save = vi.fn(() => { throw new Error("synthetic persistence failure"); });
    const fetchImpl = vi.fn(async (url: string, init: any) => url.endsWith("/auth/refresh")
      ? response(200, { token: "synthetic-new", refreshToken: "synthetic-refresh-new" })
      : init.headers.Authorization === "Bearer synthetic-new"
        ? response(200, {}, { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {}, releaseLock: () => {} }) })
        : response(401, {}));
    stops.push(createRelayTransport({ cfg, fetchImpl, save }).subscribeCommands("session", receive));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).toHaveBeenCalledOnce(); expect(receive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exposes terminal protocol errors separately from transient refresh HTTP errors", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(url.endsWith("/auth/refresh") ? 200 : 401, {}));
    await expect(apiFetch("/runs/run", { cfg: config(), fetchImpl, save: vi.fn() })).rejects.toBeInstanceOf(AuthenticationProtocolError);
  });

  it("exposes terminal persistence errors without reflecting a raw storage error in the user message", async () => {
    const fetchImpl = vi.fn(async (url: string) => response(url.endsWith("/auth/refresh") ? 200 : 401, { token: "synthetic-new" }));
    const cause = new Error("synthetic private storage detail");
    const error = await apiFetch("/runs/run", { cfg: config(), fetchImpl, save: () => { throw cause; } }).catch(error => error);
    expect(error).toBeInstanceOf(AuthenticationPersistenceError); expect(error.cause).toBe(cause);
    expect(error.message).toBe("Could not persist refreshed authentication");
  });
});

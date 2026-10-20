import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, pollCompare } from "../client";
import { directChat } from "../direct";
import { ollamaChat } from "../local";
import { runFix } from "../fix";
import type { Config } from "../config";

const cfg = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "synthetic-old", refreshToken: "synthetic-refresh" });
const res = (status: number, data: any) => ({ status, ok: status >= 200 && status < 300, statusText: String(status), json: async () => data });
const forever = () => new Promise<any>(() => {});

describe("whole request and owner-scoped refresh deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("settles a hung header request and aborts its transport", async () => {
    let signal!: AbortSignal;
    const pending = apiFetch("/one", { cfg: cfg(), timeoutMs: 10, fetchImpl: async (_u, init) => { signal = init.signal; return forever(); } }).catch(e => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ name: "RequestTimeoutError" });
    expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("keeps the deadline through successful JSON body parsing (raw=%s)", async raw => {
    const pending = apiFetch("/one", { cfg: cfg(), raw, timeoutMs: 10,
      fetchImpl: async () => ({ ...res(200, {}), json: forever }) }).catch(e => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ name: "RequestTimeoutError" }); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn a stalled error body into a successful raw result", async () => {
    const pending = apiFetch("/one", { cfg: cfg(), raw: true, timeoutMs: 10,
      fetchImpl: async () => ({ ...res(403, {}), json: forever }) }).catch(e => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ name: "RequestTimeoutError" });
  });

  it("one aborted caller leaves a shared refresh usable by another caller without replaying itself", async () => {
    const config = cfg(); const controller = new AbortController(); const save = vi.fn();
    let release!: (r: any) => void; let refreshCalls = 0; const replays: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) { refreshCalls++; return new Promise(resolve => { release = resolve; }); }
      if (init.headers.Authorization === "Bearer synthetic-new") { replays.push(url); return res(200, { ok: true }); }
      return res(401, {});
    });
    const first = apiFetch("/first", { cfg: config, signal: controller.signal, save, fetchImpl }).catch(e => e);
    const second = apiFetch("/second", { cfg: config, save, fetchImpl });
    await vi.advanceTimersByTimeAsync(0); controller.abort(new Error("caller stopped"));
    expect((await first).message).toBe("caller stopped");
    release(res(200, { token: "synthetic-new", refreshToken: "synthetic-next" }));
    expect(await second).toEqual({ ok: true }); expect(refreshCalls).toBe(1);
    expect(replays).toEqual(["https://braavolabs.com/api/v1/second"]); expect(save).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a shared refresh body and ignores its late token bundle", async () => {
    const config = cfg(); const save = vi.fn(); let release!: (r: any) => void; let refreshSignal!: AbortSignal;
    const fetchImpl = vi.fn(async (url: string, init: any) => url.endsWith("/auth/refresh")
      ? (refreshSignal = init.signal, { ...res(200, {}), json: () => new Promise(resolve => { release = resolve; }) }) : res(401, {}));
    const pending = apiFetch("/one", { cfg: config, timeoutMs: 40_000, fetchImpl, save }).catch(e => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ name: "RequestTimeoutError" }); expect(refreshSignal.aborted).toBe(true);
    release({ token: "late-token", refreshToken: "late-refresh" }); await vi.advanceTimersByTimeAsync(0);
    expect(config.token).toBe("synthetic-old"); expect(save).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the original budget for the replay body", async () => {
    const config = cfg(); const save = vi.fn(); let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return res(200, { token: "new", refreshToken: "next" });
      return ++calls === 1 ? res(401, {}) : { ...res(200, {}), json: forever };
    });
    const pending = apiFetch("/one", { cfg: config, timeoutMs: 20, fetchImpl, save }).catch(e => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ name: "RequestTimeoutError" }); expect(calls).toBe(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a healthy SSE reader alive beyond the JSON budget and still propagates caller abort", async () => {
    const controller = new AbortController(); let transportSignal!: AbortSignal;
    const response = await apiFetch("/stream", { cfg: cfg(), stream: true, signal: controller.signal, timeoutMs: 10,
      fetchImpl: async (_url, init) => { transportSignal = init.signal; return { ...res(200, {}), body: { getReader: () => ({ read: forever, cancel: vi.fn(), releaseLock: vi.fn() }) } }; } });
    await vi.advanceTimersByTimeAsync(60_000); expect(transportSignal.aborted).toBe(false);
    const pending = response.body.getReader().read().catch((e: unknown) => e);
    controller.abort(new Error("stream stopped")); expect((await pending).message).toBe("stream stopped");
    expect(transportSignal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a poll across its requests and delays", async () => {
    const fetchImpl = vi.fn(async () => res(200, { status: "RUNNING" }));
    const pending = pollCompare(cfg(), "owned", { fetchImpl, timeoutMs: 25, intervalMs: 10, maxAttempts: Infinity }).catch(e => e);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ status: 408 }); expect(fetchImpl).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["direct", "local"])("bounds %s completion body parsing", async lane => {
    const fetchImpl = async () => ({ ...res(200, {}), json: forever });
    const pending = (lane === "direct"
      ? directChat("openai", "synthetic-key", "model", "question", { fetchImpl, timeoutMs: 10 })
      : ollamaChat("http://localhost:11434", "model", "question", { fetchImpl, timeoutMs: 10 })).catch(e => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ name: "RequestTimeoutError" }); expect(vi.getTimerCount()).toBe(0);
  });
});

it("does not call a model after an incomplete command execution", async () => {
  const ask = vi.fn();
  await expect(runFix("owned-test", { run: () => ({ code: 1, output: "partial", incomplete: true }), ask })).rejects.toThrow("No model was called");
  expect(ask).not.toHaveBeenCalled();
});

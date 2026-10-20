import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelCompare, invalidateSession, pollCompare, pollRun, startCompare } from "../client";
import { clearConfig, loadConfig, saveConfig, type Config } from "../config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "synthetic-A" });
const response = (status: number, body: unknown) => ({
  status, ok: status >= 200 && status < 300, statusText: String(status), json: async () => body,
});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("polling lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("finishes the last polling attempt without an extra delay", async () => {
    const fetchImpl = vi.fn(async () => response(200, { status: "RUNNING" }));
    const outcome = pollCompare(config(), "research", { fetchImpl, intervalMs: 2000, maxAttempts: 1 })
      .catch(error => error);
    await flush();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(await outcome).toMatchObject({ status: 408, message: "Timed out polling research session research" });
  });

  it.each(["account", "api", "same-pair-restored"])("pins the poll owner after %s changes between requests", async change => {
    const cfg = config();
    const fetchImpl = vi.fn(async () => response(200, { status: "RUNNING" }));
    const outcome = pollCompare(cfg, "A-research", { fetchImpl, intervalMs: 1000 }).catch(error => error);
    await flush();
    if (change === "account") cfg.token = "synthetic-B";
    if (change === "api") cfg.apiUrl = "https://api.braavolabs.com/api/v2";
    if (change === "same-pair-restored") invalidateSession(cfg);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toMatchObject({ name: "SessionChangedError" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["logout", "account"])("ends a poll when another CLI process changes its disk owner via %s", async change => {
    const directory = mkdtempSync(join(tmpdir(), "braavo-poll-owner-"));
    try {
      const path = join(directory, "config.json"); saveConfig(config(), path);
      const cfg = loadConfig(path);
      const fetchImpl = vi.fn(async () => response(200, { status: "RUNNING" }));
      const outcome = pollCompare(cfg, "research", { fetchImpl, intervalMs: 1000 }).catch(error => error);
      await flush();
      if (change === "logout") clearConfig(path);
      else saveConfig({ ...config(), token: "synthetic-B" }, path);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await outcome).toMatchObject({ name: "SessionChangedError" });
      expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("suppresses a completed result after another CLI process logs out during the request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "braavo-poll-owner-"));
    try {
      const path = join(directory, "config.json"); saveConfig(config(), path);
      const cfg = loadConfig(path); let complete!: (value: unknown) => void; const onTick = vi.fn();
      const fetchImpl = vi.fn(() => new Promise(resolve => { complete = resolve; }));
      const outcome = pollCompare(cfg, "research", { fetchImpl, onTick }).catch(error => error);
      clearConfig(path); complete(response(200, { status: "COMPLETED" }));
      expect(await outcome).toMatchObject({ name: "SessionChangedError" });
      expect(onTick).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("cancels a waiting poll immediately without sending a remote cancel", async () => {
    const controller = new AbortController(); const reason = new Error("operator stopped waiting");
    const fetchImpl = vi.fn(async () => response(200, { status: "RUNNING" }));
    const outcome = pollCompare(config(), "research", { fetchImpl, signal: controller.signal }).catch(error => error);
    await flush(); expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("forwards AbortSignal to the active request and ignores a delayed result", async () => {
    const controller = new AbortController(); let complete!: (value: unknown) => void;
    const fetchImpl = vi.fn((_url: string, init: any) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Promise(resolve => { complete = resolve; });
    });
    const onTick = vi.fn(); const reason = new Error("cancelled wait");
    const outcome = pollCompare(config(), "a/b c", { fetchImpl, signal: controller.signal, onTick }).catch(error => error);
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    complete(response(200, { status: "COMPLETED" })); await flush();
    expect(onTick).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://braavolabs.com/api/v1/research/a%2Fb%20c", expect.any(Object));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no work for a pre-aborted polling signal", async () => {
    const controller = new AbortController(); controller.abort(new Error("already interrupted"));
    const fetchImpl = vi.fn();
    await expect(pollCompare(config(), "research", { fetchImpl, signal: controller.signal })).rejects.toThrow("already interrupted");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a shared refresh promptly without replaying the cancelled poll", async () => {
    const cfg = { ...config(), refreshToken: "synthetic-refresh" };
    const controller = new AbortController(); let finishRefresh!: (value: unknown) => void;
    const save = vi.fn(); const onTick = vi.fn(); const reason = new Error("stopped");
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? new Promise(resolve => { finishRefresh = resolve; }) : response(401, {}));
    const outcome = pollCompare(cfg, "research", { fetchImpl, save, onTick, signal: controller.signal }).catch(error => error);
    await flush(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    controller.abort(reason); expect(await outcome).toBe(reason);
    finishRefresh(response(200, { token: "synthetic-new", refreshToken: "synthetic-refresh-new" })); await flush();
    expect(save).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onTick).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps its owner through an ordinary authentication rotation", async () => {
    const cfg = { ...config(), refreshToken: "synthetic-refresh" }; let reads = 0;
    const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return response(200, { token: "synthetic-new", refreshToken: "synthetic-refresh-new" });
      return ++reads === 1 ? response(401, {}) : response(200, { status: reads === 2 ? "RUNNING" : "COMPLETED" });
    });
    const pending = pollCompare(cfg, "research", { fetchImpl, save, intervalMs: 1000 });
    await flush(); await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ status: "COMPLETED" });
    expect(save).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])("returns terminal compare status %s without a timer", async status => {
    const fetchImpl = vi.fn(async () => response(200, { id: "research", status }));
    expect(await pollCompare(config(), "research", { fetchImpl })).toEqual({ id: "research", status });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, {}, { status: "" }])("rejects malformed polling result %j immediately", async body => {
    const fetchImpl = vi.fn(async () => response(200, body));
    await expect(pollCompare(config(), "research", { fetchImpl })).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 404, 503])("preserves polling HTTP %s and does not silently replay", async status => {
    const fetchImpl = vi.fn(async () => response(status, { error: "synthetic failure" }));
    await expect(pollCompare(config(), "research", { fetchImpl })).rejects.toMatchObject({ status, message: "synthetic failure" });
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED", "STOPPED"])("watch returns terminal run %s with its encoded target", async status => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://braavolabs.com/api/v1/runs/a%2Fb%20c");
      return response(200, { status });
    });
    expect(await pollRun(config(), "a/b c", { fetchImpl })).toEqual({ status });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("watch preserves progress and stops when its local wait is aborted", async () => {
    const controller = new AbortController(); const onTick = vi.fn();
    const fetchImpl = vi.fn(async () => response(200, { status: "WAITING_APPROVAL" }));
    const pending = pollRun(config(), "run", { fetchImpl, onTick, signal: controller.signal }).catch(error => error);
    await flush(); controller.abort(new Error("stop watching"));
    expect(await pending).toMatchObject({ message: "stop watching" });
    expect(onTick).toHaveBeenCalledExactlyOnceWith("WAITING_APPROVAL", 1);
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("explicit research cancellation", () => {
  it.each(["COMPLETED", "FAILED", "CANCELLED"])("posts an encoded target and preserves actual %s status", async status => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, _init: any) => response(200, { success: true, status }));
    expect(await cancelCompare(config(), "a/b c", { fetchImpl, signal: controller.signal })).toEqual({ success: true, status });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://braavolabs.com/api/v1/research/a%2Fb%20c/cancel", expect.objectContaining({
      method: "POST", body: "{}", signal: expect.any(AbortSignal),
    }));
  });

  it.each([{}, { success: false, status: "CANCELLED" }, { success: true, status: "RUNNING" }])("rejects malformed cancellation result %j", async body => {
    const fetchImpl = vi.fn(async () => response(200, body));
    await expect(cancelCompare(config(), "research", { fetchImpl })).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["start", "cancel"])("local abort leaves %s during a shared refresh without replay", async operation => {
    const cfg = { ...config(), refreshToken: "synthetic-refresh" };
    const controller = new AbortController(); const save = vi.fn(); let complete!: (value: unknown) => void;
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? new Promise(resolve => { complete = resolve; }) : response(401, {}));
    const opts = { fetchImpl, save, signal: controller.signal };
    const result = (operation === "start"
      ? startCompare(cfg, { companyId: "company", query: "synthetic question" }, opts)
      : cancelCompare(cfg, "research", opts)).catch(error => error);
    // This group uses real timers; drain the microtasks that establish refresh.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const reason = new Error("stopped waiting"); controller.abort(reason);
    expect(await result).toBe(reason);
    complete(response(200, { token: "synthetic-new", refreshToken: "synthetic-refresh-new" }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(save).toHaveBeenCalledOnce();
  });

  it("rejects a malformed compare start without polling an undefined session", async () => {
    const fetchImpl = vi.fn(async () => response(201, { status: "PENDING" }));
    await expect(startCompare(config(), { companyId: "company", query: "question" }, { fetchImpl })).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

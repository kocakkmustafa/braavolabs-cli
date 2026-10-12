/** Real API client with synthetic fetch/persistence; no network, disk or native calls. */
import { describe, expect, it, vi } from "vitest";
import { apiFetch, startCompare } from "../client";
import type { Config } from "../config";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function resp(status: number, body: unknown, json?: () => Promise<unknown>) {
  return { status, ok: status >= 200 && status < 300, statusText: `status ${status}`, json: json ?? (async () => body) };
}
const cfgA = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "A-old", refreshToken: "A-refresh-old" });
const rotateA = { token: "A-new", refreshToken: "A-refresh-new" };
function switchToB(cfg: Config) { cfg.token = "B-token"; cfg.refreshToken = "B-refresh"; }
function clear(cfg: Config) { cfg.token = undefined; cfg.refreshToken = undefined; }
const cancelled = { name: "SessionChangedError" };

describe("request session ownership", () => {
  it.each(["logout", "account", "api"] as const)("cancels a delayed initial 401 after %s without any refresh or replay", async (change) => {
    const cfg = cfgA(); const initial = deferred<ReturnType<typeof resp>>();
    const fetchImpl = vi.fn(async () => initial.promise); const save = vi.fn();
    const result = apiFetch("/research/cascade", { method: "POST", body: { prompt: "A-private" }, cfg, fetchImpl, save });
    const settled = result.catch((error) => error);
    if (change === "logout") clear(cfg);
    if (change === "account") switchToB(cfg);
    if (change === "api") cfg.apiUrl = "https://api.braavolabs.com/api/v2";
    initial.resolve(resp(401, { error: "expired" }));
    // A stale client might issue a refresh; it must not keep this test waiting.
    fetchImpl.mockImplementation(async () => resp(401, { error: "expired" }));
    expect(await settled).toMatchObject(cancelled);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["logout", "account", "api"] as const)("cancels refresh success after %s without restoring or persisting A", async (change) => {
    const cfg = cfgA(); const refresh = deferred<ReturnType<typeof resp>>(); const started = deferred<void>();
    const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) { started.resolve(); return refresh.promise; }
      return resp(401, { error: "expired" });
    });
    const result = apiFetch("/billing/savings", { cfg, fetchImpl, save }).catch((error) => error);
    await started.promise;
    if (change === "logout") clear(cfg);
    if (change === "account") switchToB(cfg);
    if (change === "api") cfg.apiUrl = "https://api.braavolabs.com/api/v2";
    const expected = { ...cfg };
    refresh.resolve(resp(200, rotateA));
    expect(await result).toMatchObject(cancelled);
    expect(cfg).toEqual(expected);
    expect(save).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("checks ownership again after refresh JSON finishes", async () => {
    const cfg = cfgA(); const json = deferred<unknown>(); const parsing = deferred<void>(); const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(200, null, async () => { parsing.resolve(); return json.promise; })
      : resp(401, { error: "expired" }));
    const result = apiFetch("/billing/savings", { cfg, fetchImpl, save }).catch((error) => error);
    await parsing.promise; clear(cfg); json.resolve(rotateA);
    expect(await result).toMatchObject(cancelled);
    expect(cfg.token).toBeUndefined(); expect(cfg.refreshToken).toBeUndefined();
    expect(save).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("discards a late success from account A after account B takes ownership", async () => {
    const cfg = cfgA(); const initial = deferred<ReturnType<typeof resp>>();
    const fetchImpl = vi.fn(async () => initial.promise);
    const result = apiFetch("/billing/savings", { cfg, fetchImpl }).catch((error) => error);
    switchToB(cfg); initial.resolve(resp(200, { privateAccountA: true }));
    expect(await result).toMatchObject(cancelled); expect(cfg.token).toBe("B-token");
  });

  it.each([false, true])("discards delayed success JSON after account switch (raw=%s)", async (raw) => {
    const cfg = cfgA(); const json = deferred<unknown>(); const parsing = deferred<void>();
    const fetchImpl = vi.fn(async () => resp(200, null, async () => { parsing.resolve(); return json.promise; }));
    const result = apiFetch("/billing/savings", { cfg, fetchImpl, raw }).catch((error) => error);
    await parsing.promise; switchToB(cfg); json.resolve({ privateAccountA: true });
    expect(await result).toMatchObject(cancelled);
  });

  it("does not deliver a stale account's parsed error to the new session", async () => {
    const cfg = cfgA(); const json = deferred<unknown>(); const parsing = deferred<void>();
    const fetchImpl = vi.fn(async () => resp(403, null, async () => { parsing.resolve(); return json.promise; }));
    const result = apiFetch("/billing/savings", { cfg, fetchImpl }).catch((error) => error);
    await parsing.promise; switchToB(cfg); json.resolve({ error: "A denied" });
    expect(await result).toMatchObject(cancelled);
  });

  it("guards anonymous login completion when another account signs in first", async () => {
    const cfg: Config = { apiUrl: cfgA().apiUrl }; const response = deferred<ReturnType<typeof resp>>();
    const result = apiFetch("/auth/login", { method: "POST", auth: false, cfg, fetchImpl: async () => response.promise }).catch((error) => error);
    switchToB(cfg); response.resolve(resp(200, { token: "A-login", refreshToken: "A-login-refresh" }));
    expect(await result).toMatchObject(cancelled); expect(cfg.token).toBe("B-token");
  });

  it("shares one atomic refresh across two simultaneous 401 responses", async () => {
    const cfg = cfgA(); const refresh = deferred<ReturnType<typeof resp>>();
    const started = deferred<void>(); let refreshCalls = 0; const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls++; started.resolve();
        return refreshCalls === 1 ? refresh.promise : resp(401, { error: "refresh already consumed" });
      }
      return init.headers.Authorization === "Bearer A-new" ? resp(200, { ok: true }) : resp(401, { error: "expired" });
    });
    const results = Promise.allSettled([
      apiFetch("/billing/savings", { cfg, fetchImpl, save }),
      apiFetch("/research/s1", { cfg, fetchImpl, save }),
    ]);
    await started.promise; await Promise.resolve(); refresh.resolve(resp(200, rotateA));
    expect((await results).map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(refreshCalls).toBe(1); expect(save).toHaveBeenCalledOnce();
    expect(cfg.token).toBe("A-new"); expect(cfg.refreshToken).toBe("A-refresh-new");
  });

  it("uses an already rotated pair for a late 401 rather than consuming another refresh", async () => {
    const cfg = cfgA(); const late = deferred<ReturnType<typeof resp>>(); const save = vi.fn();
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls++;
        return refreshCalls === 1 ? resp(200, rotateA) : resp(401, { error: "unexpected second refresh" });
      }
      if (init.headers.Authorization === "Bearer A-new") return resp(200, { ok: true });
      return url.endsWith("/research/late") ? late.promise : resp(401, { error: "expired" });
    });
    const first = apiFetch("/billing/savings", { cfg, fetchImpl, save });
    const second = apiFetch("/research/late", { cfg, fetchImpl, save });
    const secondSettled = second.catch((error) => error);
    expect(await first).toEqual({ ok: true }); late.resolve(resp(401, { error: "late expired" }));
    expect(await secondSettled).toEqual({ ok: true });
    expect(refreshCalls).toBe(1); expect(save).toHaveBeenCalledOnce(); expect(cfg.token).toBe("A-new");
  });


  it.each([false, true])("keeps a late 401 joined to its refresh while persistence is pending (save fails=%s)", async (fails) => {
    const cfg = cfgA(); const late = deferred<ReturnType<typeof resp>>();
    const saving = deferred<void>(); const persistence = deferred<void>(); let replays = 0; let refreshCalls = 0;
    const save = vi.fn(async () => {
      saving.resolve(); await persistence.promise;
      if (fails) throw new Error("synthetic persistence failure");
    });
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) { refreshCalls++; return resp(200, rotateA); }
      if (init.headers.Authorization === "Bearer A-new") { replays++; return resp(200, { ok: true }); }
      return url.endsWith("/research/late") ? late.promise : resp(401, {});
    });
    const results = Promise.allSettled([
      apiFetch("/billing/savings", { cfg, fetchImpl, save }),
      apiFetch("/research/late", { cfg, fetchImpl, save }),
    ]);
    await saving.promise; late.resolve(resp(401, {}));
    await new Promise(resolve => setTimeout(resolve, 0));
    const earlyReplays = replays;
    persistence.resolve();
    const outcomes = await results;
    expect(earlyReplays).toBe(0);
    expect(outcomes.map(result => result.status)).toEqual(fails ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]);
    expect(refreshCalls).toBe(1); expect(save).toHaveBeenCalledOnce();
  });

  it("keeps refresh singleflight scoped to its config owner", async () => {
    const a = cfgA(); const b = { ...cfgA(), token: "B-old", refreshToken: "B-refresh-old" };
    const release = deferred<void>(); const started = deferred<void>(); let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) {
        if (++refreshCalls === 2) started.resolve();
        await release.promise;
        const owner = JSON.parse(init.body).refreshToken.startsWith("A-") ? "A" : "B";
        return resp(200, { token: owner + "-new", refreshToken: owner + "-refresh-new" });
      }
      return init.headers.Authorization.endsWith("-new") ? resp(200, { ok: true }) : resp(401, {});
    });
    const results = Promise.all([
      apiFetch("/billing/savings", { cfg: a, fetchImpl, save: vi.fn() }),
      apiFetch("/billing/savings", { cfg: b, fetchImpl, save: vi.fn() }),
    ]);
    await started.promise; release.resolve(); await results;
    expect(refreshCalls).toBe(2); expect(a.token).toBe("A-new"); expect(b.token).toBe("B-new");
  });

  it("rechecks ownership after an asynchronous persistence call before replay", async () => {
    const cfg = cfgA(); const persistence = deferred<void>(); const saving = deferred<void>();
    const save = vi.fn(async () => { saving.resolve(); await persistence.promise; });
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh") ? resp(200, rotateA) : resp(401, {}));
    const result = apiFetch("/billing/savings", { cfg, fetchImpl, save }).catch((error) => error);
    await saving.promise; switchToB(cfg); persistence.resolve();
    expect(await result).toMatchObject(cancelled); expect(cfg.token).toBe("B-token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid refresh bundle without clearing or persisting the valid owner", async () => {
    const cfg = cfgA(); const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(200, { refreshToken: "unusable" }) : resp(401, {}));
    await expect(apiFetch("/billing/savings", { cfg, fetchImpl, save })).rejects.toMatchObject({ name: "ApiError", status: 503 });
    expect(cfg).toEqual(cfgA()); expect(save).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});


describe("explicit compare contract", () => {
  it("sends exact ordered selections to the fail-closed endpoint", async () => {
    const selections = [{provider: "OPENAI", model: "gpt-4o"}, {provider: "GROQ", model: "llama-3.3-70b-versatile"}];
    const fetchImpl = vi.fn(async (_url: string, _init?: any) => resp(201, {id: "session", status: "PENDING"}));
    await startCompare(cfgA(), {companyId: "company", query: "question", selections}, {fetchImpl});
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://braavolabs.com/api/v1/research/compare/selected");
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).selections).toEqual(selections);
  });
  it("does not retry on the legacy endpoint when old platform returns 404", async () => {
    const fetchImpl = vi.fn(async () => resp(404, {error: "not found"}));
    await expect(startCompare(cfgA(), {companyId: "company", query: "question", selections: [{provider: "OPENAI", model: "gpt-4o"}]}, {fetchImpl})).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});


describe("transient authentication refresh failure status", () => {
  it.each([408, 429, 500, 503])("preserves refresh HTTP %s without rotating or persisting the owner", async status => {
    const cfg = cfgA(), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(status, { error: "refresh unavailable" }) : resp(401, { error: "expired" }));
    await expect(apiFetch("/billing/savings", { cfg, fetchImpl, save })).rejects.toMatchObject({ name: "ApiError", status });
    expect(cfg).toEqual(cfgA()); expect(save).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429, 500, 503])("keeps raw response handling with refresh HTTP %s", async status => {
    const cfg = cfgA(), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(status, { error: "refresh unavailable" }) : resp(401, { error: "expired" }));
    const result = await apiFetch("/billing/savings", { cfg, fetchImpl, save, raw: true });
    expect(result.status).toBe(status); expect(result.body.error).toBeTypeOf("string");
    expect(cfg).toEqual(cfgA()); expect(save).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403])("keeps rejected refresh HTTP %s as the original authentication failure", async status => {
    const cfg = cfgA(), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/refresh")
      ? resp(status, { error: "refresh rejected" }) : resp(401, { error: "expired" }));
    await expect(apiFetch("/billing/savings", { cfg, fetchImpl, save })).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(cfg).toEqual(cfgA()); expect(save).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares a transient failed refresh and starts a fresh flight when the service recovers", async () => {
    const cfg = cfgA(), save = vi.fn(), pending = deferred<ReturnType<typeof resp>>(), started = deferred<void>();
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) {
        if (++refreshCalls === 1) { started.resolve(); return pending.promise; }
        return resp(200, rotateA);
      }
      return init.headers.Authorization === "Bearer A-new" ? resp(200, { ok: true }) : resp(401, { error: "expired" });
    });
    const outcomes = Promise.allSettled([
      apiFetch("/one", { cfg, fetchImpl, save }), apiFetch("/two", { cfg, fetchImpl, save, raw: true }),
    ]);
    await started.promise; await new Promise(resolve => setImmediate(resolve)); pending.resolve(resp(503, {}));
    const failed = await outcomes;
    expect(failed).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ name: "ApiError", status: 503 }) }),
      expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ status: 503 }) }),
    ]);
    expect(refreshCalls).toBe(1); expect(cfg).toEqual(cfgA()); expect(save).not.toHaveBeenCalled();
    expect(await apiFetch("/three", { cfg, fetchImpl, save })).toEqual({ ok: true });
    expect(refreshCalls).toBe(2); expect(save).toHaveBeenCalledOnce(); expect(cfg.token).toBe("A-new");
  });
});


describe("transient refresh owner priority", () => {
  it.each([false, true])("prioritizes a replaced owner over transient refresh status (raw=%s)", async raw => {
    const cfg = cfgA(), pending = deferred<ReturnType<typeof resp>>(), started = deferred<void>(), save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) { started.resolve(); return pending.promise; }
      return resp(401, {});
    });
    const settled = apiFetch("/one", { cfg, fetchImpl, save, raw }).catch(error => error);
    await started.promise; switchToB(cfg); pending.resolve(resp(429, {}));
    expect(await settled).toMatchObject({ name: "SessionChangedError" });
    expect(cfg.token).toBe("B-token"); expect(save).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  apiFetch,
  ApiError,
  startCompare,
  pollCompare,
  cascade,
  savings,
  logout,
} from "../client";
import type { Config } from "../config";

/** Minimal fetch Response stand-in. */
function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

// BR-P0-004: apiFetch refuses non-official hosts without an explicit opt-in.
const baseCfg = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1" });

describe("apiFetch", () => {
  it("sends Bearer auth + Content-Type and returns parsed JSON on 2xx", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { hello: "world" });
    });
    const cfg = { ...baseCfg(), token: "tok" };
    const out = await apiFetch("/research/cascade", { method: "POST", body: { prompt: "hi" }, cfg, fetchImpl });
    expect(out).toEqual({ hello: "world" });
    expect(calls[0].url).toBe("https://braavolabs.com/api/v1/research/cascade");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ prompt: "hi" });
  });

  it("refreshes exactly once on 401 then retries with the new token", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      if (url.endsWith("/auth/refresh")) return resp(200, { token: "new", refreshToken: "r2" });
      if (init?.headers?.Authorization === "Bearer old") return resp(401, { error: "expired" });
      if (init?.headers?.Authorization === "Bearer new") return resp(200, { ok: true });
      return resp(500, {});
    });
    const cfg = { ...baseCfg(), token: "old", refreshToken: "r1" };
    const save = vi.fn();
    const out = await apiFetch("/billing/savings", { cfg, save, fetchImpl });
    expect(out).toEqual({ ok: true });
    expect(cfg.token).toBe("new");
    expect(cfg.refreshToken).toBe("r2");
    expect(save).toHaveBeenCalledOnce();
    const refresh = calls.find((c) => c.url.endsWith("/auth/refresh"));
    expect(refresh.auth).toBeUndefined(); // refresh must not carry a bearer header
    // original(401) + refresh + retry(200) = 3 fetches, no more
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws ApiError(401) on 401 when there is no refresh token", async () => {
    const fetchImpl = vi.fn(async () => resp(401, { error: "nope" }));
    const cfg = { ...baseCfg(), token: "old" };
    await expect(apiFetch("/billing/savings", { cfg, fetchImpl })).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
    });
  });

  it("throws ApiError with body.error on other non-2xx", async () => {
    const fetchImpl = vi.fn(async () => resp(422, { error: "bad query" }));
    const cfg = { ...baseCfg(), token: "t" };
    await expect(apiFetch("/research/compare", { method: "POST", body: {}, cfg, fetchImpl })).rejects.toThrow("bad query");
  });

  it("raw mode returns {status, body} instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => resp(409, { error: "CHECKPOINT_PENDING" }));
    const cfg = { ...baseCfg(), token: "t" };
    const r = await apiFetch("/x", { cfg, fetchImpl, raw: true });
    expect(r).toMatchObject({ status: 409, body: { error: "CHECKPOINT_PENDING" } });
  });

  it("uses manual redirect mode and rejects a credential-bearing redirect before following it", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      expect(init.redirect).toBe("manual");
      return { ...resp(307, {}), headers: { get: () => "https://attacker.test/steal" } };
    });
    const cfg = { ...baseCfg(), token: "secret" };
    await expect(apiFetch("/runs/r1/steer", {
      method: "POST", body: { content: "secret body" }, cfg, fetchImpl,
    })).rejects.toMatchObject({ name: "UntrustedHostError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a fetch implementation that reports an auto-followed cross-origin response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ...resp(200, { ok: true }),
      redirected: true,
      url: "https://attacker.test/steal",
    }));
    await expect(apiFetch("/auth/login", {
      method: "POST",
      body: { email: "a@b.c", password: "synthetic-password" },
      auth: false,
      cfg: baseCfg(),
      fetchImpl,
    })).rejects.toMatchObject({ name: "UntrustedHostError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a refresh redirect and never retries the original request", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/auth/refresh") ? resp(308, {}) : resp(401, { error: "expired" }));
    const cfg = { ...baseCfg(), token: "old", refreshToken: "refresh-secret" };
    await expect(apiFetch("/billing/savings", { cfg, fetchImpl })).rejects.toMatchObject({
      name: "UntrustedHostError",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cfg.token).toBe("old");
  });
});

describe("command wrappers", () => {
  it("preserves independently selected effort and order in the selected request", async () => {
    const selections = [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high" as const}, {provider: "GROQ", model: "llama-3.3-70b-versatile"}];
    const fetchImpl = vi.fn(async () => resp(201, {id: "s1", status: "PENDING"}));
    await startCompare({...baseCfg(), token: "t"}, {companyId: "c1", query: "question", selections}, {fetchImpl});
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("https://braavolabs.com/api/v1/research/compare/selected");
    expect(JSON.parse(init.body)).toEqual({companyId: "c1", query: "question", selections});
  });
  it("startCompare POSTs /research/compare with companyId + query + maxCandidates", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, method: init.method, body: JSON.parse(init.body) };
      return resp(201, { id: "s1", status: "PENDING" });
    });
    const cfg = { ...baseCfg(), token: "t" };
    const out = await startCompare(cfg, { companyId: "c1", query: "why is the sky blue", maxCandidates: 2 }, { fetchImpl });
    expect(out).toEqual({ id: "s1", status: "PENDING" });
    expect(captured.url).toBe("https://braavolabs.com/api/v1/research/compare");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({ companyId: "c1", query: "why is the sky blue", maxCandidates: 2 });
  });

  it("pollCompare GETs /research/:id until a terminal state", async () => {
    const seq = ["PENDING", "RUNNING", "COMPLETED"];
    let i = 0;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return resp(200, { id: "s1", status: seq[Math.min(i++, seq.length - 1)] });
    });
    const cfg = { ...baseCfg(), token: "t" };
    const session = await pollCompare(cfg, "s1", { fetchImpl, intervalMs: 0 });
    expect(session.status).toBe("COMPLETED");
    expect(urls.every((u) => u === "https://braavolabs.com/api/v1/research/s1")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("cascade POSTs /research/cascade with the prompt and NEVER a companyId", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return resp(200, { answer: "42", provider: "openai", model: "gpt", tier: "cheap", confidence: 0.9, escalated: false, totalCostUsd: 0.001 });
    });
    const cfg = { ...baseCfg(), token: "t" };
    const out = await cascade(cfg, { prompt: "meaning of life?", confidenceThreshold: 0.8 }, { fetchImpl });
    expect(out.answer).toBe("42");
    expect(captured.url).toBe("https://braavolabs.com/api/v1/research/cascade");
    expect(captured.body).toEqual({ prompt: "meaning of life?", confidenceThreshold: 0.8 });
    expect(captured.body).not.toHaveProperty("companyId");
  });

  it("savings GETs /billing/savings with the days query", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return resp(200, { report: { savedUsd: 1 } });
    });
    const cfg = { ...baseCfg(), token: "t" };
    await savings(cfg, { days: 30 }, { fetchImpl });
    expect(capturedUrl).toBe("https://braavolabs.com/api/v1/billing/savings?days=30");
  });
});

describe("logout", () => {
  it("POSTs /auth/logout with bearer AND the refresh token in the body (raw — swallows non-2xx)", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(200, { message: "Logged out successfully." });
    });
    const cfg = { ...baseCfg(), token: "tok", refreshToken: "r1" };
    const r = await logout(cfg, { fetchImpl });
    expect(calls[0].url).toBe("https://braavolabs.com/api/v1/auth/logout");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    // audit #1: the refresh token in the body lets the server revoke even when
    // the bearer has expired (the auth-optional logout falls back to it).
    expect(JSON.parse(calls[0].init.body)).toEqual({ refreshToken: "r1" });
    expect(r.status).toBe(200);
  });
});

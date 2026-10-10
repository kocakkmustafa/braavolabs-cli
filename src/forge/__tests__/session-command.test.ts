/** Actual command cases from braavo.ts; real client, synthetic persistence/network only. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as client from "../client";
import type { Config } from "../config";

const source = ts.createSourceFile("braavo.ts", readFileSync(join(process.cwd(), "src", "braavo.ts"), "utf8"), ts.ScriptTarget.Latest, true);
function commandCase(command: string, context: Record<string, unknown>) {
  let found: ts.CaseClause | undefined;
  function visit(node: ts.Node) {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === command) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw Error("Missing actual command " + command);
  const compiled = ts.transpileModule(`async function actualCommand(){${found.statements.map(node => node.getText(source)).join("\n")}}\nactualCommand;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(compiled, { ...client, ...context }) as () => Promise<void>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function resp(status: number, body: unknown) {
  return { status, ok: status === 200, statusText: String(status), json: async () => body };
}
const cfgA = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "A-old", refreshToken: "A-refresh-old" });

describe("actual CLI logout command owner", () => {
  it("clears the active config immediately while revoking a captured credential snapshot", async () => {
    const cfg = cfgA(); const response = deferred<ReturnType<typeof resp>>();
    const clearConfig = vi.fn(); const fetchImpl = vi.fn(async () => response.promise);
    const action = commandCase("logout", {
      cfg, clearConfig, ui: { ok: vi.fn() }, logout: (owner: Config) => client.logout(owner, { fetchImpl }),
    })();
    const duringLogout = { ...cfg }; const clearCount = clearConfig.mock.calls.length;
    response.resolve(resp(200, {})); await action;
    expect(duringLogout.token).toBeUndefined(); expect(duringLogout.refreshToken).toBeUndefined();
    expect(clearCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://braavolabs.com/api/v1/auth/logout", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer A-old" }),
      body: JSON.stringify({ refreshToken: "A-refresh-old" }),
    }));
  });

  it("revokes a refresh-only session as well as clearing it locally", async () => {
    const cfg = { ...cfgA(), token: undefined }; const logout = vi.fn(async () => ({}));
    await commandCase("logout", { cfg, logout, clearConfig: vi.fn(), ui: { ok: vi.fn() } })();
    expect(logout).toHaveBeenCalledOnce(); expect(cfg.refreshToken).toBeUndefined();
  });

  it("prevents an outstanding refresh from saving credentials after the command clears them", async () => {
    const cfg = cfgA(); const refresh = deferred<ReturnType<typeof resp>>(); const started = deferred<void>();
    const save = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) { started.resolve(); return refresh.promise; }
      return resp(401, {});
    });
    const old = client.apiFetch("/billing/savings", { cfg, fetchImpl, save }).catch(error => error);
    await started.promise;
    await commandCase("logout", { cfg, logout: async () => ({}), clearConfig: vi.fn(), ui: { ok: vi.fn() } })();
    refresh.resolve(resp(200, { token: "A-new", refreshToken: "A-refresh-new" }));
    const outcome = await old;
    expect(cfg.token).toBeUndefined(); expect(cfg.refreshToken).toBeUndefined();
    expect(save).not.toHaveBeenCalled(); expect(outcome).toMatchObject({ name: "SessionChangedError" });
  });

  it("invalidates prior requests even if an identical pair is restored after logout", async () => {
    const cfg = cfgA(); const response = deferred<ReturnType<typeof resp>>();
    const old = client.apiFetch("/billing/savings", { cfg, fetchImpl: async () => response.promise }).catch(error => error);
    await commandCase("logout", { cfg, logout: async () => ({}), clearConfig: vi.fn(), ui: { ok: vi.fn() } })();
    cfg.token = "A-old"; cfg.refreshToken = "A-refresh-old";
    response.resolve(resp(200, { accountAData: true }));
    expect(await old).toMatchObject({ name: "SessionChangedError" });
  });
});

it("manual CLI token replacement does not retain the previous account's refresh token", async () => {
  const cfg = cfgA(); const saveConfig = vi.fn();
  await commandCase("login", {
    cfg, flags: {}, flag: () => "B-manual-token", saveConfig, ui: { ok: vi.fn() },
  })();
  expect(cfg.token).toBe("B-manual-token"); expect(cfg.refreshToken).toBeUndefined();
  expect(saveConfig).toHaveBeenCalledOnce();
});

describe("actual CLI handoff and session outcomes", () => {
  const pending = "Checkpoint not frozen yet — the live loop hasn't reached a turn boundary. Retry shortly.";
  const claimed = { success: true, handoffId: "handoff", toProvider: "OPENAI", toModel: "model", status: "RUNNING" };
  function continueCommand(results: { status: number; body: unknown }[]) {
    const apiFetch = vi.fn(async () => ({ statusText: "fixture", ...results.shift() }));
    const sleep = vi.fn(async () => {}); const ok = vi.fn();
    const action = commandCase("continue", { cfg: cfgA(), positionals: ["run"], flags: {},
      flag: (_flags: unknown, name: string) => name === "provider" ? "OPENAI" : undefined,
      requireAuth: vi.fn(), requireConfirmation: vi.fn(), apiFetch, sleep, ui: { ok }, console: { log: vi.fn() } });
    return { action, apiFetch, sleep, ok };
  }

  it.each([401, 403, 404, 409, 503])("keeps handoff HTTP %s terminal instead of retrying unrelated conflicts", async status => {
    const test = continueCommand([{ status, body: { error: "not claimable" } }]);
    await expect(test.action()).rejects.toMatchObject({ name: "ApiError", status, message: "not claimable" });
    expect(test.apiFetch).toHaveBeenCalledOnce(); expect(test.sleep).not.toHaveBeenCalled(); expect(test.ok).not.toHaveBeenCalled();
  });

  it.each([{ error: pending }, { code: "CHECKPOINT_PENDING", error: "freeze pending" }])("retries only explicit checkpoint readiness %#", async body => {
    const test = continueCommand([{ status: 409, body }, { status: 200, body: claimed }]);
    await test.action(); expect(test.apiFetch).toHaveBeenCalledTimes(2); expect(test.sleep).toHaveBeenCalledExactlyOnceWith(2000);
    expect(test.ok).toHaveBeenCalledOnce();
  });

  it("bounds checkpoint retries and returns API failure after five attempts", async () => {
    const test = continueCommand(Array.from({ length: 5 }, () => ({ status: 409, body: { error: pending } })));
    await expect(test.action()).rejects.toMatchObject({ name: "ApiError", status: 409 });
    expect(test.apiFetch).toHaveBeenCalledTimes(5); expect(test.sleep).toHaveBeenCalledTimes(4); expect(test.ok).not.toHaveBeenCalled();
  });

  it.each([{}, { ...claimed, success: false }, { ...claimed, handoffId: "" }, { ...claimed, toModel: null }])("does not claim success from malformed HTTP 200 %#", async body => {
    const test = continueCommand([{ status: 200, body }]);
    await expect(test.action()).rejects.toMatchObject({ name: "ApiError", status: 502 });
    expect(test.apiFetch).toHaveBeenCalledOnce(); expect(test.ok).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 503])("does not render HTTP %s as an empty active-session list", async status => {
    const emit = vi.fn(); const fetchImpl = vi.fn(async () => resp(status, { error: "denied" }));
    await expect(commandCase("session", { cfg: { ...cfgA(), refreshToken: undefined }, flags: {}, requireAuth: vi.fn(), emit,
      apiFetch: (path: string, options: client.RequestOpts) => client.apiFetch(path, { ...options, fetchImpl }) })())
      .rejects.toMatchObject({ name: "ApiError", status });
    expect(emit).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([{ body: [] }, { body: { sessions: [{ id: "relay", state: "running" }] } }])("retains successful active-session envelopes %#", async ({ body }) => {
    const emit = vi.fn(); await commandCase("session", { cfg: cfgA(), flags: {}, requireAuth: vi.fn(), emit, apiFetch: async () => body })();
    expect(emit).toHaveBeenCalledWith({}, { sessions: Array.isArray(body) ? body : body.sessions }, expect.any(Function));
  });
});

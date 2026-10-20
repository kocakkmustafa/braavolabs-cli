/** Actual login command + client + isolated real config; only fetch/prompts are deferred. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../client";
import * as config from "../config";
import * as locale from "../locale";
import type { Config } from "../config";

const source = ts.createSourceFile("braavo.ts", readFileSync(join(process.cwd(), "src/braavo.ts"), "utf8"), ts.ScriptTarget.Latest, true);
function loginCommand(context: Record<string, unknown>): () => Promise<void> {
  let found: ts.CaseClause | undefined;
  function visit(node: ts.Node) {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === "login") found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw Error("Missing actual login command");
  const compiled = ts.transpileModule(`async function actualCommand(){${found.statements.map(node => node.getText(source)).join("\n")}}\nreturn actualCommand;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = {
    ...client, ...config, ...locale,
    saveConfig: (cfg: Config) => config.saveConfig(cfg, path),
    captureConfigOwner: (cfg: Config) => (config as any).captureConfigOwner(cfg, path),
    commitLoginIfCurrent: (cfg: Config, pair: Config, owner: unknown) => (config as any).commitLoginIfCurrent(cfg, pair, owner, path),
    ...context,
  };
  // Same realm as the actual modules; this also preserves native Promise identity.
  return new Function(...Object.keys(scope), compiled)(...Object.values(scope));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function resp(body: unknown) { return { status: 200, ok: true, statusText: "OK", json: async () => body }; }
const cfgA = (): Config => ({ apiUrl: config.DEFAULT_API, token: "A-old", refreshToken: "A-refresh-old", defaultCompany: "company-A" });
const loginA = { token: "A-login", refreshToken: "A-login-refresh", user: { email: "A@example.invalid" }, tenant: { name: "tenant-A" } };
let directory = "";
let path = "";
beforeEach(() => {
  directory = mkdtempSync(join(dirname(process.cwd()), "mobile-cli-login-fixture-"));
  path = join(directory, "config.json");
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const disk = () => existsSync(path) ? readFileSync(path, "utf8") : null;

function pendingLogin(cfg: Config, flags: Record<string, string> = { email: "A@example.invalid", password: "synthetic-password" }) {
  const response = deferred<ReturnType<typeof resp>>();
  const started = deferred<void>();
  const ui = { ok: vi.fn() };
  const fetchImpl = vi.fn(async () => { started.resolve(); return response.promise; });
  const run = loginCommand({
    cfg, flags, flag: (all: Record<string, string>, key: string) => all[key], ui,
    login: (owner: Config, credentials: { email: string; password: string }) => client.login(owner, credentials, { fetchImpl }),
  })().then(() => null, error => error);
  return { response, started, ui, fetchImpl, run };
}

describe("actual CLI email-login durable owner", () => {
  it.each(["account", "logout", "api", "same-pair", "logout-then-same-pair"] as const)("cannot commit a late A login after independent %s", async (boundary) => {
    config.saveConfig(cfgA(), path);
    const cfg = config.loadConfig(path);
    const pending = pendingLogin(cfg);
    await pending.started.promise;
    if (boundary === "logout" || boundary === "logout-then-same-pair") config.clearConfig(path);
    if (boundary !== "logout") config.saveConfig(boundary === "account"
      ? { ...cfgA(), token: "B-token", refreshToken: "B-refresh", defaultCompany: "company-B" }
      : boundary === "api" ? { ...cfgA(), apiUrl: "https://api.braavolabs.com/api/v2" } : cfgA(), path);
    const expected = disk();
    pending.response.resolve(resp(loginA));
    const outcome = await pending.run;
    expect(disk()).toBe(expected);
    expect(outcome).toMatchObject({ name: "SessionChangedError" });
    expect(pending.ui.ok).not.toHaveBeenCalled();
    expect(cfg.token).toBe("A-old");
    expect(pending.fetchImpl).toHaveBeenCalledOnce();
  });

  it("distinguishes an initially absent config from absent → logout → absent", async () => {
    const cfg = config.loadConfig(path);
    const pending = pendingLogin(cfg);
    await pending.started.promise;
    config.clearConfig(path);
    expect(disk()).toBeNull();
    pending.response.resolve(resp(loginA));
    expect(await pending.run).toMatchObject({ name: "SessionChangedError" });
    expect(disk()).toBeNull();
    expect(pending.ui.ok).not.toHaveBeenCalled();
  });

  it("accepts a first login when the captured absent owner is unchanged", async () => {
    const cfg = config.loadConfig(path);
    const pending = pendingLogin(cfg);
    await pending.started.promise;
    pending.response.resolve(resp(loginA));
    expect(await pending.run).toBeNull();
    expect(JSON.parse(disk()!)).toEqual({ apiUrl: config.DEFAULT_API, token: "A-login", refreshToken: "A-login-refresh" });
    expect(cfg.token).toBe("A-login");
    expect(pending.ui.ok).toHaveBeenCalledOnce();
  });

  it("captures before asynchronous credential prompts, so B is preserved even before A's fetch starts", async () => {
    config.saveConfig(cfgA(), path);
    const cfg = config.loadConfig(path);
    const email = deferred<string>(); const prompting = deferred<void>();
    const ui = { ok: vi.fn() };
    const fetchImpl = vi.fn(async () => resp(loginA));
    const run = loginCommand({
      cfg, flags: {}, flag: () => undefined, ui,
      prompt: async () => { prompting.resolve(); return email.promise; },
      promptHidden: async () => "synthetic-password",
      login: (owner: Config, credentials: { email: string; password: string }) => client.login(owner, credentials, { fetchImpl }),
    })().then(() => null, error => error);
    await prompting.promise;
    config.saveConfig({ ...cfgA(), token: "B-token", refreshToken: "B-refresh" }, path);
    const expected = disk();
    email.resolve("A@example.invalid");
    expect(await run).toMatchObject({ name: "SessionChangedError" });
    expect(disk()).toBe(expected);
    expect(ui.ok).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets a completed B login supersede a previously pending A login from another config instance", async () => {
    config.saveConfig(cfgA(), path);
    const a = pendingLogin(config.loadConfig(path)); await a.started.promise;
    const b = pendingLogin(config.loadConfig(path), { email: "B@example.invalid", password: "synthetic-B-password" });
    await b.started.promise;
    b.response.resolve(resp({ token: "B-token", refreshToken: "B-refresh", user: { email: "B@example.invalid" } }));
    expect(await b.run).toBeNull();
    const expected = disk();
    a.response.resolve(resp(loginA));
    expect(await a.run).toMatchObject({ name: "SessionChangedError" });
    expect(disk()).toBe(expected); expect(a.ui.ok).not.toHaveBeenCalled(); expect(b.ui.ok).toHaveBeenCalledOnce();
  });
});

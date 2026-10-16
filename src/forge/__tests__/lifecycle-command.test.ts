import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../exit-codes";

// This fixture executes the actual compiled CLI with an isolated home and
// scripted fetch. It cannot reach a provider, a real config, or the keychain.
let buildRoot: string; let bin: string; let preload: string;
beforeAll(() => {
  const artifactDir = process.env.BRAAVO_LIFECYCLE_ARTIFACT_DIR;
  if (artifactDir) mkdirSync(artifactDir, { recursive: true });
  buildRoot = mkdtempSync(join(artifactDir ?? tmpdir(), "braavo-lifecycle-"));
  bin = join(buildRoot, "dist", "braavo.js"); preload = join(buildRoot, "isolated.cjs");
  copyFileSync(join(process.cwd(), "package.json"), join(buildRoot, "package.json"));
  symlinkSync(join(process.cwd(), "node_modules"), join(buildRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const build = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(buildRoot, "dist")],
    { cwd: process.cwd(), encoding: "utf8", timeout: 30000 });
  expect(build.error, build.stderr).toBeUndefined(); expect(build.status, build.stdout + build.stderr).toBe(0);
  writeFileSync(preload, `
const fs = require("node:fs"); const os = require("node:os");
os.homedir = () => process.env.BRAAVO_TEST_HOME;
const scripted = JSON.parse(process.env.BRAAVO_TEST_SCRIPT); let request = 0;
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => setTimer(fn, ms === 2000 || ms === 3000 ? 1 : ms, ...args);
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  fs.appendFileSync(process.env.BRAAVO_TEST_CALLS, JSON.stringify({ path, method: init.method,
    body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers?.Authorization }) + "\\n");
  const step = scripted[request++]; if (!step) throw new Error("Unexpected synthetic request");
  if (step.interrupt) return new Promise((resolve, reject) => {
    if (!init.signal) return reject(new Error("Missing request cancellation signal"));
    const keepAlive = setTimer(() => reject(new Error("Synthetic signal was not delivered")), 1000);
    init.signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      fs.writeFileSync(process.env.BRAAVO_TEST_ABORTED, "aborted"); reject(init.signal.reason);
    }, {once:true});
    setImmediate(() => process.kill(process.pid, "SIGINT"));
  });
  if (step.offline) throw new TypeError("synthetic offline");
  if (step.interruptAfterResponse) setTimer(() => process.kill(process.pid, "SIGINT"), 0);
  return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
};
`);
}, 40000);
afterAll(() => {
  if (buildRoot && !process.env.BRAAVO_LIFECYCLE_ARTIFACT_DIR) rmSync(buildRoot, { recursive: true, force: true });
});

interface Step { status?: number; body?: unknown; interrupt?: boolean; interruptAfterResponse?: boolean; offline?: boolean }
function run(args: string[], script: Step[], authenticated = true) {
  const home = mkdtempSync(join(buildRoot, "home-")); const calls = join(home, "calls.jsonl"); const aborted = join(home, "aborted");
  if (authenticated) {
    mkdirSync(join(home, ".braavo"), { mode: 0o700 });
    writeFileSync(join(home, ".braavo", "config.json"), JSON.stringify({
      apiUrl: "https://braavolabs.com/api/v1", token: "synthetic-access", defaultCompany: "synthetic-company",
    }), { mode: 0o600 });
  }
  const result = spawnSync(process.execPath, ["--require", preload, bin, ...args], {
    cwd: home, encoding: "utf8", timeout: 8000,
    env: { PATH: process.env.PATH, LANG: "C", TERM: "dumb", NO_COLOR: "1", BRAAVO_TEST_HOME: home,
      BRAAVO_TEST_CALLS: calls, BRAAVO_TEST_ABORTED: aborted, BRAAVO_TEST_SCRIPT: JSON.stringify(script) },
  });
  expect(result.error).toBeUndefined();
  return { ...result, aborted: existsSync(aborted), calls: existsSync(calls)
    ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

describe("compiled CLI lifecycle", () => {
  it("executes explicit model selection through pending/running/completed polling", () => {
    const result = run(["ask", "synthetic question", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort", "high"], [
      { status: 201, body: { id: "research", status: "PENDING" } }, { body: { status: "RUNNING" } },
      { body: { status: "COMPLETED", findings: { multiModel: { finalAnswer: "Synthetic complete answer" } } } },
    ]);
    expect(result.status).toBe(EXIT.OK); expect(result.stdout).toContain("Synthetic complete answer");
    expect(result.calls.map(call => call.path)).toEqual(["/api/v1/research/compare/selected", "/api/v1/research/research", "/api/v1/research/research"]);
    expect(result.calls[0].body).toEqual({ companyId: "synthetic-company", query: "synthetic question",
      selections: [{ provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "high" }] });
  });

  it.each(["FAILED", "CANCELLED"])("reports terminal compare %s without synthesis", status => {
    const result = run(["ask", "synthetic question"], [{ body: { id: "research" } }, { body: { status, error: "synthetic failure" } }]);
    expect(result.status).toBe(EXIT.API); expect(result.stderr).toContain(`Compare ${status.toLowerCase()}: synthetic failure`);
    expect(result.stdout).not.toContain("synthesis"); expect(result.calls).toHaveLength(2);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])("explicit cancel preserves stored %s in JSON", status => {
    const result = run(["cancel", "a/b c", "--yes", "--json"], [{ body: { success: true, status } }]);
    expect(result.status).toBe(EXIT.OK); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ id: "a/b c", action: "cancel", result: { success: true, status } });
    expect(result.calls).toEqual([{ path: "/api/v1/research/a%2Fb%20c/cancel", method: "POST", body: {}, authorization: "Bearer synthetic-access" }]);
  });

  it.each([{ flags: [] }, { flags: ["--yes", "true"] }, { flags: ["--yes", "--approval", "unverified"] }])("cancel refuses missing or unverified confirmation %j", ({ flags }) => {
    const result = run(["cancel", "research", "--json", ...flags], []);
    expect(result.status).toBe(EXIT.CONFIRMATION_REQUIRED); expect(result.stdout).toBe(""); expect(result.calls).toEqual([]);
  });

  it("cancel requires auth before dispatch", () => {
    const result = run(["cancel", "research", "--yes", "--json"], [], false);
    expect(result.status).toBe(EXIT.AUTH); expect(result.stdout).toBe(""); expect(result.calls).toEqual([]);
  });

  it("cancel requires an ID before dispatch", () => {
    const result = run(["cancel", "--yes"], []);
    expect(result.status).toBe(EXIT.USAGE); expect(result.calls).toEqual([]);
  });

  it.each([[401, EXIT.AUTH], [404, EXIT.NOT_FOUND], [503, EXIT.API]])("cancel HTTP %s returns documented exit %s without success", (status, exit) => {
    const result = run(["cancel", "research", "--yes", "--json"], [{ status, body: { error: "synthetic error" } }]);
    expect(result.status).toBe(exit); expect(result.stdout).toBe(""); expect(result.stderr).toContain("synthetic error"); expect(result.calls).toHaveLength(1);
  });

  it.each([{}, { success: false, status: "CANCELLED" }, { success: true, status: "RUNNING" }])("cancel fails closed on malformed success %j", body => {
    const result = run(["cancel", "research", "--yes", "--json"], [{ body }]);
    expect(result.status).toBe(EXIT.API); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Invalid cancellation response"); expect(result.calls).toHaveLength(1);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED", "STOPPED"])("watch emits one final JSON document for %s", status => {
    const result = run(["watch", "a/b c", "--json"], [{ body: { status: "RUNNING" } }, { body: { status } }]);
    expect(result.status).toBe(status === "COMPLETED" ? EXIT.OK : EXIT.GENERAL);
    expect(JSON.parse(result.stdout)).toEqual({ id: "a/b c", status, terminal: true }); expect(result.stderr).toBe("");
    expect(result.calls.map(call => call.path)).toEqual(["/api/v1/runs/a%2Fb%20c", "/api/v1/runs/a%2Fb%20c"]);
  });

  it.each(["ask", "watch"])("Ctrl-C aborts an active %s request and leaves remote cancellation explicit", command => {
    const script = command === "ask" ? [{ body: { id: "research" } }, { interrupt: true }] : [{ interrupt: true }];
    const result = run(command === "ask" ? ["ask", "synthetic question"] : ["watch", "run", "--json"], script);
    expect(result.status).toBe(EXIT.INTERRUPTED); expect(result.aborted).toBe(true);
    expect(result.stderr).toContain(command === "ask" ? "braavo cancel research --yes" : "braavo stop run --yes");
    expect(result.calls).toHaveLength(command === "ask" ? 2 : 1);
    expect(result.calls.every(call => !/\/(cancel|stop)$/.test(call.path))).toBe(true);
    if (command === "watch") expect(result.stdout).toBe("");
  });

  it("Ctrl-C interrupts compare submission before a session ID is known", () => {
    const result = run(["ask", "synthetic question"], [{ interrupt: true }]);
    expect(result.status).toBe(EXIT.INTERRUPTED); expect(result.aborted).toBe(true);
    expect(result.stderr).toContain("inspect research sessions before retrying");
    expect(result.calls).toHaveLength(1); expect(result.calls[0].method).toBe("POST");
  });

  it("Ctrl-C stops a watch backoff without another poll", () => {
    const result = run(["watch", "run", "--json"], [{ body: { status: "RUNNING" }, interruptAfterResponse: true }]);
    expect(result.status).toBe(EXIT.INTERRUPTED); expect(result.calls).toHaveLength(1); expect(result.stdout).toBe("");
  });

  it("run emits the actual started run as JSON", () => {
    const body = { id: "run", status: "PENDING", jobId: "job" };
    const result = run(["run", "a/b c", "--yes", "--json"], [{ status: 201, body }]);
    expect(result.status).toBe(EXIT.OK); expect(JSON.parse(result.stdout)).toEqual(body); expect(result.stderr).toBe("");
    expect(result.calls).toEqual([{ path: "/api/v1/pipelines/a%2Fb%20c/run", method: "POST", body: { input: {} }, authorization: "Bearer synthetic-access" }]);
  });

  it("stop acknowledges the actual pipeline CANCELLED response", () => {
    const result = run(["stop", "a/b c", "--yes", "--json"], [{ body: { success: true, status: "CANCELLED" } }]);
    expect(result.status).toBe(EXIT.OK); expect(JSON.parse(result.stdout)).toMatchObject({ action: "stop", result: { status: "CANCELLED" } });
    expect(result.calls[0].path).toBe("/api/v1/runs/a%2Fb%20c/stop");
  });

  it.each(["run", "stop"])("%s rejects malformed success without a retry", command => {
    const result = run([command, "target", "--yes", "--json"], [{ body: {} }]);
    expect(result.status).toBe(EXIT.API); expect(result.stdout).toBe(""); expect(result.stderr).toContain(`Invalid ${command} response`);
    expect(result.calls).toHaveLength(1);
  });

  it("watch rejects malformed status instead of waiting forever", () => {
    const result = run(["watch", "run", "--json"], [{ body: {} }]);
    expect(result.status).toBe(EXIT.API); expect(result.stdout).toBe(""); expect(result.calls).toHaveLength(1);
  });
});

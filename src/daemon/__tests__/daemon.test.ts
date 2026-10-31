import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { firstFireAt, intervalMs, planTick, TICK_MS } from "../scheduler";
import { DaemonStore } from "../store";
import { Daemon } from "../server";
import { daemonPaths, ensureToken, readState, runningDaemon, writeState } from "../lifecycle";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "braavo-daemon-")); dirs.push(d); return d; };
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-31T00:00:00.000Z");

describe("scheduler", () => {
  it("accepts the supported RRULE subset with a 15 minute floor", () => {
    expect(intervalMs("FREQ=HOURLY;INTERVAL=6")).toBe(6 * H);
    expect(intervalMs("RRULE:FREQ=DAILY")).toBe(24 * H);
    expect(intervalMs("FREQ=MINUTELY;INTERVAL=15")).toBe(15 * 60_000);
    expect(intervalMs("FREQ=MINUTELY;INTERVAL=5")).toBeUndefined();
    expect(intervalMs("FREQ=DAILY;BYHOUR=9")).toBeUndefined(); // calendar parts are not silently misread
    expect(intervalMs("FREQ=YEARLY")).toBeUndefined();
    expect(firstFireAt("FREQ=HOURLY", new Date(T0))).toBe(iso(T0 + H));
  });

  it("runs a routine that is due on time and re-anchors the next firing", () => {
    const actions = planTick([{ id: "r", rrule: "FREQ=HOURLY", catchUp: "once", nextFireAt: iso(T0), enabled: true }], new Date(T0 + 30_000));
    expect(actions).toEqual([{ routineId: "r", kind: "run", scheduledFor: iso(T0), catchUp: false, nextFireAt: iso(T0 + H) }]);
  });

  it("after a sleep runs only the latest missed firing once and records the rest", () => {
    const actions = planTick([{ id: "r", rrule: "FREQ=HOURLY", catchUp: "once", nextFireAt: iso(T0), enabled: true }], new Date(T0 + 3 * H + 10 * 60_000));
    expect(actions.map(a => [a.kind, a.scheduledFor, a.kind === "skip" ? a.outcome : a.catchUp])).toEqual([
      ["skip", iso(T0), "skipped-sleep"], ["skip", iso(T0 + H), "skipped-sleep"], ["skip", iso(T0 + 2 * H), "skipped-sleep"],
      ["run", iso(T0 + 3 * H), true],
    ]);
    expect(actions.every(a => a.nextFireAt === iso(T0 + 4 * H))).toBe(true);
  });

  it("honors catch-up skip, the 7-day window, running routines, disabled and invalid rules", () => {
    const late = new Date(T0 + 2 * H + 5 * 60_000);
    expect(planTick([{ id: "r", rrule: "FREQ=HOURLY", catchUp: "skip", nextFireAt: iso(T0), enabled: true }], late).at(-1)).toMatchObject({ kind: "skip", outcome: "skipped-sleep" });
    // A weekly routine 8 days late: the latest missed firing was 1 day ago, inside the 7-day window → runs once.
    expect(planTick([{ id: "r", rrule: "FREQ=WEEKLY", catchUp: "once", nextFireAt: iso(T0), enabled: true }], new Date(T0 + 8 * 24 * H)).at(-1)).toMatchObject({ kind: "run", catchUp: true });
    // A fortnightly routine 13 days late: its only missed firing is older than 7 days → skipped.
    expect(planTick([{ id: "r", rrule: "FREQ=WEEKLY;INTERVAL=2", catchUp: "once", nextFireAt: iso(T0), enabled: true }], new Date(T0 + 13 * 24 * H)).at(-1)).toMatchObject({ kind: "skip", outcome: "skipped-sleep" });
    expect(planTick([{ id: "r", rrule: "FREQ=HOURLY", catchUp: "once", nextFireAt: iso(T0), enabled: true, running: true }], new Date(T0 + 1000))).toMatchObject([{ kind: "skip", outcome: "skipped-running" }]);
    expect(planTick([{ id: "r", rrule: "FREQ=HOURLY", catchUp: "once", nextFireAt: iso(T0), enabled: false }], new Date(T0 + H))).toEqual([]);
    expect(planTick([{ id: "r", rrule: "FREQ=DAILY;BYHOUR=9", catchUp: "once", nextFireAt: iso(T0), enabled: true }], new Date(T0 + 1000))).toMatchObject([{ kind: "skip", outcome: "invalid-rule" }]);
    expect(planTick([{ id: "r", rrule: "FREQ=HOURLY", catchUp: "once", nextFireAt: iso(T0 + H), enabled: true }], new Date(T0))).toEqual([]);
  });

  it("caps the recorded misses after a very long sleep", () => {
    const actions = planTick([{ id: "r", rrule: "FREQ=MINUTELY;INTERVAL=15", catchUp: "once", nextFireAt: iso(T0), enabled: true }], new Date(T0 + 30 * 24 * H));
    expect(actions.filter(a => a.kind === "skip").length).toBeLessThanOrEqual(51);
    expect(TICK_MS).toBe(60_000);
  });
});

describe("store", () => {
  it("migrates once, keeps foreign keys and searches message history", () => {
    const dir = tmp(); const path = join(dir, "braavo.db");
    const store = new DaemonStore(path); closers.push(() => store.close());
    expect(store.schemaVersion()).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const company = store.createCompany({ name: "YULA Lab" });
    const ceo = store.createAgent({ companyId: company.id, name: "CEO", role: "ceo", provider: "ANTHROPIC", model: "claude-opus-5-5", effort: "medium" });
    const analyst = store.createAgent({ companyId: company.id, name: "Analyst", role: "market", provider: "OLLAMA", model: "qwen", reportsToAgentId: ceo.id });
    expect(store.listAgents(company.id).map(a => [a.name, a.reports_to_agent_id])).toEqual([["CEO", null], ["Analyst", ceo.id]]);
    expect(() => store.createAgent({ companyId: "nope", name: "x", role: "x", provider: "GROQ", model: "m" })).toThrow();
    const cv = store.createConversation({ companyId: company.id, agentId: analyst.id });
    store.addMessage(cv, "assistant", "Rival cut the Pro plan from $49 to $39");
    store.addMessage(cv, "user", "Summarize the autumn campaign");
    expect(store.searchMessages("Pro plan").map(m => m.content)).toEqual(["Rival cut the Pro plan from $49 to $39"]);
    expect(store.searchMessages('"); DROP TABLE message; --')).toEqual([]);
    store.close(); closers.pop();
    const reopened = new DaemonStore(path); closers.push(() => reopened.close());
    expect(reopened.schemaVersion()).toBe(1);
    expect(reopened.recentActivity(company.id).map(a => a.verb).sort()).toEqual(["created", "hired", "hired"]);
  });
});

describe("lifecycle files", () => {
  it("creates a 0600 token once and detects stale state", () => {
    const paths = daemonPaths(tmp());
    const token = ensureToken(paths);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(ensureToken(paths)).toBe(token);
    expect(statSync(paths.token).mode & 0o777).toBe(0o600);
    writeState(paths, { pid: 999_999_999, port: 1, startedAt: "x", version: "0" });
    expect(readState(paths)?.pid).toBe(999_999_999);
    expect(runningDaemon(paths)).toBeUndefined(); // dead pid → stale file removed
    expect(readState(paths)).toBeUndefined();
    writeState(paths, { pid: process.pid, port: 1, startedAt: "x", version: "0" });
    expect(runningDaemon(paths)?.pid).toBe(process.pid);
  });
});

describe("local API", () => {
  async function boot(o: { now?: () => Date; runRoutine?: any; notify?: any } = {}) {
    const store = new DaemonStore(join(tmp(), "braavo.db"));
    const daemon = new Daemon({ store, token: "t".repeat(43), version: "test", ...o });
    const port = await daemon.listen(0);
    closers.push(async () => { await daemon.close(); store.close(); });
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${"t".repeat(43)}`, "Content-Type": "application/json", ...headers } }, res => {
        let data = ""; res.on("data", c => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
    return { daemon, store, call };
  }

  it("rejects missing tokens, browser origins and foreign hosts", async () => {
    const { call } = await boot();
    expect((await call("GET", "/v1/health", undefined, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("GET", "/v1/health", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await call("GET", "/v1/health", undefined, { Host: "evil.example" })).status).toBe(403);
    expect((await call("GET", "/v1/health")).body).toMatchObject({ ok: true, version: "test", schema: 1 });
    expect((await call("GET", "/v2/health")).status).toBe(404);
  });

  it("builds a company, an org chart and a routine; refuses cross-company managers and routine-made routines", async () => {
    const { call } = await boot();
    const company = (await call("POST", "/v1/companies", { name: "YULA Lab", mission: "Small, excellent apps" })).body.company;
    const other = (await call("POST", "/v1/companies", { name: "Other" })).body.company;
    const ceo = (await call("POST", `/v1/companies/${company.id}/agents`, { name: "CEO", role: "ceo", provider: "ANTHROPIC", model: "claude-opus-5-5", effort: "medium" })).body.agent;
    const analyst = await call("POST", `/v1/companies/${company.id}/agents`, { name: "Market analyst", role: "market", provider: "GROQ", model: "openai/gpt-oss-20b", effort: "low", reportsToAgentId: ceo.id });
    expect(analyst.status).toBe(201);
    expect((await call("POST", `/v1/companies/${other.id}/agents`, { name: "X", role: "x", provider: "GROQ", model: "m", reportsToAgentId: ceo.id })).status).toBe(400);
    expect((await call("POST", `/v1/companies/${company.id}/agents`, { name: "X", role: "x", provider: "NOPE", model: "m" })).status).toBe(400);
    expect((await call("POST", `/v1/companies/${company.id}/agents`, { name: "X", role: "x", provider: "GROQ", model: "m", effort: "xhigh" })).status).toBe(400);
    const org = (await call("GET", `/v1/companies/${company.id}/org`)).body;
    expect(org.agents.map((a: any) => [a.name, a.reports_to_agent_id])).toEqual([["CEO", null], ["Market analyst", ceo.id]]);

    const routine = await call("POST", `/v1/companies/${company.id}/routines`, { agentId: analyst.body.agent.id, name: "Watch rivals", prompt: "Summarize changes", rrule: "FREQ=HOURLY;INTERVAL=6", timezone: "Europe/Istanbul", preflight: { type: "web", urls: ["https://rival.example/pricing"], notify: ["price"] } });
    expect(routine.status).toBe(201);
    expect((await call("POST", `/v1/companies/${company.id}/routines`, { agentId: analyst.body.agent.id, name: "x", prompt: "x", rrule: "FREQ=MINUTELY", timezone: "UTC" })).status).toBe(400);
    expect((await call("POST", `/v1/companies/${company.id}/routines`, { agentId: analyst.body.agent.id, name: "x", prompt: "x", rrule: "FREQ=HOURLY", timezone: "Mars/Base" })).status).toBe(400);
    expect((await call("POST", `/v1/companies/${company.id}/routines`, { agentId: analyst.body.agent.id, name: "x", prompt: "x", rrule: "FREQ=HOURLY", timezone: "UTC", origin: "routine" })).status).toBe(403);
    expect((await call("GET", `/v1/companies/${company.id}/routines`)).body.routines).toHaveLength(1);
  });

  it("ticks: runs due routines, records the ledger, notifies catch-up runs", async () => {
    let now = T0;
    const runRoutine = vi.fn(async () => ({ outcome: "no-change", note: "prices unchanged" }));
    const notify = vi.fn();
    const { daemon, call } = await boot({ now: () => new Date(now), runRoutine, notify });
    const company = (await call("POST", "/v1/companies", { name: "YULA Lab" })).body.company;
    const agent = (await call("POST", `/v1/companies/${company.id}/agents`, { name: "A", role: "market", provider: "OLLAMA", model: "qwen" })).body.agent;
    const routine = (await call("POST", `/v1/companies/${company.id}/routines`, { agentId: agent.id, name: "Watch", prompt: "p", rrule: "FREQ=HOURLY", timezone: "UTC" })).body.routine;
    expect(await daemon.tick()).toEqual([]);
    now = T0 + H + 1000; // on time
    await daemon.tick();
    now = T0 + 5 * H; // laptop slept through 3 firings
    await daemon.tick();
    expect(runRoutine).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: "routine.executed", catchUp: true, outcome: "no-change" });
    const ledger = (await call("GET", `/v1/routines/${routine.id}/executions`)).body.executions;
    expect(ledger.map((e: any) => e.outcome)).toEqual(["no-change", "skipped-sleep", "skipped-sleep", "skipped-sleep", "no-change"]);
  });

  it("records a failed routine without crashing the tick", async () => {
    let now = T0;
    const { daemon, call } = await boot({ now: () => new Date(now), runRoutine: async () => { throw new Error("provider down"); } });
    const company = (await call("POST", "/v1/companies", { name: "C" })).body.company;
    const agent = (await call("POST", `/v1/companies/${company.id}/agents`, { name: "A", role: "r", provider: "OLLAMA", model: "q" })).body.agent;
    const routine = (await call("POST", `/v1/companies/${company.id}/routines`, { agentId: agent.id, name: "W", prompt: "p", rrule: "FREQ=HOURLY", timezone: "UTC" })).body.routine;
    now = T0 + H;
    await daemon.tick();
    expect((await call("GET", `/v1/routines/${routine.id}/executions`)).body.executions).toMatchObject([{ outcome: "failed", note: "provider down" }]);
  });
});

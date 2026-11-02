import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStore } from "../store";
import { CompanyMemory } from "../memory";
import { Daemon } from "../server";
import { MAX_REPLANS, newGoalId, parseJsonBlock, runGoal, toTaskLedger, type LedgerDeps } from "../ledger";

const KEY = "gsk_test_0123456789abcdef";
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const sse = (text: string) => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`, "data: [DONE]\n\n",
].join(""), { status: 200 });
const answers = (...texts: string[]) => {
  const f = vi.fn();
  for (const t of texts) f.mockResolvedValueOnce(sse(t));
  f.mockResolvedValue(sse('{"done": false, "progressing": false, "next": "continue", "reason": "fallback"}'));
  return f;
};
const plan = (...steps: Array<[string, string]>) => JSON.stringify({ facts: ["Launch is Monday"], assumptions: ["Budget is fine"], plan: steps.map(([assignee, instruction]) => ({ assignee, instruction })) });
const verdict = (done: boolean, progressing: boolean, next: string, reason = "ok") => "```json\n" + JSON.stringify({ done, progressing, next, reason }) + "\n```";

function setup() {
  const store = new DaemonStore(":memory:");
  closers.push(() => store.close());
  const memory = new CompanyMemory(mkdtempSync(join(tmpdir(), "braavo-ledger-")), store, { git: false });
  const co = store.createCompany({ name: "Acme" });
  const gm = store.createAgent({ companyId: co.id, name: "GM", role: "ceo", provider: "GROQ", model: "openai/gpt-oss-20b" });
  const writer = store.createAgent({ companyId: co.id, name: "Writer", role: "content-social", provider: "GROQ", model: "x", reportsToAgentId: gm.id });
  const analyst = store.createAgent({ companyId: co.id, name: "Analyst", role: "market-analyst", provider: "GROQ", model: "x", reportsToAgentId: gm.id });
  const goal = store.createGoal({ id: newGoalId(), companyId: co.id, managerAgentId: gm.id, title: "Launch the product page", body: "By Monday." });
  return { store, memory, co, gm, writer, analyst, goal };
}
/** A task runner that finishes steps from a script: "done:<result>" or "failed". */
function scriptedRun(store: DaemonStore, script: string[]) {
  const ran: string[] = [];
  return {
    ran,
    runTask: vi.fn(async (taskId: string) => {
      const step = script[ran.length] ?? "done:ok";
      ran.push(taskId);
      if (step === "failed") { store.updateTask(taskId, { status: "FAILED", note: "provider error" }); return { outcome: "failed", note: "provider error" }; }
      store.updateTask(taskId, { status: "DONE", result: step.slice(5) });
      return { outcome: "done" };
    }),
  };
}
const deps = (fetchImpl: unknown, runTask: LedgerDeps["runTask"], memory?: CompanyMemory): LedgerDeps =>
  ({ keys: { get: () => KEY }, fetchImpl: fetchImpl as never, runTask, memory });

describe("ledger helpers (4.5)", () => {
  it("reads JSON from plain or fenced answers and keeps plan steps on the team", () => {
    expect(parseJsonBlock('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonBlock('prefix {"b": [1]} suffix')).toEqual({ b: [1] });
    expect(parseJsonBlock("no json")).toBeNull();
    const { store, co, gm } = setup();
    const team = store.listAgents(co.id);
    expect(toTaskLedger({ plan: [{ assignee: "writer", instruction: "Draft" }, { assignee: "Nobody", instruction: "Check" }, { assignee: "Writer" }] }, team, gm))
      .toEqual({ facts: [], assumptions: [], plan: [{ assignee: "Writer", instruction: "Draft" }, { assignee: "GM", instruction: "Check" }] });
    expect(toTaskLedger({ plan: [] }, team, gm)).toBeNull();
  });
});

describe("the manager runs a goal", () => {
  it("plans, hands steps to the team, checks progress after each, and writes the result", async () => {
    const { store, memory, co, goal, writer, analyst } = setup();
    const fetchImpl = answers(
      plan(["Analyst", "Collect rival prices"], ["Writer", "Draft the page"]),
      verdict(false, true, "continue"),
      verdict(true, true, "finish", "page drafted"),
      "The page is drafted with rival prices in mind.",
    );
    const run = scriptedRun(store, ["done:Rivals charge $19-29", "done:Draft ready"]);
    expect(await runGoal(store, goal.id, deps(fetchImpl, run.runTask, memory))).toEqual({ status: "DONE" });
    const g = store.getGoal(goal.id)!;
    expect(g).toMatchObject({ status: "DONE", result: "The page is drafted with rival prices in mind.", replans: 0 });
    const ledger = JSON.parse(g.ledger!);
    expect(ledger.facts).toEqual(["Launch is Monday"]);
    expect(ledger.progress.map((p: any) => [p.step, p.assignee, p.outcome, p.next])).toEqual([[1, "Analyst", "done", "continue"], [2, "Writer", "done", "finish"]]);
    const tasks = store.goalTasks(goal.id);
    expect(tasks.map(t => [t.assignee_agent_id, t.origin, t.status])).toEqual([[analyst.id, "goal", "DONE"], [writer.id, "goal", "DONE"]]);
    expect(tasks[1].body).toContain("Results so far:\nStep 1 (Analyst): Rivals charge $19-29");
    expect(store.runnableTasks()).toEqual([]);
    const note = memory.list(co.id).find(d => d.path.startsWith("notes/goal-"))!;
    expect(memory.read(co.id, note.path)).toContain("## Progress ledger");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM cost_event").get()).toEqual({ n: 4 });
  });

  it("re-plans after two steps without progress and keeps the executed steps", async () => {
    const { store, goal } = setup();
    const fetchImpl = answers(
      plan(["Writer", "Draft A"], ["Writer", "Draft B"], ["Writer", "Draft C"]),
      verdict(false, false, "continue", "draft rejected"),
      verdict(false, false, "continue", "still wrong"),
      plan(["Analyst", "Find what customers ask for"]),
      verdict(true, true, "finish"),
      "Done after re-planning.",
    );
    const run = scriptedRun(store, ["failed", "failed", "done:Customers ask for pricing"]);
    expect((await runGoal(store, goal.id, deps(fetchImpl, run.runTask))).status).toBe("DONE");
    const ledger = JSON.parse(store.getGoal(goal.id)!.ledger!);
    expect(ledger.plan.map((s: any) => s.instruction)).toEqual(["Draft A", "Draft B", "Find what customers ask for"]);
    expect(ledger.progress.map((p: any) => p.next)).toEqual(["continue", "replan", "finish"]);
    expect(store.getGoal(goal.id)!.replans).toBe(1);
  });

  it("stops as STALLED after the re-plan limit and says why; a second run picks it up again", async () => {
    const { store, goal } = setup();
    const replan = plan(["Writer", "Try again"], ["Writer", "And again"]);
    const fetchImpl = answers(plan(["Writer", "First"], ["Writer", "Second"]), ...Array.from({ length: 20 }, (_, i) => (i % 3 === 2 ? replan : verdict(false, false, "continue", "no luck"))));
    const run = scriptedRun(store, Array(30).fill("failed"));
    const r = await runGoal(store, goal.id, deps(fetchImpl, run.runTask));
    expect(r.status).toBe("STALLED");
    expect(r.note).toMatch(new RegExp(`no progress after ${MAX_REPLANS} re-plans`));
    expect(store.getGoal(goal.id)!.status).toBe("STALLED");
    expect(store.goalTasks(goal.id).length).toBeLessThanOrEqual(12);
  });

  it("waits when the manager has no model, fails on an unusable plan, and refuses a goal already done", async () => {
    const { store, goal, gm } = setup();
    store.setAgentStatus(gm.id, "error");
    expect((await runGoal(store, goal.id, deps(vi.fn(), vi.fn()))).status).toBe("WAITING");
    store.setAgentStatus(gm.id, "idle");
    expect(await runGoal(store, goal.id, deps(answers("I would rather not."), vi.fn()))).toEqual({ status: "FAILED", note: "the manager did not return a usable plan" });
    store.updateGoal(goal.id, { status: "DONE" });
    expect((await runGoal(store, goal.id, deps(vi.fn(), vi.fn()))).note).toBe("goal is DONE");
  });
});

describe("goals over the loopback API", () => {
  it("creates a goal for the manager, runs it in the background once at a time", async () => {
    const { store, co } = setup();
    let release!: () => void;
    const runGoalImpl = vi.fn(() => new Promise<{ status: string }>(r => { release = () => r({ status: "DONE" }); }));
    const token = "t".repeat(43);
    const daemon = new Daemon({ store, token, version: "test", runGoal: runGoalImpl });
    const port = await daemon.listen(0);
    closers.push(() => daemon.close());
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => {
        let data = ""; res.on("data", c => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const created = await call("POST", `/v1/companies/${co.id}/goals`, { title: "Grow signups" });
    expect(created.body.goal).toMatchObject({ title: "Grow signups", status: "OPEN" });
    expect((await call("POST", `/v1/goals/${created.body.goal.id}/run`)).status).toBe(202);
    expect((await call("POST", `/v1/goals/${created.body.goal.id}/run`)).status).toBe(409);
    release();
    await vi.waitFor(() => expect(runGoalImpl).toHaveBeenCalledTimes(1));
    expect((await call("GET", `/v1/goals/${created.body.goal.id}`)).body).toMatchObject({ goal: { id: created.body.goal.id }, tasks: [] });
    expect((await call("GET", `/v1/companies/${co.id}/goals`)).body.goals.length).toBe(2);
    const empty = store.createCompany({ name: "Empty" });
    expect((await call("POST", `/v1/companies/${empty.id}/goals`, { title: "x" })).status).toBe(400);
  });
});

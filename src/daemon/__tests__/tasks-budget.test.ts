import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { DaemonStore } from "../store";
import { Daemon } from "../server";
import { priceFor, usdFor, loadPriceOverrides } from "../pricing";
import { budgetBlock, checkBudgets, monthStart } from "../budget";
import { runTask } from "../tasks";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "gsk_test_0123456789abcdef";
const stores: DaemonStore[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); while (stores.length) stores.pop()!.close(); });

const NOW = "2026-11-15T12:00:00.000Z";
function setup(provider = "ANTHROPIC", model = "claude-sonnet-5-5") {
  const store = new DaemonStore(":memory:", () => NOW); stores.push(store);
  const co = store.createCompany({ name: "Acme" });
  const ag = store.createAgent({ companyId: co.id, name: "Writer", role: "content-social", provider, model, systemPrompt: "You write." });
  const other = store.createAgent({ companyId: co.id, name: "Analyst", role: "market-analyst", provider, model });
  return { store, co, ag, other };
}
const sse = (...chunks: unknown[]) => new Response([...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200 });

describe("pricing (FK-12)", () => {
  it("prices Anthropic from the published table, local runtimes at zero, and leaves the rest unpriced", () => {
    expect(priceFor("ANTHROPIC", "claude-opus-5-5")).toEqual({ inputPerM: 4, outputPerM: 20 });
    expect(priceFor("ANTHROPIC", "claude-sonnet-4-5-20250929")).toEqual({ inputPerM: 3, outputPerM: 15 });
    expect(priceFor("ANTHROPIC", "claude-haiku-5-5", 100_001)).toEqual({ inputPerM: 0.5, outputPerM: 2.5 });
    expect(priceFor("OLLAMA", "qwen3:8b")).toEqual({ inputPerM: 0, outputPerM: 0 });
    expect(priceFor("GROQ", "openai/gpt-oss-120b")).toBeNull();
    expect(usdFor("ANTHROPIC", "claude-sonnet-5-5", 1_000_000, 100_000)).toBeCloseTo(3, 6);
    expect(usdFor("GROQ", "openai/gpt-oss-20b", 1000, 1000, { "GROQ/openai/gpt-oss-20b": { inputPerM: 0.1, outputPerM: 0.5 } })).toBeCloseTo(0.0006, 8);
  });

  it("reads only well-formed user overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "braavo-prices-"));
    writeFileSync(join(dir, "prices.json"), JSON.stringify({ "GROQ/openai/gpt-oss-20b": { inputPerM: 0.1, outputPerM: 0.5 }, "bad key": { inputPerM: 1, outputPerM: 1 }, "GROQ/x": { inputPerM: -1, outputPerM: 1 } }));
    expect(loadPriceOverrides(join(dir, "prices.json"))).toEqual({ "GROQ/openai/gpt-oss-20b": { inputPerM: 0.1, outputPerM: 0.5 } });
    expect(loadPriceOverrides(join(dir, "missing.json"))).toEqual({});
  });

  it("records USD on priced calls and counts unpriced ones", () => {
    const { store, co, ag } = setup();
    expect(store.recordCost({ companyId: co.id, agentId: ag.id, provider: "ANTHROPIC", model: "claude-sonnet-5-5", inputTokens: 500_000, outputTokens: 50_000 })).toBeCloseTo(1.5, 6);
    expect(store.recordCost({ companyId: co.id, agentId: ag.id, provider: "GROQ", model: "openai/gpt-oss-20b", inputTokens: 1000, outputTokens: 100 })).toBeNull();
    expect(store.spend(co.id, monthStart(NOW))).toEqual({ usd: 1.5, unpriced: 1 });
  });
});

describe("monthly budgets (plan 2.9)", () => {
  it("warns once at 80% and pauses the agent at 100%; spending stays blocked after a resume", () => {
    const { store, co, ag, other } = setup();
    store.updateAgent(ag.id, { budgetUsdMonthly: 1 });
    const notify = vi.fn();
    store.recordCost({ companyId: co.id, agentId: ag.id, provider: "ANTHROPIC", model: "x", inputTokens: 0, outputTokens: 0, usd: 0.85 });
    expect(checkBudgets(store, co.id, ag.id, NOW, notify).map(e => e.level)).toEqual(["warning"]);
    expect(checkBudgets(store, co.id, ag.id, NOW, notify)).toEqual([]);   // once per month
    store.recordCost({ companyId: co.id, agentId: ag.id, provider: "ANTHROPIC", model: "x", inputTokens: 0, outputTokens: 0, usd: 0.2 });
    expect(checkBudgets(store, co.id, ag.id, NOW, notify).map(e => e.level)).toEqual(["paused"]);
    expect(store.getAgent(ag.id)!.status).toBe("paused");
    expect(store.getAgent(other.id)!.status).toBe("idle");               // an agent budget pauses only that agent
    expect(notify).toHaveBeenCalledTimes(2);
    store.setAgentStatus(ag.id, "idle");
    expect(budgetBlock(store, co.id, ag.id, NOW)).toMatch(/agent budget used: \$1\.05 of \$1\.00/);
    store.updateAgent(ag.id, { budgetUsdMonthly: 5 });
    expect(budgetBlock(store, co.id, ag.id, NOW)).toBeNull();
  });

  it("pauses every agent when the company budget is used, except agents waiting for setup", () => {
    const { store, co, ag, other } = setup();
    store.setAgentStatus(other.id, "error");
    store.setCompanyBudget(co.id, 2);
    store.recordCost({ companyId: co.id, agentId: ag.id, provider: "ANTHROPIC", model: "x", inputTokens: 0, outputTokens: 0, usd: 2.5 });
    expect(checkBudgets(store, co.id, ag.id, NOW).map(e => [e.scope, e.level])).toEqual([["company", "paused"]]);
    expect(store.getAgent(ag.id)!.status).toBe("paused");
    expect(store.getAgent(other.id)!.status).toBe("error");
    expect(budgetBlock(store, co.id, other.id, NOW)).toMatch(/company budget used/);
  });

  it("counts only this month", () => {
    const { store, co, ag } = setup();
    store.updateAgent(ag.id, { budgetUsdMonthly: 1 });
    store.db.prepare("INSERT INTO cost_event(id, company_id, agent_id, provider, model, usd, priced, at) VALUES ('old', ?, ?, 'ANTHROPIC', 'x', 5, 1, '2026-10-31T23:59:59.000Z')").run(co.id, ag.id);
    expect(budgetBlock(store, co.id, ag.id, NOW)).toBeNull();
  });
});

describe("tasks (plan 2.3)", () => {
  it("runs an assigned task on the agent's model, keeps the result and the cost", async () => {
    const { store, co, ag } = setup("GROQ", "openai/gpt-oss-20b");
    const task = store.createTask({ companyId: co.id, title: "Draft the launch post", body: "Two sentences.", assigneeAgentId: ag.id, createdBy: "user" });
    const fetchImpl = vi.fn(async () => sse({ choices: [{ delta: { content: "Launch day." }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }));
    const notify = vi.fn();
    expect(await runTask(store, task.id, { keys: { get: p => (p === "groq" ? KEY : undefined) }, fetchImpl: fetchImpl as never, notify }, () => NOW)).toEqual({ outcome: "done" });
    const done = store.getTask(task.id)!;
    expect(done).toMatchObject({ status: "DONE", result: "Launch day.", locked_by_run_id: null, ended_at: NOW });
    expect(store.messages(done.conversation_id!).map(m => m.role)).toEqual(["user", "assistant"]);
    expect(store.spend(co.id, monthStart(NOW))).toEqual({ usd: 0, unpriced: 1 });
    expect(store.getAgent(ag.id)!.status).toBe("idle");
    expect(notify).toHaveBeenCalledWith("Writer: task done", "Draft the launch post");
    expect(JSON.stringify(store.db.prepare("SELECT * FROM task").all())).not.toContain(KEY);
  });

  it("keeps a task open with a note while its agent cannot run, and never runs it twice", async () => {
    const { store, co, ag } = setup();
    const task = store.createTask({ companyId: co.id, title: "Summarise", assigneeAgentId: ag.id, createdBy: "user" });
    store.setAgentStatus(ag.id, "error");
    expect((await runTask(store, task.id, { keys: { get: () => undefined } }, () => NOW)).outcome).toBe("waiting");
    expect(store.getTask(task.id)).toMatchObject({ status: "OPEN", note: expect.stringMatching(/needs setup/) });
    store.setAgentStatus(ag.id, "idle");
    store.updateAgent(ag.id, { budgetUsdMonthly: 0 });
    expect((await runTask(store, task.id, { keys: { get: () => "k" } }, () => NOW)).outcome).toBe("waiting");
    expect(store.claimTask(task.id, "run-1")).toBe(true);
    expect(store.claimTask(task.id, "run-2")).toBe(false);
  });

  it("serves tasks and budgets over the loopback API and runs one task per tick", async () => {
    const store = new DaemonStore(":memory:");
    const co = store.createCompany({ name: "Acme" });
    const ag = store.createAgent({ companyId: co.id, name: "Writer", role: "content-social", provider: "OLLAMA", model: "qwen3:8b" });
    const ran: string[] = [];
    const daemon = new Daemon({ store, token: "t".repeat(43), version: "test", runTask: async id => { ran.push(id); store.updateTask(id, { status: "DONE", result: "ok" }); return { outcome: "done" }; } });
    const port = await daemon.listen(0);
    closers.push(async () => { await daemon.close(); store.close(); });
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${"t".repeat(43)}`, "Content-Type": "application/json" } }, res => {
        let data = ""; res.on("data", c => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
    const created = await call("POST", `/v1/companies/${co.id}/tasks`, { title: "Write it", assignee: "writer", priority: 2 });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ status: "OPEN", assignee_agent_id: ag.id, priority: 2 });
    expect((await call("POST", `/v1/companies/${co.id}/tasks`, { title: "x", assignee: "nobody" })).status).toBe(400);
    const cancel = await call("PATCH", `/v1/tasks/${created.body.task.id}`, { status: "CANCELLED" });
    expect(cancel.body.task.status).toBe("CANCELLED");
    expect((await call("PATCH", `/v1/tasks/${created.body.task.id}`, { status: "OPEN" })).body.task.status).toBe("OPEN");
    await daemon.tick();
    expect(ran).toEqual([created.body.task.id]);
    expect((await call("GET", `/v1/companies/${co.id}/tasks?status=DONE`)).body.tasks).toHaveLength(1);
    expect((await call("PATCH", `/v1/companies/${co.id}`, { monthlyBudgetUsd: 25 })).body.company.monthly_budget_usd).toBe(25);
    expect((await call("PATCH", `/v1/companies/${co.id}`, { monthlyBudgetUsd: -1 })).status).toBe(400);
    const panel = (await call("GET", `/v1/companies/${co.id}/panel`)).body;
    expect(panel.tasks).toMatchObject({ open: 0, done: 1 });
    expect(panel.month).toMatchObject({ usd: 0, unpricedCalls: 0, budgetRatio: 0 });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStore } from "../store";
import { Daemon } from "../server";
import { runTask } from "../tasks";
import { DEFAULT_ADAPTERS, loadAdapters, policyDecision, runWorkerTurn, toEvents } from "../acp";
import { ApprovalCenter, type WorkerDeps } from "../workers";

const FAKE = join(__dirname, "fixtures", "fake-acp-agent.cjs");
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); delete process.env.FAKE_ACP_SCENARIO; });

function setup(policy = "edits") {
  const store = new DaemonStore(":memory:");
  closers.push(() => store.close());
  const workdir = mkdtempSync(join(tmpdir(), "braavo-worker-"));
  writeFileSync(join(workdir, "notes.md"), "old\n");
  const co = store.createCompany({ name: "Acme" });
  const ceo = store.createAgent({ companyId: co.id, name: "GM", role: "ceo", provider: "GROQ", model: "x" });
  const worker = store.createAgent({ companyId: co.id, name: "Gemini CLI", role: "engineer", provider: "ACP", model: "gemini", engine: "gemini", reportsToAgentId: ceo.id });
  store.setWorker(worker.id, { workdir, approvalPolicy: policy });
  return { store, co, worker: store.getAgent(worker.id)!, workdir };
}
function deps(store: DaemonStore, over: Partial<WorkerDeps> & { onAsk?: (id: string) => void } = {}): WorkerDeps {
  const approvals = over.approvals ?? new ApprovalCenter(store, { timeoutMs: 2_000, onRequest: id => over.onAsk?.(id) });
  return { keys: { get: () => undefined }, adapters: { ...DEFAULT_ADAPTERS, gemini: { command: process.execPath, args: [FAKE] } }, approvals, timeoutMs: 10_000, ...over };
}

describe("approval policy (3.1)", () => {
  it("runs reads, asks for the rest, keeps edits inside the folder, and never auto-allows outside paths", () => {
    const w = "/work";
    expect(policyDecision("ask", "read", ["notes.md"], w)).toBe("allow");
    expect(policyDecision("ask", "edit", ["notes.md"], w)).toBe("ask");
    expect(policyDecision("edits", "edit", ["src/a.ts"], w)).toBe("allow");
    expect(policyDecision("edits", "edit", ["../other/a.ts"], w)).toBe("ask");
    expect(policyDecision("edits", "execute", [], w)).toBe("ask");
    expect(policyDecision("edits", "read", ["/etc/hosts"], w)).toBe("ask");
    expect(policyDecision("readonly", "search", [], w)).toBe("allow");
    expect(policyDecision("readonly", "edit", ["notes.md"], w)).toBe("reject");
    expect(policyDecision("readonly", "fetch", [], w)).toBe("reject");
  });

  it("maps ACP updates to events and reads launcher overrides", () => {
    expect(toEvents({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [{ type: "diff", path: "a.md", oldText: null, newText: "x" }, { type: "content", content: { type: "text", text: "ok" } }] }))
      .toEqual([{ kind: "diff", id: "t", path: "a.md", oldText: null, newText: "x" }, { kind: "tool_update", id: "t", status: "completed", text: "ok" }]);
    expect(toEvents({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })).toEqual([]);
    expect(toEvents(null)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "braavo-adapters-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ codex: { command: "/opt/codex-acp", args: ["--x"] }, gemini: { command: 5 } }));
    expect(loadAdapters(join(dir, "a.json"))).toMatchObject({ codex: { command: "/opt/codex-acp", args: ["--x"] }, gemini: DEFAULT_ADAPTERS.gemini });
  });
});

describe("CLI employee tasks over ACP", () => {
  it("runs the task in its folder, records plan/tool/diff/approval events, asks the user for a command, refuses outside reads on timeout", async () => {
    const { store, co, worker, workdir } = setup("edits");
    const task = store.createTask({ companyId: co.id, title: "Update the notes", assigneeAgentId: worker.id, createdBy: "user" });
    let approvals!: ApprovalCenter;
    const asked: string[] = [];
    approvals = new ApprovalCenter(store, {
      timeoutMs: 300,
      onRequest: id => {
        asked.push(id);
        // The user rejects the shell command; the outside read is left to time out.
        if (store.getApproval(id)!.tool === "execute") setTimeout(() => approvals.decide(id, "reject"), 20);
      },
    });
    const result = await runTask(store, task.id, { keys: { get: () => undefined }, worker: deps(store, { approvals, context: () => "Company memory: be brief." }) });
    expect(result).toEqual({ outcome: "done" });
    const done = store.getTask(task.id)!;
    expect(done).toMatchObject({ status: "DONE", result: "Done: notes updated; outside read refused." });
    const kinds = store.taskEvents(task.id).map(e => e.kind);
    expect(kinds).toEqual(["plan", "tool_call", "permission", "tool_call", "diff", "tool_update", "permission", "tool_update", "permission", "message"]);
    const permissions = store.taskEvents(task.id).filter(e => e.kind === "permission").map(e => e.data as { tool: string; decision: string; by: string });
    expect(permissions).toEqual([
      expect.objectContaining({ tool: "edit", decision: "allow", by: "policy" }),
      expect.objectContaining({ tool: "execute", decision: "reject", by: "user" }),
      expect.objectContaining({ tool: "read", decision: "reject", by: "timeout" }),
    ]);
    expect(store.taskEvents(task.id).find(e => e.kind === "diff")!.data).toMatchObject({ path: "notes.md", oldText: "old", newText: "new line\nsecond" });
    expect(asked.map(id => store.getApproval(id)!.status)).toEqual(["rejected", "expired"]);
    expect(store.spend(co.id, "2000-01-01T00:00:00Z")).toEqual({ usd: 0, unpriced: 1 });
    expect(store.getAgent(worker.id)!.status).toBe("idle");
    expect(workdir).toBeTruthy();
  });

  it("asks for edits under the default policy and applies the user's allow", async () => {
    const { store, co, worker } = setup("ask");
    const task = store.createTask({ companyId: co.id, title: "Edit", assigneeAgentId: worker.id, createdBy: "user" });
    const approvals: ApprovalCenter = new ApprovalCenter(store, { timeoutMs: 300, onRequest: id => { if (store.getApproval(id)!.tool === "edit") approvals.decide(id, "allow"); } });
    await runTask(store, task.id, { keys: { get: () => undefined }, worker: deps(store, { approvals }) });
    const permissions = store.taskEvents(task.id).filter(e => e.kind === "permission").map(e => (e.data as { tool: string; by: string; decision: string }));
    expect(permissions[0]).toMatchObject({ tool: "edit", decision: "allow", by: "user" });
    expect(store.taskEvents(task.id).some(e => e.kind === "diff")).toBe(true);
  });

  it("waits without spawning when the folder is missing or the budget is used, and fails cleanly when the CLI crashes", async () => {
    const { store, co, worker } = setup();
    const turn = vi.fn(runWorkerTurn);
    const t1 = store.createTask({ companyId: co.id, title: "x", assigneeAgentId: worker.id, createdBy: "user" });
    store.setWorker(worker.id, { workdir: null });
    expect((await runTask(store, t1.id, { keys: { get: () => undefined }, worker: deps(store, { turn }) })).note).toMatch(/needs a working folder/);
    store.setWorker(worker.id, { workdir: mkdtempSync(join(tmpdir(), "braavo-w2-")) });
    store.updateAgent(worker.id, { budgetUsdMonthly: 0 });
    expect((await runTask(store, t1.id, { keys: { get: () => undefined }, worker: deps(store, { turn }) })).note).toMatch(/budget used/);
    expect(turn).not.toHaveBeenCalled();
    store.updateAgent(worker.id, { budgetUsdMonthly: null });
    process.env.FAKE_ACP_SCENARIO = "crash";
    const crashed = await runTask(store, t1.id, { keys: { get: () => undefined }, worker: deps(store) });
    expect(crashed.outcome).toBe("failed");
    expect(store.getTask(t1.id)).toMatchObject({ status: "FAILED", note: expect.stringMatching(/exited \(3\).*prompt received/) });
  });

  it("cancels a silent agent at the time limit", async () => {
    process.env.FAKE_ACP_SCENARIO = "silent";
    const dir = mkdtempSync(join(tmpdir(), "braavo-w3-"));
    const r = await runWorkerTurn({ command: process.execPath, args: [FAKE], cwd: dir, prompt: "hi", policy: "ask", onEvent: () => {}, ask: async () => ({ decision: "reject", by: "timeout" }), timeoutMs: 300 });
    expect(r.stopReason).toBe("error");
    expect(r.error).toMatch(/exited/);
  });

  it("signs in with the CLI's cached method when the agent asks, and explains when none is configured", async () => {
    process.env.FAKE_ACP_SCENARIO = "auth";
    const dir = mkdtempSync(join(tmpdir(), "braavo-w4-"));
    const base = { command: process.execPath, args: [FAKE], cwd: dir, prompt: "hi", policy: "edits" as const, onEvent: () => {}, ask: async () => ({ decision: "reject" as const, by: "timeout" as const }), timeoutMs: 5_000 };
    const signed = await runWorkerTurn({ ...base, authMethod: "oauth-personal" });
    expect(signed.error).toBeUndefined();
    expect(signed.text).toMatch(/^Done: notes updated/);
    const unsigned = await runWorkerTurn(base);
    expect(unsigned.error).toMatch(/Authentication required — sign in with the CLI once/);
  });

  it("closes approvals left pending by a previous daemon", () => {
    const { store, co, worker } = setup();
    const id = store.createApproval({ companyId: co.id, agentId: worker.id, taskId: null, title: "x", tool: "execute", paths: [] });
    new ApprovalCenter(store);
    expect(store.getApproval(id)).toMatchObject({ status: "expired", decided_by: "restart" });
  });
});

describe("CLI employees over the loopback API", () => {
  it("hires a worker, refuses bad input, serves events and approvals", async () => {
    const { store, co, workdir } = setup();
    const approvals = new ApprovalCenter(store, { timeoutMs: 60_000 });
    const token = "t".repeat(43);
    const daemon = new Daemon({ store, token, version: "test", approvals });
    const port = await daemon.listen(0);
    closers.push(() => daemon.close());
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => {
        let data = ""; res.on("data", c => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    expect((await call("POST", `/v1/companies/${co.id}/workers`, { engine: "cursor", workdir })).status).toBe(400);
    expect((await call("POST", `/v1/companies/${co.id}/workers`, { engine: "codex", workdir: "relative/dir" })).status).toBe(400);
    expect((await call("POST", `/v1/companies/${co.id}/workers`, { engine: "codex", workdir, approvalPolicy: "yolo" })).status).toBe(400);
    const hired = await call("POST", `/v1/companies/${co.id}/workers`, { engine: "codex", workdir, approvalPolicy: "readonly" });
    expect(hired.body.agent).toMatchObject({ name: "Codex", engine: "codex", workdir, approval_policy: "readonly", status: "idle" });
    expect((await call("PATCH", `/v1/agents/${hired.body.agent.id}`, { model: "gpt-x" })).status).toBe(400);
    expect((await call("PATCH", `/v1/agents/${hired.body.agent.id}`, { approvalPolicy: "edits", status: "idle" })).body.agent).toMatchObject({ approval_policy: "edits", status: "idle" });
    const panel = (await call("GET", `/v1/companies/${co.id}/panel`)).body;
    expect(panel.agents.find((a: any) => a.id === hired.body.agent.id)).toMatchObject({ engine: "codex", approvalPolicy: "edits", workdir });

    const task = store.createTask({ companyId: co.id, title: "x", assigneeAgentId: hired.body.agent.id, createdBy: "user" });
    store.addTaskEvent(task.id, "tool_call", { kind: "tool_call", title: "Read" });
    expect((await call("GET", `/v1/tasks/${task.id}/events`)).body.events).toMatchObject([{ seq: 1, kind: "tool_call", data: { title: "Read" } }]);
    const waiting = approvals.ask(store.getAgent(hired.body.agent.id)!, task.id, { id: "t9", title: "npm test", tool: "execute", paths: [] });
    const [pending] = (await call("GET", `/v1/companies/${co.id}/approvals?status=pending`)).body.approvals;
    expect(pending).toMatchObject({ title: "npm test", tool: "execute", paths: [] });
    expect((await call("POST", `/v1/approvals/${pending.id}`, { decision: "maybe" })).status).toBe(400);
    expect((await call("POST", `/v1/approvals/${pending.id}`, { decision: "allow" })).body.approval.status).toBe("allowed");
    expect(await waiting).toEqual({ decision: "allow", by: "user" });
    expect((await call("POST", `/v1/approvals/${pending.id}`, { decision: "reject" })).status).toBe(409);
  });
});

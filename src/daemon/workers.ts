import { randomUUID } from "node:crypto";
import type { AgentRow, DaemonStore, TaskRow } from "./store";
import { budgetBlock } from "./budget";
import { isWorkerEngine, runWorkerTurn, type ApprovalPolicy, type PermissionRequest, type WorkerEngine, type WorkerEvent, type WorkerTurn } from "./acp";
import type { TaskRunResult } from "./tasks";
import type { RunnerDeps } from "./runner";

/**
 * Approvals for CLI employees (plan 3.1). A permission the policy cannot settle becomes a
 * pending approval: stored, announced (event + notification), and waited on until the user
 * decides in the panel, the phone or `braavo company approve`, or until it times out to a
 * reject. Pending approvals from before a daemon restart can no longer be answered, so
 * they are closed as expired at start.
 */
export class ApprovalCenter {
  private waiters = new Map<string, (d: "allow" | "reject", by: "user" | "timeout") => void>();

  constructor(
    private readonly store: DaemonStore,
    private readonly o: { timeoutMs?: number; onRequest?: (approvalId: string, companyId: string) => void; notify?: (title: string, body: string) => void } = {},
  ) {
    this.store.db.prepare("UPDATE approval SET status = 'expired', decided_at = ?, decided_by = 'restart' WHERE status = 'pending'").run(new Date().toISOString());
  }

  ask(agent: AgentRow, taskId: string | null, req: PermissionRequest): Promise<{ decision: "allow" | "reject"; by: "user" | "timeout" }> {
    const id = this.store.createApproval({ companyId: agent.company_id, agentId: agent.id, taskId, title: req.title, tool: req.tool, paths: req.paths });
    this.store.activity({ companyId: agent.company_id, actor: agent.id, verb: "approval-requested", objectType: "approval", objectId: id, summary: `${agent.name}: ${req.tool} · ${req.title}`.slice(0, 200) });
    // The waiter exists before anyone hears of the approval, so even an instant answer lands.
    const answer = new Promise<{ decision: "allow" | "reject"; by: "user" | "timeout" }>(resolve => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        if (this.store.decideApproval(id, "expired", "timeout")) resolve({ decision: "reject", by: "timeout" });
      }, this.o.timeoutMs ?? 10 * 60_000);
      timer.unref?.();
      this.waiters.set(id, (d) => { clearTimeout(timer); resolve({ decision: d, by: "user" }); });
    });
    try { this.o.notify?.(`${agent.name} asks for approval`, `${req.tool}: ${req.title}`.slice(0, 200)); } catch { /* best effort */ }
    this.o.onRequest?.(id, agent.company_id);
    return answer;
  }

  /** The user's answer; false when the approval is unknown or already settled. */
  decide(id: string, decision: "allow" | "reject", by = "user"): boolean {
    if (!this.store.decideApproval(id, decision === "allow" ? "allowed" : "rejected", by)) return false;
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    w?.(decision, "user");
    return true;
  }
}

export interface WorkerDeps extends RunnerDeps {
  adapters: Record<WorkerEngine, import("./acp").Adapter>;
  approvals: ApprovalCenter;
  /** Memory snapshot and skills, as the native runner gives them (optional). */
  context?: (agent: AgentRow, task: TaskRow) => Promise<string> | string;
  turn?: typeof runWorkerTurn;
  timeoutMs?: number;
  onEvent?: (taskId: string, event: WorkerEvent) => void;
}

const MAX_RESULT = 20_000;

/** A task for a CLI employee: one ACP prompt in its working folder, events recorded as they come. */
export async function runWorkerTask(store: DaemonStore, task: TaskRow, agent: AgentRow, deps: WorkerDeps, now: () => string = () => new Date().toISOString()): Promise<TaskRunResult> {
  const wait = (note: string): TaskRunResult => { store.updateTask(task.id, { note }); return { outcome: "waiting", note }; };
  if (!isWorkerEngine(agent.engine)) return wait(`unknown engine ${agent.engine}`);
  if (!agent.workdir) return wait(`${agent.name} needs a working folder (braavo company set ${agent.name} --workdir <path>)`);
  const blocked = budgetBlock(store, task.company_id, agent.id, now());
  if (blocked) return wait(blocked);

  const runId = `tr_${randomUUID()}`;
  if (!store.claimTask(task.id, runId)) return { outcome: "skipped", note: "already claimed" };
  store.setAgentStatus(agent.id, "running");
  const adapter = deps.adapters[agent.engine];
  let prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;
  try {
    const context = (await deps.context?.(agent, task))?.trim();
    if (context) prompt = `${context}\n\n---\n\nTask: ${prompt}`;
  } catch { /* context is optional */ }
  let message = "";
  const record = (e: WorkerEvent) => {
    // Message chunks are joined into one "message" event at the end; the rest are kept as they come.
    if (e.kind === "message") { message += e.text; return; }
    store.addTaskEvent(task.id, e.kind, e);
    deps.onEvent?.(task.id, e);
  };
  try {
    const result = await (deps.turn ?? runWorkerTurn)({
      command: adapter.command, args: adapter.args, authMethod: adapter.authMethod, cwd: agent.workdir, prompt, onEvent: record,
      policy: (agent.approval_policy as ApprovalPolicy) || "ask",
      ask: req => deps.approvals.ask(agent, task.id, req),
      timeoutMs: deps.timeoutMs,
    } satisfies WorkerTurn);
    if (message.trim()) store.addTaskEvent(task.id, "message", { kind: "message", text: message.trim().slice(0, 8_000) });
    // The vendor bills the user's own plan; the daemon records the run without a price (unpriced call).
    store.recordCost({ companyId: task.company_id, agentId: agent.id, runId, provider: `ACP:${agent.engine}`, model: agent.engine, inputTokens: 0, outputTokens: 0 });
    const text = (result.text || message).trim();
    const done = !result.error && result.stopReason !== "refusal" && result.stopReason !== "cancelled" && text.length > 0;
    const note = result.error ?? (done ? (result.stopReason === "max_tokens" ? "answer cut at the token limit" : null) : `stopped: ${result.stopReason}`);
    store.updateTask(task.id, { status: done ? "DONE" : "FAILED", result: text ? text.slice(0, MAX_RESULT) : null, note, endedAt: now(), lockedByRunId: null });
    store.activity({ companyId: task.company_id, actor: agent.id, verb: done ? "task-done" : "task-failed", objectType: "task", objectId: task.id, summary: task.title.slice(0, 120) });
    if (done) {
      deps.memory?.journal(agent.id, task.title, text, now());
      try { deps.notify?.(`${agent.name}: task done`, task.title.slice(0, 120)); } catch { /* best effort */ }
    }
    return done ? { outcome: "done" } : { outcome: "failed", note: note ?? undefined };
  } catch (error) {
    const note = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    store.updateTask(task.id, { status: "FAILED", note, endedAt: now(), lockedByRunId: null });
    return { outcome: "failed", note };
  } finally {
    if (store.getAgent(agent.id)?.status === "running") store.setAgentStatus(agent.id, "idle");
  }
}

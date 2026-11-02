import { randomUUID } from "node:crypto";
import type { DaemonStore } from "./store";
import { budgetBlock, checkBudgets } from "./budget";
import { collectStream } from "../core/stream";
import { DEFAULT_INFERENCE_TIMEOUT_MS } from "../forge/request-scope";
import { prepareCall, redact } from "./provider";
import type { RunnerDeps } from "./runner";
import { withMemory } from "./memory";
import { UNTRUSTED_NOTE, untrusted, urlsIn } from "./browse";

/**
 * Tasks (plan 2.3): one-off work for one agent, outside routines and pipelines.
 *
 * A task is OPEN until a run claims it atomically (locked_by_run_id), then RUNNING, then
 * DONE (result kept, conversation recorded) or FAILED (note says why). A task whose agent
 * cannot run yet — paused, in setup, over budget — stays OPEN with a note, so it runs once
 * the cause is fixed. The daemon tick runs at most one task at a time.
 *
 * With company memory (plan 4.1–4.3) the run sees a fresh snapshot of the agent's scope
 * tree plus the notes that match the task, and a finished task is appended to the agent's
 * journal so later runs can find it.
 */

const MAX_RESULT = 20_000;

export interface TaskRunResult { outcome: "done" | "failed" | "waiting" | "skipped"; note?: string }

export async function runTask(store: DaemonStore, taskId: string, deps: RunnerDeps, now: () => string = () => new Date().toISOString()): Promise<TaskRunResult> {
  const task = store.getTask(taskId);
  if (!task) return { outcome: "failed", note: "task not found" };
  if (task.status !== "OPEN") return { outcome: "skipped", note: `task is ${task.status}` };
  const agent = task.assignee_agent_id ? store.getAgent(task.assignee_agent_id) : undefined;
  const wait = (note: string): TaskRunResult => { store.updateTask(task.id, { note }); return { outcome: "waiting", note }; };
  if (!agent) return wait("no agent assigned");
  if (agent.status === "paused") return wait(`${agent.name} is paused`);
  if (agent.status === "error") return wait(`${agent.name} needs setup: add a key or pull a local model (braavo setup)`);
  const blocked = budgetBlock(store, task.company_id, agent.id, now());
  if (blocked) return wait(blocked);
  const call = prepareCall({ provider: agent.provider, model: agent.model, effort: agent.effort, effortRounding: agent.effort_rounding }, deps);
  if (!call.ok) return wait(call.message);

  const runId = `tr_${randomUUID()}`;
  if (!store.claimTask(task.id, runId)) return { outcome: "skipped", note: "already claimed" };
  store.setAgentStatus(agent.id, "running");
  let prompt = task.body ? `${task.title}\n\n${task.body}` : task.title;
  try {
    // Plan 5.1: pages the task links to are read under the browser policy and fenced as untrusted.
    if (deps.browser) {
      const pages: string[] = [];
      for (const url of urlsIn(prompt)) {
        try { pages.push(untrusted(await deps.browser.read(url))); }
        catch (error) { pages.push(`(not read: ${url} — ${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`); }
      }
      if (pages.length) prompt = `${prompt}\n\n${UNTRUSTED_NOTE}\n\n${pages.join("\n\n")}`;
    }
    let snapshot = ""; let related: ReturnType<NonNullable<RunnerDeps["memory"]>["search"]> = []; let skills = "";
    try { skills = deps.skills?.promptFor(store.agentSkills(agent.id)) ?? ""; } catch { /* a broken skill folder must not fail the task */ }
    try {
      snapshot = deps.memory?.snapshot(agent.id) ?? "";
      related = deps.memory?.search(task.company_id, `${task.title} ${task.body}`.slice(0, 500), { limit: 3, any: true }) ?? [];
    } catch { /* memory is context, never a reason to fail the task */ }
    const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS);
    const result = await collectStream(call.stream({ system: withMemory(agent.system_prompt, snapshot, related, skills), messages: [{ role: "user", content: prompt }] }, signal));
    const conversationId = store.createConversation({ companyId: task.company_id, agentId: agent.id, title: task.title.slice(0, 120), provider: agent.provider, model: agent.model, memorySnapshot: snapshot, skillsSnapshot: skills });
    store.addMessage(conversationId, "user", prompt);
    if (result.text) store.addMessage(conversationId, "assistant", result.text, { stopReason: result.stopReason });
    store.recordCost({ companyId: task.company_id, agentId: agent.id, runId, provider: agent.provider, model: agent.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    const text = result.text.trim();
    const done = text.length > 0;
    store.updateTask(task.id, {
      status: done ? "DONE" : "FAILED", result: done ? text.slice(0, MAX_RESULT) : null,
      note: done ? (result.stopReason === "max_tokens" ? "answer cut at the token limit" : null) : `empty answer (${result.stopReason})`,
      conversationId, endedAt: now(), lockedByRunId: null,
    });
    store.activity({ companyId: task.company_id, actor: agent.id, verb: done ? "task-done" : "task-failed", objectType: "task", objectId: task.id, summary: task.title.slice(0, 120) });
    if (done) deps.memory?.journal(agent.id, task.title, text, now());
    try { if (done) deps.notify?.(`${agent.name}: task done`, task.title.slice(0, 120)); } catch { /* best effort */ }
    checkBudgets(store, task.company_id, agent.id, now(), deps.notify);
    return done ? { outcome: "done" } : { outcome: "failed", note: "empty answer" };
  } catch (error) {
    const note = redact(error instanceof Error ? error.message : String(error), call.apiKey, 200);
    store.updateTask(task.id, { status: "FAILED", note, endedAt: now(), lockedByRunId: null });
    store.activity({ companyId: task.company_id, actor: agent.id, verb: "task-failed", objectType: "task", objectId: task.id, summary: task.title.slice(0, 120) });
    return { outcome: "failed", note };
  } finally {
    if (store.getAgent(agent.id)?.status === "running") store.setAgentStatus(agent.id, "idle");
  }
}

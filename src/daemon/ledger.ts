import { randomUUID } from "node:crypto";
import type { AgentRow, DaemonStore, GoalRow } from "./store";
import type { CompanyMemory } from "./memory";
import { budgetBlock } from "./budget";
import { collectStream } from "../core/stream";
import { DEFAULT_INFERENCE_TIMEOUT_MS } from "../forge/request-scope";
import { prepareCall, type ProviderDeps } from "./provider";

/**
 * The manager's ledger (plan 4.5, Magentic-One's orchestrator pattern).
 *
 * A goal goes to the company's manager (the General Manager). The manager keeps two
 * ledgers:
 * - Task ledger: facts it was given, assumptions it makes, and the plan — steps, each
 *   with an assignee from the team and an instruction.
 * - Progress ledger: after every step, whether the goal is done, whether the work is
 *   moving, and what comes next.
 * Steps run as ordinary tasks (budgets, approvals and CLI employees apply). When two
 * steps in a row make no progress — failed, waiting, or judged as not moving — the
 * manager re-plans from what it learned; after MAX_REPLANS it stops as STALLED and says
 * why. Every change is mirrored to `notes/goal-<id>.md` in company memory, so the
 * ledger can be read (and searched) like any note.
 */

export const MAX_STEPS = 12;
export const MAX_REPLANS = 3;
export const STALL_LIMIT = 2;

export interface PlanStep { assignee: string; instruction: string }
export interface TaskLedger { facts: string[]; assumptions: string[]; plan: PlanStep[] }
export interface ProgressEntry {
  at: string; step: number; assignee: string; taskId: string | null; outcome: string;
  done: boolean; progressing: boolean; next: "continue" | "replan" | "finish"; reason: string;
}
export interface Ledger extends TaskLedger { progress: ProgressEntry[]; stalls: number }

export const emptyLedger = (): Ledger => ({ facts: [], assumptions: [], plan: [], progress: [], stalls: 0 });

/** The first {...} block of a model answer (fenced or not); null when there is none or it does not parse. */
export function parseJsonBlock(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{"); const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(fenced.slice(start, end + 1)); } catch { return null; }
}

const strings = (v: unknown, n = 20) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map(x => x.trim().slice(0, 400)).slice(0, n) : []);

/** A plan answer → task ledger; steps whose assignee is not on the team go to the manager. */
export function toTaskLedger(raw: any, team: AgentRow[], manager: AgentRow): TaskLedger | null {
  if (!raw || !Array.isArray(raw.plan)) return null;
  const byName = (name: unknown) => {
    const key = String(name ?? "").trim().toLowerCase();
    return team.find(a => a.name.toLowerCase() === key || a.role === key || a.id === key) ?? manager;
  };
  const plan = raw.plan
    .filter((s: any) => s && typeof s.instruction === "string" && s.instruction.trim())
    .slice(0, MAX_STEPS)
    .map((s: any) => ({ assignee: byName(s.assignee).name, instruction: s.instruction.trim().slice(0, 2_000) }));
  return plan.length ? { facts: strings(raw.facts), assumptions: strings(raw.assumptions), plan } : null;
}

export function teamRoster(team: AgentRow[], skills: (id: string) => string[] = () => []): string {
  return team.map(a => `- ${a.name} (${a.role}${a.engine !== "native" ? `, CLI employee: ${a.engine}` : ""}${skills(a.id).length ? `; skills: ${skills(a.id).join(", ")}` : ""})${a.status === "paused" ? " — paused" : a.status === "error" ? " — needs setup" : ""}`).join("\n");
}

const PLAN_SYSTEM = `You are the company's manager. Plan how your team reaches the goal.
Answer with one JSON object only:
{"facts": ["what the goal and context state"], "assumptions": ["educated guesses you rely on"],
 "plan": [{"assignee": "<team member name>", "instruction": "<one concrete, checkable step>"}]}
Use at most ${MAX_STEPS} steps, only team members listed, and prefer members whose role fits. Keep instructions self-contained: the member sees only the instruction and the results of earlier steps.`;

const PROGRESS_SYSTEM = `You are the company's manager reviewing the latest step of a plan.
Answer with one JSON object only:
{"done": <true if the whole goal is now met>, "progressing": <true if this step moved the goal forward>,
 "next": "continue" | "replan" | "finish", "reason": "<one sentence>"}
Choose "replan" when the plan no longer fits what you learned; "finish" when the goal is met or cannot be met.`;

const REPLAN_SYSTEM = `${PLAN_SYSTEM}
You are re-planning: update the facts with what the steps so far established, drop what failed, and plan only the remaining work.`;

const FINAL_SYSTEM = `You are the company's manager. Write the final result of the goal for the user from the step results: what was done, the outcome, and anything left open. Plain language, the goal's language, at most 300 words.`;

export function ledgerMarkdown(goal: { id: string; title: string; status: string }, l: Ledger, result?: string | null): string {
  const lines = [`# Goal: ${goal.title}`, "", `Status: ${goal.status} · ${goal.id}`, "", "## Task ledger", "", "### Facts", ...(l.facts.length ? l.facts.map(f => `- ${f}`) : ["- —"]),
    "", "### Assumptions", ...(l.assumptions.length ? l.assumptions.map(f => `- ${f}`) : ["- —"]), "", "### Plan",
    ...l.plan.map((s, i) => `${i + 1}. **${s.assignee}** — ${s.instruction}`), "", "## Progress ledger", "",
    ...(l.progress.length ? l.progress.map(p => `- ${p.at.slice(0, 16).replace("T", " ")} · step ${p.step} · ${p.assignee} · ${p.outcome} · ${p.done ? "done" : p.progressing ? "progressing" : "not progressing"} → ${p.next}: ${p.reason}`) : ["- —"])];
  if (result) lines.push("", "## Result", "", result);
  return `${lines.join("\n")}\n`;
}

export interface LedgerDeps extends ProviderDeps {
  /** Run one task through the daemon's own runner (native agents and CLI employees). */
  runTask(taskId: string): Promise<{ outcome: string; note?: string }>;
  memory?: CompanyMemory;
  skills?: (agentId: string) => string[];
  notify?: (title: string, body: string) => void;
  timeoutMs?: number;
  now?: () => string;
  onChange?: (goalId: string) => void;
}

export interface GoalRunResult { status: string; note?: string }

/** Drive one goal to DONE, FAILED or STALLED. Safe to call again on a STALLED or WAITING goal. */
export async function runGoal(store: DaemonStore, goalId: string, deps: LedgerDeps): Promise<GoalRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const goal = store.getGoal(goalId);
  if (!goal) return { status: "FAILED", note: "goal not found" };
  if (goal.status === "DONE" || goal.status === "RUNNING") return { status: goal.status, note: `goal is ${goal.status}` };
  const manager = store.getAgent(goal.manager_agent_id);
  if (!manager) return save(goal, emptyLedger(), "FAILED", "the manager is gone");
  const team = store.listAgents(goal.company_id).filter(a => a.status !== "paused");
  const wait = (note: string) => { store.updateGoal(goal.id, { status: "WAITING", note }); deps.onChange?.(goal.id); return { status: "WAITING", note }; };
  if (manager.engine !== "native" || manager.status === "error") return wait(`${manager.name} needs a model to manage goals (braavo setup)`);
  const blocked = budgetBlock(store, goal.company_id, manager.id, now());
  if (blocked) return wait(blocked);
  const call = prepareCall({ provider: manager.provider, model: manager.model, effort: manager.effort, effortRounding: manager.effort_rounding }, deps);
  if (!call.ok) return wait(call.message);

  const ask = async (system: string, user: string) => {
    const r = await collectStream(call.stream({ system, messages: [{ role: "user", content: user }] }, AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS)));
    store.recordCost({ companyId: goal.company_id, agentId: manager.id, runId: goal.id, provider: manager.provider, model: manager.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    return r.text;
  };
  function save(g: GoalRow, l: Ledger, status: string, note: string | null, result?: string | null): GoalRunResult {
    store.updateGoal(g.id, { status, ledger: JSON.stringify(l), note, ...(result !== undefined ? { result } : {}), replans: l.progress.filter(p => p.next === "replan").length });
    try { deps.memory?.write(g.company_id, `notes/goal-${g.id.replace(/^gl_/, "").slice(0, 8)}.md`, ledgerMarkdown({ id: g.id, title: g.title, status }, l, result), manager?.id ?? "manager"); } catch { /* memory is a mirror */ }
    deps.onChange?.(g.id);
    return { status, ...(note ? { note } : {}) };
  }

  let ledger: Ledger = goal.ledger ? { ...emptyLedger(), ...JSON.parse(goal.ledger) } : emptyLedger();
  store.updateGoal(goal.id, { status: "RUNNING", note: null });
  deps.onChange?.(goal.id);
  const brief = `Goal: ${goal.title}${goal.body ? `\n\n${goal.body}` : ""}\n\nTeam:\n${teamRoster(team, deps.skills)}`;
  const results: string[] = ledger.progress.filter(p => p.taskId).map(p => {
    const t = store.getTask(p.taskId!); return t?.result ? `Step ${p.step} (${p.assignee}): ${t.result.slice(0, 1_500)}` : "";
  }).filter(Boolean);

  try {
    if (!ledger.plan.length || goal.status === "STALLED") {
      const raw = parseJsonBlock(await ask(ledger.plan.length ? REPLAN_SYSTEM : PLAN_SYSTEM, ledger.plan.length ? `${brief}\n\nLedger so far:\n${ledgerMarkdown(goal, ledger)}` : brief));
      const planned = toTaskLedger(raw, team, manager);
      if (!planned) return save(goal, ledger, "FAILED", "the manager did not return a usable plan");
      ledger = { ...ledger, ...planned, stalls: 0 };
      save(goal, ledger, "RUNNING", null);
    }

    let step = ledger.progress.length;
    let replans = ledger.progress.filter(p => p.next === "replan").length;
    while (step < MAX_STEPS) {
      // Each executed step used one plan item; a re-plan keeps the executed prefix.
      const pending = ledger.plan[step];
      if (!pending) break;
      const assignee = team.find(a => a.name === pending.assignee) ?? manager;
      const task = store.createTask({
        companyId: goal.company_id, title: pending.instruction.split("\n")[0].slice(0, 200), createdBy: manager.id, origin: "goal",
        assigneeAgentId: assignee.id,
        body: `${pending.instruction}\n\nPart of the goal: ${goal.title}${results.length ? `\n\nResults so far:\n${results.join("\n\n").slice(-6_000)}` : ""}`,
      });
      store.setTaskGoal(task.id, goal.id);
      const run = await deps.runTask(task.id);
      const finished = store.getTask(task.id)!;
      if (finished.result) results.push(`Step ${step + 1} (${assignee.name}): ${finished.result.slice(0, 1_500)}`);
      const verdict = parseJsonBlock(await ask(PROGRESS_SYSTEM, `${brief}\n\nPlan:\n${ledger.plan.map((s, i) => `${i + 1}. ${s.assignee}: ${s.instruction}`).join("\n")}\n\nLatest step ${step + 1} by ${assignee.name} — ${run.outcome}${run.note ? ` (${run.note})` : ""}:\n${finished.result?.slice(0, 4_000) ?? "(no result)"}`)) ?? {};
      const failedStep = run.outcome !== "done";
      const entry: ProgressEntry = {
        at: now(), step: step + 1, assignee: assignee.name, taskId: task.id, outcome: run.outcome,
        done: verdict.done === true && !failedStep, progressing: verdict.progressing !== false && !failedStep,
        next: verdict.next === "finish" || verdict.next === "replan" ? verdict.next : "continue",
        reason: typeof verdict.reason === "string" ? verdict.reason.slice(0, 300) : failedStep ? `step ${run.outcome}${run.note ? `: ${run.note}` : ""}` : "no assessment",
      };
      ledger.progress.push(entry);
      ledger.stalls = entry.progressing ? 0 : ledger.stalls + 1;
      step += 1;
      if (entry.done || entry.next === "finish") break;
      if (ledger.stalls >= STALL_LIMIT || entry.next === "replan") {
        if (replans >= MAX_REPLANS) return save(goal, ledger, "STALLED", `no progress after ${replans} re-plans: ${entry.reason}`);
        replans += 1;
        entry.next = "replan";
        const raw = parseJsonBlock(await ask(REPLAN_SYSTEM, `${brief}\n\nLedger so far:\n${ledgerMarkdown(goal, ledger)}\n\nStep results:\n${results.join("\n\n").slice(-8_000)}`));
        const replanned = toTaskLedger(raw, team, manager);
        if (!replanned) return save(goal, ledger, "STALLED", "re-planning did not return a usable plan");
        // The done steps stay in the progress ledger; the new plan continues after them.
        ledger = { ...ledger, facts: replanned.facts.length ? replanned.facts : ledger.facts, assumptions: replanned.assumptions, plan: [...ledger.plan.slice(0, step), ...replanned.plan].slice(0, MAX_STEPS), stalls: 0 };
      }
      save(goal, ledger, "RUNNING", null);
    }

    const final = (await ask(FINAL_SYSTEM, `${brief}\n\nStep results:\n${results.join("\n\n").slice(-12_000) || "(none)"}`)).trim();
    const met = ledger.progress.some(p => p.done) || (ledger.progress.length > 0 && ledger.progress.every(p => p.outcome === "done"));
    const status = met ? "DONE" : "FAILED";
    try { deps.notify?.(`${manager.name}: goal ${met ? "done" : "ended"}`, goal.title.slice(0, 120)); } catch { /* best effort */ }
    store.activity({ companyId: goal.company_id, actor: manager.id, verb: met ? "goal-done" : "goal-failed", objectType: "goal", objectId: goal.id, summary: goal.title.slice(0, 120) });
    return save(goal, ledger, status, met ? null : "steps ended without meeting the goal", final || null);
  } catch (error) {
    return save(goal, ledger, "FAILED", (error instanceof Error ? error.message : String(error)).slice(0, 300));
  }
}

export const newGoalId = () => `gl_${randomUUID()}`;

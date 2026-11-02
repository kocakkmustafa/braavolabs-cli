import type { AgentRow, DaemonStore } from "./store";
import { budgetLine } from "./budget";
import { departmentOf } from "./memory";
import { hireFromTemplates, TEMPLATE_IDS, type TemplateId, type UserModels } from "../core/templates";
import { orgTree, validateOrg, type OrgNode } from "../core/company";
import { AGENT_EFFORTS } from "../core/effort";
import { isAIProvider } from "../core/providers";
import { firstFireAt } from "./scheduler";
/**
 * Company panel on the daemon (platform docs/ai-company/SIRKET-PANELI.tr.md, slice D1/D2):
 * hire the starter templates (founder decisions K1–K3), read one panel snapshot that
 * CLI, desktop and mobile all render, and change an agent's model, effort or state.
 */

export class CompanyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface HireRequest { templates?: unknown; urls?: unknown; timezone?: unknown; locale?: unknown }
export interface HireResult {
  agents: AgentRow[];
  routines: Array<{ id: string; name: string; agentId: string; rrule: string; nextFireAt: string | null }>;
  skipped: string[];
  needsSetup: Array<{ agentId: string; reason: string; provider?: string }>;
  needsUrls: string[];
}

function zone(value: unknown): string {
  const tz = typeof value === "string" && value ? value : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { throw new CompanyError(400, "unknown time zone"); }
}

/** Hire starter templates into a company; templates whose role is already staffed are skipped. */
export function hire(store: DaemonStore, companyId: string, req: HireRequest, models: UserModels, now = new Date()): HireResult {
  if (!store.getCompany(companyId)) throw new CompanyError(404, "company not found");
  const asked = req.templates === undefined || req.templates === "all" ? [...TEMPLATE_IDS] : req.templates;
  if (!Array.isArray(asked) || asked.some(t => !(TEMPLATE_IDS as readonly unknown[]).includes(t))) throw new CompanyError(400, `templates must be "all" or a list of: ${TEMPLATE_IDS.join(", ")}`);
  const urls = (req.urls && typeof req.urls === "object" ? req.urls : {}) as Record<string, string[]>;
  const timezone = zone(req.timezone);
  const locale = req.locale === "tr" ? "tr" : "en";

  const existing = new Map(store.listAgents(companyId).map(a => [a.role, a]));
  let plan;
  try { plan = hireFromTemplates({ companyId, timezone, locale, templates: asked as TemplateId[], models, urls }); }
  catch (error) { throw new CompanyError(400, `invalid hire request: ${(error as Error).message.slice(0, 200)}`); }

  const result: HireResult = { agents: [], routines: [], skipped: [], needsSetup: [], needsUrls: plan.needsUrls };
  const realId = new Map<string, string>();
  store.db.exec("BEGIN");
  try {
    for (const spec of plan.agents) {
      const staffed = existing.get(spec.role);
      if (staffed) { realId.set(spec.id, staffed.id); result.skipped.push(spec.id); continue; }
      const agent = store.createAgent({
        companyId, name: spec.name, role: spec.role, title: spec.title, systemPrompt: spec.systemPrompt, provider: spec.provider, model: spec.model,
        effort: spec.effort, effortRounding: spec.effortRounding, autonomy: spec.autonomy, heartbeatRrule: spec.heartbeatRrule, status: spec.status,
        reportsToAgentId: spec.reportsToAgentId ? realId.get(spec.reportsToAgentId) ?? null : null,
      });
      realId.set(spec.id, agent.id);
      result.agents.push(agent);
      const setup = plan.needsSetup.find(n => n.agentId === spec.id);
      if (setup) result.needsSetup.push({ ...setup, agentId: agent.id });
    }
    for (const r of plan.routines) {
      const agentId = realId.get(r.agentId)!;
      if (result.skipped.includes(r.agentId)) continue; // an already staffed role keeps its own routines
      const routine = store.createRoutine({
        companyId, agentId, name: r.name, prompt: r.prompt, rrule: r.rrule, timezone: r.timezone, createdBy: "user",
        preflight: r.preflight, delivery: r.delivery, catchUp: r.catchUp, nextFireAt: firstFireAt(r.rrule, now, r.timezone)!,
      });
      result.routines.push({ id: routine.id, name: routine.name, agentId, rrule: routine.rrule, nextFireAt: routine.next_fire_at });
    }
    store.db.exec("COMMIT");
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
  if (result.agents.length) store.activity({ companyId, actor: "user", verb: "hired-templates", objectType: "company", objectId: companyId, summary: `${result.agents.length} agents` });
  return result;
}

export interface PanelAgent {
  id: string; name: string; role: string; title: string | null; provider: string; model: string; effort: string | null; status: string;
  reportsToAgentId: string | null; budgetUsdMonthly: number | null; department: string; month: { inputTokens: number; outputTokens: number; usd: number; runs: number };
  /** Share of the agent's monthly budget used (null when it has no budget). */
  budgetRatio: number | null;
}

/** One snapshot for every surface: org tree, agents with month usage, routines with last outcome, activity. */
export function panel(store: DaemonStore, companyId: string, now = new Date()) {
  const company = store.getCompany(companyId);
  if (!company) throw new CompanyError(404, "company not found");
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const costs = new Map(store.agentCosts(companyId, monthStart).map(c => [c.agent_id, c]));
  const agents: PanelAgent[] = store.listAgents(companyId).map(a => {
    const c = costs.get(a.id);
    return {
      id: a.id, name: a.name, role: a.role, title: a.title, provider: a.provider, model: a.model, effort: a.effort, status: a.status,
      reportsToAgentId: a.reports_to_agent_id, budgetUsdMonthly: a.budget_usd_monthly, department: departmentOf(a),
      month: { inputTokens: c?.input_tokens ?? 0, outputTokens: c?.output_tokens ?? 0, usd: c?.usd ?? 0, runs: c?.runs ?? 0 },
      budgetRatio: a.budget_usd_monthly && a.budget_usd_monthly > 0 ? (c?.usd ?? 0) / a.budget_usd_monthly : a.budget_usd_monthly === 0 ? 1 : null,
    };
  });
  const last = new Map(store.lastExecutions(companyId).map(e => [e.routine_id, e]));
  const routines = store.listRoutines(companyId).map(r => ({
    id: r.id, name: r.name, agentId: r.agent_id, rrule: r.rrule, timezone: r.timezone, enabled: r.enabled === 1, nextFireAt: r.next_fire_at,
    preflight: (() => { try { return (JSON.parse(r.preflight) as { type: string }).type; } catch { return "none"; } })(),
    last: last.get(r.id) ? { at: last.get(r.id)!.fired_at, outcome: last.get(r.id)!.outcome, note: last.get(r.id)!.note } : null,
  }));
  const tree: OrgNode[] = orgTree(agents.map(a => ({ id: a.id, reportsToAgentId: a.reportsToAgentId })));
  const totals = agents.reduce((t, a) => ({ inputTokens: t.inputTokens + a.month.inputTokens, outputTokens: t.outputTokens + a.month.outputTokens, usd: t.usd + a.month.usd }), { inputTokens: 0, outputTokens: 0, usd: 0 });
  const budget = budgetLine(store, companyId, now.toISOString());
  const recent = store.listTasks(companyId, undefined, 200);
  const count = (status: string) => recent.filter(t => t.status === status).length;
  return {
    company: { id: company.id, name: company.name, mission: company.mission, status: company.status, monthlyBudgetUsd: company.monthly_budget_usd },
    agents, tree, routines, activity: store.recentActivity(companyId, 20),
    month: { since: monthStart, ...totals, unpricedCalls: budget.unpricedCalls, budgetRatio: budget.ratio === Infinity ? 1 : budget.ratio },
    tasks: {
      open: count("OPEN"), running: count("RUNNING"), done: count("DONE"), failed: count("FAILED"),
      recent: recent.slice(0, 10).map(t => ({ id: t.id, title: t.title, status: t.status, assigneeAgentId: t.assignee_agent_id, note: t.note, updatedAt: t.updated_at })),
    },
  };
}

/** Change an agent's model, effort, budget, manager, department or pause state; keeps the org valid. */
export function updateAgent(store: DaemonStore, agentId: string, body: Record<string, unknown>, canUse: (provider: string) => boolean): AgentRow {
  const agent = store.getAgent(agentId);
  if (!agent) throw new CompanyError(404, "agent not found");
  const patch: Parameters<DaemonStore["updateAgent"]>[1] = {};
  if (body.provider !== undefined || body.model !== undefined) {
    const provider = body.provider ?? agent.provider; const model = body.model ?? agent.model;
    if (!isAIProvider(provider)) throw new CompanyError(400, "unknown provider");
    if (typeof model !== "string" || !model.trim() || model.length > 200) throw new CompanyError(400, "model is required (≤200 chars)");
    patch.provider = provider; patch.model = model.trim();
  }
  if (body.effort !== undefined) {
    if (body.effort !== null && !(AGENT_EFFORTS as readonly unknown[]).includes(body.effort)) throw new CompanyError(400, "unknown effort");
    patch.effort = body.effort as string | null;
  }
  if (body.budgetUsdMonthly !== undefined) {
    if (body.budgetUsdMonthly !== null && (typeof body.budgetUsdMonthly !== "number" || body.budgetUsdMonthly < 0 || body.budgetUsdMonthly > 100_000)) throw new CompanyError(400, "budgetUsdMonthly must be 0–100000 or null");
    patch.budgetUsdMonthly = body.budgetUsdMonthly as number | null;
  }
  if (body.department !== undefined) {
    // Scope tree (plan 4.1): which department note the agent reads; null = the role's default.
    if (body.department !== null && (typeof body.department !== "string" || !/^[a-z0-9-]{1,60}$/.test(body.department))) throw new CompanyError(400, "department must be a short lower-case name (a-z, 0-9, -) or null");
    patch.department = body.department as string | null;
  }
  if (body.reportsToAgentId !== undefined) {
    const manager = body.reportsToAgentId as string | null;
    const agents = store.listAgents(agent.company_id).map(a => ({ id: a.id, companyId: a.company_id, reportsToAgentId: a.id === agentId ? manager : a.reports_to_agent_id }));
    if (validateOrg(agents).length) throw new CompanyError(400, "reportsToAgentId would break the org chart (unknown manager or a cycle)");
    patch.reportsToAgentId = manager;
  }
  // Paused stays paused until resumed; otherwise the state follows whether the model can run (design §5.4).
  const wantsPause = body.status === "paused"; const wantsResume = body.status === "idle";
  if (body.status !== undefined && !wantsPause && !wantsResume) throw new CompanyError(400, "status can be set to paused or idle");
  const provider = patch.provider ?? agent.provider;
  if (wantsPause) patch.status = "paused";
  else if (wantsResume || agent.status !== "paused") patch.status = agent.status === "running" ? "running" : canUse(provider) ? "idle" : "error";
  store.updateAgent(agentId, patch);
  store.activity({ companyId: agent.company_id, actor: "user", verb: "updated-agent", objectType: "agent", objectId: agentId, summary: agent.name });
  return store.getAgent(agentId)!;
}

/** Plain-text panel for surfaces that only show text (phone over the relay, logs). */
export function panelText(p: ReturnType<typeof panel>): string {
  const byId = new Map(p.agents.map(a => [a.id, a]));
  const pct = (r: number | null) => (r === null ? "" : ` (${Math.round(r * 100)}%)`);
  const budget = p.company.monthlyBudgetUsd !== null ? ` of $${p.company.monthlyBudgetUsd.toFixed(2)}${pct(p.month.budgetRatio)}` : "";
  const out = [
    `${p.company.name} · ${p.agents.length} agents · $${p.month.usd.toFixed(2)}${budget} · ${p.month.inputTokens}/${p.month.outputTokens} tokens this month`,
    ...(p.month.unpricedCalls ? [`${p.month.unpricedCalls} calls on unpriced models (set prices in ~/.braavo/prices.json)`] : []),
  ];
  const walk = (nodes: OrgNode[], depth: number) => nodes.forEach(n => {
    const a = byId.get(n.id)!;
    const model = a.status === "error" ? "setup needed on the computer (braavo setup)" : `${a.provider}/${a.model}`;
    const spend = a.budgetUsdMonthly !== null ? ` · $${a.month.usd.toFixed(2)}/$${a.budgetUsdMonthly.toFixed(2)}${pct(a.budgetRatio)}` : a.month.usd ? ` · $${a.month.usd.toFixed(2)}` : "";
    out.push(`${"  ".repeat(depth)}• ${a.name} — ${model} · ${a.effort ?? "default"} · ${a.status}${spend}`);
    walk(n.children, depth + 1);
  });
  walk(p.tree, 0);
  if (p.routines.length) {
    out.push("", "Routines:");
    for (const r of p.routines) out.push(`• ${r.name} — next ${r.nextFireAt?.slice(0, 16).replace("T", " ") ?? "—"} UTC${r.last ? ` · last ${r.last.outcome}` : ""}`);
  }
  if (p.tasks.open + p.tasks.running + p.tasks.done + p.tasks.failed > 0) {
    out.push("", `Tasks: ${p.tasks.open} open · ${p.tasks.running} running · ${p.tasks.done} done · ${p.tasks.failed} failed`);
    for (const t of p.tasks.recent.slice(0, 5)) out.push(`• ${t.title.slice(0, 80)} — ${t.status}${t.note ? ` · ${t.note.slice(0, 80)}` : ""}`);
  }
  return out.join("\n");
}

/** Answer a phone command against the one local company (or the first one). */
export async function companyCommand(store: DaemonStore, command: string, arg: string, deps: { run: (routineId: string) => Promise<{ outcome: string; note?: string }>; canUse: (p: string) => boolean; memoryRoot: string }): Promise<string> {
  const company = store.listCompanies()[0];
  if (!company) return "No company yet. On your computer: braavo company init <name>";
  const p = panel(store, company.id);
  const find = <T extends { name: string; id: string }>(list: T[], key: string) => list.find(x => x.id === key || x.name.toLowerCase() === key.toLowerCase() || ("role" in x && (x as unknown as { role: string }).role === key));
  switch (command) {
    case "company": return panelText(p);
    case "findings": {
      const { existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const file = join(deps.memoryRoot, company.id, "findings", `${(arg || "market-analyst").replace(/[^a-z0-9-]/gi, "")}.md`);
      const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
      return text ? text.slice(-3500) : "No findings yet.";
    }
    case "run": {
      const r = find(p.routines, arg);
      if (!r) return `error: no routine ${arg || "(name required)"}`;
      const result = await deps.run(r.id);
      return `${r.name}: ${result.outcome}${result.note ? ` · ${result.note.split(" · /")[0]}` : ""}`;
    }
    case "pause":
    case "resume": {
      const a = find(p.agents, arg);
      if (!a) return `error: no agent ${arg || "(name required)"}`;
      const updated = updateAgent(store, a.id, { status: command === "pause" ? "paused" : "idle" }, deps.canUse);
      return `${updated.name}: ${updated.status}`;
    }
    default: return "error: unknown command";
  }
}

const SNAPSHOT_STATUSES = new Set(["idle", "running", "waiting", "error", "paused"]);
const SNAPSHOT_EFFORTS = new Set(["none", "low", "medium", "high", "max"]);

/** The relay's bounded panel-snapshot (platform relay protocol): org, models, states, routines — never prompts or transcripts. */
export function panelSnapshot(p: ReturnType<typeof panel>) {
  return {
    company: { name: p.company.name.slice(0, 120) || "Company" },
    agents: p.agents.slice(0, 50).map(a => ({
      id: a.id, name: a.name.slice(0, 80), role: a.role.slice(0, 80), managerId: a.reportsToAgentId,
      model: a.status === "error" ? null : `${a.provider}/${a.model}`.slice(0, 200),
      effort: (a.effort && SNAPSHOT_EFFORTS.has(a.effort) ? a.effort : null) as "none" | "low" | "medium" | "high" | "max" | null,
      status: (SNAPSHOT_STATUSES.has(a.status) ? a.status : "idle") as "idle" | "running" | "waiting" | "error" | "paused",
      runsThisMonth: a.month.runs,
    })),
    routines: p.routines.slice(0, 50).map(r => ({
      id: r.id, name: r.name.slice(0, 120), agentId: r.agentId,
      nextFireAt: r.nextFireAt && !Number.isNaN(Date.parse(r.nextFireAt)) ? new Date(r.nextFireAt).toISOString() : null,
      lastOutcome: r.last ? r.last.outcome.slice(0, 40) : null,
    })),
    month: { inputTokens: p.month.inputTokens, outputTokens: p.month.outputTokens },
  };
}

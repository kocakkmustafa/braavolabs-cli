import type { AgentRow, DaemonStore } from "./store";
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
  reportsToAgentId: string | null; budgetUsdMonthly: number | null; month: { inputTokens: number; outputTokens: number; usd: number; runs: number };
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
      reportsToAgentId: a.reports_to_agent_id, budgetUsdMonthly: a.budget_usd_monthly,
      month: { inputTokens: c?.input_tokens ?? 0, outputTokens: c?.output_tokens ?? 0, usd: c?.usd ?? 0, runs: c?.runs ?? 0 },
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
  return {
    company: { id: company.id, name: company.name, mission: company.mission, status: company.status, monthlyBudgetUsd: company.monthly_budget_usd },
    agents, tree, routines, activity: store.recentActivity(companyId, 20), month: { since: monthStart, ...totals },
  };
}

/** Change an agent's model, effort, budget, manager or pause state; keeps the org valid. */
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

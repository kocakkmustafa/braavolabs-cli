import type { DaemonStore } from "./store";

/**
 * Monthly budgets (plan 2.9): an agent budget (agent.budget_usd_monthly) and a company
 * budget (company.monthly_budget_usd), both in USD for the calendar month (UTC).
 *
 * - 80%: one warning per month per budget — activity + notification.
 * - 100%: the agent is paused (company budget: every agent not already paused or in error);
 *   routines and tasks then skip with `skipped-budget` until the user raises the budget
 *   (resuming alone does not lift the block while the month's spend is over budget).
 *
 * Only priced spend counts (see pricing.ts); unpriced calls are reported, never guessed.
 */

export const WARN_AT = 0.8;

export function monthStart(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export interface BudgetLine { budgetUsd: number | null; spentUsd: number; unpricedCalls: number; ratio: number | null }

export function budgetLine(store: DaemonStore, companyId: string, nowIso: string, agentId?: string): BudgetLine {
  const since = monthStart(nowIso);
  const { usd, unpriced } = store.spend(companyId, since, agentId);
  const budget = agentId ? store.getAgent(agentId)?.budget_usd_monthly ?? null : store.getCompany(companyId)?.monthly_budget_usd ?? null;
  return { budgetUsd: budget, spentUsd: usd, unpricedCalls: unpriced, ratio: budget && budget > 0 ? usd / budget : budget === 0 ? Infinity : null };
}

/** Why an agent may not spend now (its own or its company's budget is used up), or null. */
export function budgetBlock(store: DaemonStore, companyId: string, agentId: string, nowIso: string): string | null {
  const agent = budgetLine(store, companyId, nowIso, agentId);
  if (agent.ratio !== null && agent.ratio >= 1) return `agent budget used: $${agent.spentUsd.toFixed(2)} of $${agent.budgetUsd!.toFixed(2)} this month`;
  const company = budgetLine(store, companyId, nowIso);
  if (company.ratio !== null && company.ratio >= 1) return `company budget used: $${company.spentUsd.toFixed(2)} of $${company.budgetUsd!.toFixed(2)} this month`;
  return null;
}

export interface BudgetEvent { scope: "agent" | "company"; id: string; level: "warning" | "paused"; spentUsd: number; budgetUsd: number }

/** Run after recording a cost: raises the 80% warning and the 100% pause once per month each. */
export function checkBudgets(store: DaemonStore, companyId: string, agentId: string | undefined, nowIso: string, notify?: (title: string, body: string) => void): BudgetEvent[] {
  const since = monthStart(nowIso);
  const events: BudgetEvent[] = [];
  const say = (title: string, body: string) => { try { notify?.(title, body); } catch { /* best effort */ } };
  const scopes: Array<{ scope: "agent" | "company"; id: string; name: string; line: BudgetLine }> = [];
  if (agentId) {
    const agent = store.getAgent(agentId);
    if (agent) scopes.push({ scope: "agent", id: agent.id, name: agent.name, line: budgetLine(store, companyId, nowIso, agentId) });
  }
  const company = store.getCompany(companyId);
  if (company) scopes.push({ scope: "company", id: company.id, name: company.name, line: budgetLine(store, companyId, nowIso) });

  for (const { scope, id, name, line } of scopes) {
    if (line.ratio === null || line.budgetUsd === null) continue;
    const money = `$${line.spentUsd.toFixed(2)} / $${line.budgetUsd.toFixed(2)}`;
    if (line.ratio >= 1 && !store.hasActivity(companyId, "budget-paused", id, since)) {
      const agents = scope === "agent" ? [store.getAgent(id)!] : store.listAgents(companyId);
      for (const a of agents) if (a.status !== "paused" && a.status !== "error") store.setAgentStatus(a.id, "paused");
      store.activity({ companyId, actor: "budget", verb: "budget-paused", objectType: scope, objectId: id, summary: `${name}: budget used (${money}); paused` });
      say(`${name}: budget used`, `${money} this month. ${scope === "agent" ? "The agent is" : "All agents are"} paused; raise the budget to spend again.`);
      events.push({ scope, id, level: "paused", spentUsd: line.spentUsd, budgetUsd: line.budgetUsd });
    } else if (line.ratio >= WARN_AT && line.ratio < 1 && !store.hasActivity(companyId, "budget-warning", id, since)) {
      store.activity({ companyId, actor: "budget", verb: "budget-warning", objectType: scope, objectId: id, summary: `${name}: ${Math.round(line.ratio * 100)}% of budget used (${money})` });
      say(`${name}: ${Math.round(line.ratio * 100)}% of budget`, `${money} this month.`);
      events.push({ scope, id, level: "warning", spentUsd: line.spentUsd, budgetUsd: line.budgetUsd });
    }
  }
  return events;
}

import type { DaemonStore } from "./store";
import type { CompanyMemory } from "./memory";
import { budgetBlock, checkBudgets } from "./budget";
import { collectStream } from "../core/stream";
import { DEFAULT_INFERENCE_TIMEOUT_MS } from "../forge/request-scope";
import { effortNote, prepareCall, redact, type ProviderDeps } from "./provider";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CONFIG_DIR } from "../forge/config";
import { checkMonitor, makeMonitorStore, summaryPrompt, type CheckOutcome, type MonitorDef, type NotifyKind } from "../forge/monitor";
/**
 * Routine runner: one due routine → one model call for its agent (./provider).
 * The result lands in the daemon's own SQLite (conversation + messages for
 * search, cost event, activity).
 *
 * Web preflight (design §6.4): the routine's pages are checked model-free with
 * the `braavo monitor` core. No change → no model call. A change → the agent
 * summarises it (page text wrapped as untrusted), the finding is appended to
 * the company's markdown memory and a notification goes out. Without a usable
 * model the raw signals are still recorded and notified.
 *
 * Not yet: tools/agent loop, rss/script preflight, per-model USD pricing
 * (cost events carry tokens, usd stays 0).
 */

export interface RunnerDeps extends ProviderDeps {
  timeoutMs?: number;
  /** Monitor state per routine (default ~/.braavo/monitor/routines). */
  monitorRoot?: string;
  /** Markdown company memory (default ~/.braavo/memory). */
  memoryRoot?: string;
  /** Company memory (plan 4.1–4.3): snapshots, related notes, the task journal and git commits. */
  memory?: CompanyMemory;
  /** Agent browser (plan 5.1): pages a task links to, read under the URL policy. */
  browser?: { read(url: string): Promise<{ url: string; title: string; text: string; truncated: boolean }> };
  /** CLI employees (plan 3.1): tasks of agents whose engine is claude-code, codex or gemini. */
  worker?: import("./workers").WorkerDeps;
  /** Skills (plan 5.3): an agent's task runs with its skills' instructions. */
  skills?: { promptFor(names: string[]): string };
  /** Desktop/phone notification for a finding; failures are ignored. */
  notify?: (title: string, body: string) => void;
}

const SETUP_NOTE = "setup needed: add a key (braavo keys add <provider>) or pull a local model (braavo models pull <name>); see braavo setup";

const pageId = (url: string) => `p-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
const RECURRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const priceKey = (prices: string[]) => [...new Set(prices.map(p => p.replace(/\s+/g, "")))].sort().join("|");

function signalLines(o: CheckOutcome): string[] {
  const lines = o.changes.filter(c => c.kind !== "text").map(c => `${c.kind}: ${[...c.added.map(a => `+${a}`), ...c.removed.map(r => `-${r}`)].join(", ")}`);
  return lines.length ? lines : ["text changed"];
}

/** Append a dated finding to memory/<companyId>/findings/<role>.md (owner-only). */
export function appendFinding(root: string, companyId: string, role: string, entry: { at: string; title: string; pages: CheckOutcome[]; summary?: string }): string {
  const dir = join(root, companyId.replace(/[^A-Za-z0-9_-]/g, ""), "findings");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${role.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "agent"}.md`);
  const lines = [`\n## ${entry.at.slice(0, 16).replace("T", " ")} UTC · ${entry.title}`, ""];
  for (const p of entry.pages) lines.push(`- ${p.url}`, ...signalLines(p).map(l => `  - ${l}`));
  if (entry.summary) lines.push("", entry.summary.trim());
  appendFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return file;
}

export interface RunResult { outcome: string; note?: string }

export async function runRoutine(store: DaemonStore, routineId: string, deps: RunnerDeps): Promise<RunResult> {
  const routine = store.getRoutine(routineId);
  if (!routine) return { outcome: "failed", note: "routine not found" };
  const agent = store.getAgent(routine.agent_id);
  if (!agent) return { outcome: "failed", note: "agent not found" };
  if (agent.status === "paused") return { outcome: "skipped-paused", note: agent.name };
  // Over budget: model calls stop; a web routine still runs its free page check.
  const blocked = budgetBlock(store, routine.company_id, agent.id, new Date().toISOString());
  // K3: an agent in error has no usable model yet; its stored provider is only a placeholder.
  const setupNeeded = agent.status === "error";

  let preflight: { type?: unknown };
  try { preflight = JSON.parse(routine.preflight); } catch { preflight = {}; }
  if (preflight.type === "web") return runWebRoutine(store, routine, agent, preflight as { urls?: unknown; notify?: unknown }, deps, blocked);
  if (blocked) return { outcome: "skipped-budget", note: blocked };
  if (setupNeeded) return { outcome: "failed", note: SETUP_NOTE };
  if (preflight.type !== "none") return { outcome: "skipped-preflight-unsupported", note: `preflight ${String(preflight.type)} not implemented` };

  const call = prepareCall({ provider: agent.provider, model: agent.model, effort: agent.effort, effortRounding: agent.effort_rounding }, deps);
  if (!call.ok) return { outcome: "failed", note: call.message };
  const provider = agent.provider;

  const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS);
  let result: Awaited<ReturnType<typeof collectStream>>;
  try {
    result = await collectStream(call.stream({ system: agent.system_prompt || undefined, messages: [{ role: "user", content: routine.prompt }] }, signal));
  } catch (error) {
    return { outcome: "failed", note: redact(error instanceof Error ? error.message : String(error), call.apiKey) };
  }

  const conversationId = store.createConversation({ companyId: routine.company_id, agentId: agent.id, title: routine.name });
  store.addMessage(conversationId, "user", routine.prompt);
  store.addMessage(conversationId, "assistant", result.text);
  store.recordCost({ companyId: routine.company_id, agentId: agent.id, runId: conversationId, provider, model: agent.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  checkBudgets(store, routine.company_id, agent.id, new Date().toISOString(), deps.notify);
  store.activity({ companyId: routine.company_id, actor: agent.id, verb: "ran-routine", objectType: "routine", objectId: routine.id, summary: routine.name });

  const note = [conversationId, `${result.inputTokens}/${result.outputTokens} tokens`, result.stopReason !== "end_turn" ? `stop ${result.stopReason}` : undefined, effortNote(call.effort)]
    .filter(Boolean).join(" · ");
  return { outcome: "ran", note };
}

type Routine = NonNullable<ReturnType<DaemonStore["getRoutine"]>>;
type Agent = NonNullable<ReturnType<DaemonStore["getAgent"]>>;

async function runWebRoutine(store: DaemonStore, routine: Routine, agent: Agent, preflight: { urls?: unknown; notify?: unknown }, deps: RunnerDeps, budgetBlocked: string | null = null): Promise<RunResult> {
  const urls = Array.isArray(preflight.urls) ? preflight.urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 20) : [];
  if (!urls.length) return { outcome: "failed", note: "web preflight has no URLs" };
  const notify = (Array.isArray(preflight.notify) ? preflight.notify : ["price", "plans", "promo", "release"]) as NotifyKind[];
  const monitorStore = makeMonitorStore(join(deps.monitorRoot ?? join(CONFIG_DIR, "monitor", "routines"), routine.id.replace(/[^A-Za-z0-9_-]/g, "")));

  const outcomes: CheckOutcome[] = []; const failed: string[] = []; const defs = new Map<string, MonitorDef>();
  for (const url of urls) {
    const def: MonitorDef = { id: pageId(url), url, notify, everyMinutes: 15, createdAt: routine.created_at };
    defs.set(url, def);
    try { outcomes.push(await checkMonitor(def, { store: monitorStore, fetchImpl: deps.fetchImpl as never })); }
    catch { failed.push(url); }
  }
  // A change must survive an immediate second fetch: pages that rotate prices per request
  // (A/B tests, monthly/annual toggles) are "unstable" and neither summarised nor notified.
  const unstable = new Set<string>();
  for (const o of outcomes.filter(x => x.kind === "changed")) {
    try { if ((await checkMonitor(defs.get(o.url)!, { store: monitorStore, fetchImpl: deps.fetchImpl as never })).kind !== "no-change") unstable.add(o.url); }
    catch { /* the first fetch stands */ }
  }
  // Pages that serve one price set for hours and another after (slow A/B tests) pass the second
  // fetch; a price-only change back to a set already seen in the last 14 days is "recurring":
  // kept in the history, not summarised or notified.
  const recurring = new Set<string>();
  const since = new Date(Date.now() - RECURRING_WINDOW_MS).toISOString();
  for (const o of outcomes) {
    if (o.kind !== "changed" || unstable.has(o.url) || !o.prices.length || o.changes.some(c => c.kind !== "price")) continue;
    const key = priceKey(o.prices);
    if (store.facts(routine.company_id, "price", o.url).some(f => f.valid_to !== null && f.valid_to >= since && priceKey(f.value.split(", ")) === key)) recurring.add(o.url);
  }
  // FK-13: every page's price set over time (baseline and confirmed changes), for the panel's history.
  for (const o of outcomes) if (!unstable.has(o.url) && (o.prices.length || o.previousPrices.length)) store.recordFact({ companyId: routine.company_id, subject: o.url, predicate: "price", value: o.prices.join(", ") || "—", at: o.at, source: routine.id });
  const changed = outcomes.filter(o => o.kind === "changed" && !unstable.has(o.url) && !recurring.has(o.url));
  const baseline = outcomes.filter(o => o.kind === "first").length;
  const counts = [`${urls.length} pages`, baseline ? `${baseline} baseline` : undefined, unstable.size ? `${unstable.size} unstable` : undefined, recurring.size ? `${recurring.size} recurring` : undefined, failed.length ? `${failed.length} failed` : undefined].filter(Boolean).join(" · ");
  if (!changed.length) return { outcome: failed.length === urls.length ? "failed" : "no-change", note: counts };

  // A change: let the agent summarise it, page text as untrusted data.
  let summary: string | undefined; let note: string | undefined; let conversationId: string | undefined;
  const call = agent.status === "error"
    ? { ok: false as const, code: "missing-key" as const, message: SETUP_NOTE }
    : budgetBlocked
    ? { ok: false as const, code: "missing-key" as const, message: budgetBlocked }
    : prepareCall({ provider: agent.provider, model: agent.model, effort: agent.effort, effortRounding: agent.effort_rounding }, deps);
  const prompt = [routine.prompt, "", ...changed.map(o => summaryPrompt(defs.get(o.url)!, o))].join("\n");
  if (call.ok) {
    try {
      const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS);
      const result = await collectStream(call.stream({ system: agent.system_prompt || undefined, messages: [{ role: "user", content: prompt }] }, signal));
      summary = result.text.trim() || undefined;
      conversationId = store.createConversation({ companyId: routine.company_id, agentId: agent.id, title: routine.name, provider: agent.provider, model: agent.model });
      store.addMessage(conversationId, "user", prompt);
      if (summary) store.addMessage(conversationId, "assistant", summary, { stopReason: result.stopReason });
      store.recordCost({ companyId: routine.company_id, agentId: agent.id, runId: conversationId, provider: agent.provider, model: agent.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      checkBudgets(store, routine.company_id, agent.id, new Date().toISOString(), deps.notify);
    } catch (error) {
      note = `summary failed: ${redact(error instanceof Error ? error.message : String(error), call.apiKey, 120)}`;
    }
  } else note = `no summary: ${call.message}`;

  const at = new Date().toISOString();
  appendFinding(deps.memory?.root ?? deps.memoryRoot ?? join(CONFIG_DIR, "memory"), routine.company_id, agent.role, { at, title: routine.name, pages: changed, summary });
  deps.memory?.commit(`${agent.id}: findings/${agent.role}.md`);
  store.activity({ companyId: routine.company_id, actor: agent.id, verb: "found-change", objectType: "routine", objectId: routine.id, summary: `${changed.length} of ${urls.length} pages changed` });
  const firstLine = (summary ?? signalLines(changed[0]).join("; ")).split("\n").find(l => l.trim())?.replace(/^[-*•]\s*/, "").slice(0, 180) ?? "";
  try { deps.notify?.(`${agent.name}: ${changed.length} change${changed.length > 1 ? "s" : ""}`, firstLine); } catch { /* notification is best effort */ }
  return { outcome: "changed", note: [counts, `${changed.length} changed`, conversationId, note].filter(Boolean).join(" · ") };
}

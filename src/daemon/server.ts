import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DaemonStore, TASK_STATUSES } from "./store";
import { firstFireAt, isSupportedRrule, planTick, TICK_MS, type TickAction } from "./scheduler";
import { ChatError, type ChatEvent, type ChatService } from "./chat";
import { MemoryError, type CompanyMemory } from "./memory";
import { isSkillName, SkillError, type SkillRegistry } from "./skills";
import { BrowseError, type BrowserPolicy, type Page } from "./browse";
import { APPROVAL_POLICIES, isWorkerEngine } from "./acp";
import type { ApprovalCenter } from "./workers";
import { ensureConsolidationRoutine } from "./compaction";
import { newGoalId } from "./ledger";
import { newTriggerId, TRIGGER_KINDS, watchableFolder, MIN_EVERY_MINUTES, type TriggerEngine } from "./triggers";
import { blockedReason } from "./browse";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CompanyError, hire, panel, updateAgent } from "./company";
import { AGENT_TEMPLATES } from "../core/templates";
/**
 * Local daemon API (platform docs/ai-company/TASARIM.tr.md §9). Loopback only,
 * bearer token from ~/.braavo/daemon/token (0600), JSON in/out, one SSE event
 * stream. The mobile companion never connects here; it goes through the cloud
 * relay with outbound connections only.
 *
 * It serves companies, agents (org chart), routines and their execution
 * ledger, runs the scheduler tick, and — when a ChatService is given — the
 * chat endpoints of docs/DAEMON-CHAT.md. Executing a routine is an injected
 * hook (`runRoutine`) so the agent loop can plug in without touching the
 * scheduler or the API.
 */

const MAX_BODY_BYTES = 256 * 1024;
/** History import carries whole conversations (desktop localStorage migration). */
const MAX_IMPORT_BODY_BYTES = 16 * 1024 * 1024;
const PROVIDERS = new Set(["ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER", "DEEPSEEK", "KIMI", "QWEN", "CEREBRAS", "ZHIPU", "OLLAMA", "LMSTUDIO", "CUSTOM"]);
const EFFORTS = new Set(["none", "low", "medium", "high", "max"]);

/** An agent of the company by id or (case-insensitive) name. */
function resolveAgent(store: DaemonStore, companyId: string, ref: string) {
  const agents = store.listAgents(companyId);
  return agents.find(a => a.id === ref) ?? agents.find(a => a.name.toLowerCase() === ref.trim().toLowerCase());
}

export interface DaemonOptions {
  store: DaemonStore;
  token: string;
  version: string;
  now?: () => Date;
  /** Executes a due routine; resolves to a short note for the ledger. Default: record "ran" with no work. */
  runRoutine?: (routineId: string, info: { scheduledFor: string; catchUp: boolean }) => Promise<{ outcome: string; note?: string }>;
  /** Called for every catch-up run so the user is told what ran after a sleep. */
  notify?: (event: DaemonEvent) => void;
  /** Chat engine (plan 1.2); chat routes answer 404 without it. */
  chat?: ChatService;
  /** Runs one task (plan 2.3); without it tasks are stored but never run. */
  runTask?: (taskId: string) => Promise<{ outcome: string; note?: string }>;
  /** Company memory (plan 4.1–4.3); memory routes answer 404 without it. */
  memory?: CompanyMemory;
  /** Agent browser (plan 5.1): URL policy and read-only page fetches; browser routes answer 404 without it. */
  browser?: { policy(): BrowserPolicy; setPolicy(p: BrowserPolicy): void; read(url: string): Promise<Page> };
  /** Event triggers (plan 5.4); trigger routes answer 404 without it. */
  triggers?: TriggerEngine;
  /** Drives one goal through the manager's ledger (plan 4.5); goals are stored but never run without it. */
  runGoal?: (goalId: string) => Promise<{ status: string; note?: string }>;
  /** CLI employees' approval queue (plan 3.1); approval routes answer 404 without it. */
  approvals?: ApprovalCenter;
  /** Skills (plan 5.3); skill routes answer 404 without it. */
  skills?: SkillRegistry;
}

export type DaemonEvent =
  | { type: "routine.executed"; routineId: string; outcome: string; scheduledFor: string; catchUp: boolean }
  | { type: "agent.status"; agentId: string; status: string }
  | { type: "company.changed"; companyId: string }
  | { type: "conversation.changed"; conversationId: string }
  | { type: "task.changed"; taskId: string; companyId: string }
  | { type: "task.event"; taskId: string; kind: string }
  | { type: "approval.requested"; approvalId: string; companyId: string }
  | { type: "goal.changed"; goalId: string; companyId: string }
  | { type: "approval.decided"; approvalId: string; companyId: string; status: string };

class HttpError extends Error { constructor(readonly status: number, message: string, readonly code?: string) { super(message); } }

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
}

const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, `${field} is required (≤${max} chars)`);
  return v.trim();
};

export class Daemon {
  readonly server: Server;
  private readonly subscribers = new Set<ServerResponse>();
  private readonly listeners = new Set<(event: DaemonEvent) => void>();
  private readonly running = new Set<string>();
  private timer?: NodeJS.Timeout;
  private readonly now: () => Date;

  constructor(private readonly o: DaemonOptions) {
    this.now = o.now ?? (() => new Date());
    this.server = createServer((req, res) => { void this.handle(req, res); });
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve((this.server.address() as { port: number }).port));
    });
  }

  startTicking(): void {
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const res of this.subscribers) res.end();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  emit(event: DaemonEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.subscribers) res.write(frame);
    for (const fn of this.listeners) { try { fn(event); } catch { /* a listener never breaks the API */ } }
  }

  /** In-process listener for daemon events (e.g. the relay's panel snapshot). */
  onEvent(fn: (event: DaemonEvent) => void): void { this.listeners.add(fn); }

  /** One scheduler pass; returns the actions taken (exposed for tests and `routine run-now`). */
  async tick(): Promise<TickAction[]> {
    const routines = this.o.store.listRoutines().map(r => ({
      id: r.id, rrule: r.rrule, timezone: r.timezone, catchUp: (r.catch_up === "skip" ? "skip" : "once") as "once" | "skip",
      nextFireAt: r.next_fire_at ?? r.created_at, enabled: r.enabled === 1, running: this.running.has(r.id),
    }));
    const actions = planTick(routines, this.now());
    for (const action of actions) {
      if (action.kind === "skip") {
        this.o.store.recordExecution({ routineId: action.routineId, scheduledFor: action.scheduledFor, outcome: action.outcome, nextFireAt: action.nextFireAt, fired: false });
        continue;
      }
      await this.execute(action.routineId, action.scheduledFor, action.catchUp, action.nextFireAt);
    }
    await this.runTasks();
    return actions;
  }

  private taskBusy = false;
  private goalBusy = false;
  /** Runs at most one task per pass; tasks whose agent cannot run yet are noted and passed over. */
  async runTasks(): Promise<{ taskId: string; outcome: string } | null> {
    if (!this.o.runTask || this.taskBusy) return null;
    this.taskBusy = true;
    try {
      for (const task of this.o.store.runnableTasks(10)) {
        const result = await this.o.runTask(task.id);
        this.emit({ type: "task.changed", taskId: task.id, companyId: task.company_id });
        if (result.outcome !== "waiting" && result.outcome !== "skipped") {
          this.emit({ type: "company.changed", companyId: task.company_id });
          return { taskId: task.id, outcome: result.outcome };
        }
      }
      return null;
    } finally {
      this.taskBusy = false;
    }
  }

  /** Run a routine now, outside its schedule (API "run now"); the schedule itself is unchanged. */
  async runNow(routineId: string): Promise<{ outcome: string; note?: string }> {
    const routine = this.o.store.getRoutine(routineId);
    if (!routine) throw new HttpError(404, "routine not found");
    if (this.running.has(routineId)) throw new HttpError(409, "routine is already running");
    return this.execute(routineId, this.now().toISOString(), false, routine.next_fire_at ?? routine.created_at);
  }

  private async execute(routineId: string, scheduledFor: string, catchUp: boolean, nextFireAt: string): Promise<{ outcome: string; note?: string }> {
    this.running.add(routineId);
    try {
      const result = this.o.runRoutine ? await this.o.runRoutine(routineId, { scheduledFor, catchUp }) : { outcome: "ran" };
      this.o.store.recordExecution({ routineId, scheduledFor, outcome: result.outcome, note: result.note, nextFireAt, fired: true });
      const event: DaemonEvent = { type: "routine.executed", routineId, outcome: result.outcome, scheduledFor, catchUp };
      this.emit(event);
      if (catchUp) this.o.notify?.(event);
      return result;
    } catch (error) {
      const note = (error as Error).message.slice(0, 200);
      this.o.store.recordExecution({ routineId, scheduledFor, outcome: "failed", note, nextFireAt, fired: true });
      return { outcome: "failed", note };
    } finally {
      this.running.delete(routineId);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Loopback-only listener, plus refuse browser cross-origin calls and DNS-rebinding hosts.
      if (req.headers.origin) throw new HttpError(403, "cross-origin requests are not allowed");
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") throw new HttpError(403, "unexpected host");
      if (!tokenMatches(req.headers.authorization, this.o.token)) throw new HttpError(401, "unauthorized");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1") throw new HttpError(404, "not found");
      const literal = `${req.method} /${parts.slice(1).join("/")}`;
      const route = literal === "POST /conversations/import" ? literal : `${req.method} /${parts.slice(1).map((p, i) => (i % 2 === 1 ? ":id" : p)).join("/")}`;
      const id = parts[2];
      const store = this.o.store;

      switch (route) {
        case "GET /health":
          return this.json(res, 200, { ok: true, version: this.o.version, schema: store.schemaVersion(), running: [...this.running] });
        case "GET /events": {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.write(": connected\n\n");
          this.subscribers.add(res);
          // A comment every 25 s lets clients notice a half-open connection.
          const beat = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 25_000);
          beat.unref?.();
          req.on("close", () => { clearInterval(beat); this.subscribers.delete(res); });
          return;
        }
        case "GET /companies":
          return this.json(res, 200, { companies: store.listCompanies() });
        case "POST /companies": {
          const body = await readJson(req);
          const company = store.createCompany({ name: str(body.name, "name", 120), mission: typeof body.mission === "string" ? body.mission.slice(0, 4000) : undefined });
          this.emit({ type: "company.changed", companyId: company.id });
          return this.json(res, 201, { company });
        }
        case "GET /companies/:id/org": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          return this.json(res, 200, { agents: store.listAgents(id), activity: store.recentActivity(id, 20) });
        }
        case "POST /companies/:id/agents": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          const provider = str(body.provider, "provider", 20);
          if (!PROVIDERS.has(provider)) throw new HttpError(400, "unknown provider");
          if (body.effort !== undefined && !EFFORTS.has(body.effort)) throw new HttpError(400, "unknown effort");
          if (body.effortRounding !== undefined && body.effortRounding !== "down" && body.effortRounding !== "up") throw new HttpError(400, "effortRounding must be down or up");
          const manager = body.reportsToAgentId ?? null;
          if (manager !== null) {
            const m = store.getAgent(String(manager));
            // A manager must exist in the same company; a brand-new agent cannot create a cycle.
            if (!m || m.company_id !== id) throw new HttpError(400, "reportsToAgentId must be an agent of this company");
          }
          const agent = store.createAgent({
            companyId: id, name: str(body.name, "name", 80), role: str(body.role, "role", 80), provider, model: str(body.model, "model"),
            title: typeof body.title === "string" ? body.title.slice(0, 80) : undefined, systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt.slice(0, 20_000) : undefined,
            effort: body.effort, effortRounding: body.effortRounding, reportsToAgentId: manager,
          });
          this.emit({ type: "company.changed", companyId: id });
          return this.json(res, 201, { agent });
        }
        case "POST /companies/:id/workers": {
          // Plan 3.1: hire the user's own Claude Code, Codex or Gemini CLI as an employee.
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          if (!isWorkerEngine(body.engine)) throw new HttpError(400, "engine must be claude-code, codex or gemini");
          if (typeof body.workdir !== "string" || !isAbsolute(body.workdir) || !existsSync(body.workdir)) throw new HttpError(400, "workdir must be an existing absolute folder");
          const policy = body.approvalPolicy ?? "ask";
          if (!(APPROVAL_POLICIES as readonly unknown[]).includes(policy)) throw new HttpError(400, "approvalPolicy must be ask, edits or readonly");
          const manager = body.reportsToAgentId ?? null;
          if (manager !== null) {
            const m = store.getAgent(String(manager));
            if (!m || m.company_id !== id) throw new HttpError(400, "reportsToAgentId must be an agent of this company");
          }
          const names: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
          const agent = store.createAgent({
            companyId: id, name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : names[body.engine],
            role: typeof body.role === "string" && body.role.trim() ? body.role.trim().slice(0, 80) : "engineer", title: typeof body.title === "string" ? body.title.slice(0, 80) : undefined,
            provider: "ACP", model: body.engine, engine: body.engine, reportsToAgentId: manager,
            systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt.slice(0, 20_000) : undefined,
          });
          store.setWorker(agent.id, { workdir: body.workdir, approvalPolicy: policy });
          store.activity({ companyId: id, actor: "user", verb: "hired-worker", objectType: "agent", objectId: agent.id, summary: `${agent.name} (${body.engine}) in ${body.workdir}` });
          this.emit({ type: "company.changed", companyId: id });
          return this.json(res, 201, { agent: store.getAgent(agent.id) });
        }
        case "POST /companies/:id/triggers": {
          const engine = this.triggerEngine();
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          if (!(TRIGGER_KINDS as readonly unknown[]).includes(body.kind)) throw new HttpError(400, "kind must be rss, web or files");
          const agent = resolveAgent(store, id, String(body.agent ?? ""));
          if (!agent) throw new HttpError(400, "agent must be an agent of this company (id or name)");
          const every = body.everyMinutes === undefined ? 30 : Number(body.everyMinutes);
          if (!Number.isInteger(every) || every < MIN_EVERY_MINUTES || every > 7 * 24 * 60) throw new HttpError(400, `everyMinutes must be ${MIN_EVERY_MINUTES}–10080`);
          let config: Record<string, unknown>;
          if (body.kind === "files") {
            const problem = typeof body.path === "string" ? watchableFolder(body.path) : "path is required";
            if (problem) throw new HttpError(400, problem);
            config = { path: body.path, pattern: typeof body.pattern === "string" && body.pattern.trim() ? body.pattern.trim().slice(0, 200) : "*" };
          } else {
            const url = str(body.url, "url", 2000);
            const policy = this.o.browser?.policy();
            const problem = policy ? blockedReason(url, policy) : null;
            if (problem) throw new HttpError(400, problem);
            config = { url, everyMinutes: every };
          }
          const trigger = store.createTrigger({
            id: newTriggerId(), companyId: id, agentId: agent.id, kind: body.kind, config,
            name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `${body.kind}: ${String(config.url ?? config.path).slice(0, 100)}`,
            taskTitle: typeof body.title === "string" ? body.title.slice(0, 300) : undefined, taskBody: typeof body.body === "string" ? body.body.slice(0, 4_000) : undefined,
          });
          engine.arm(trigger);
          store.activity({ companyId: id, actor: "user", verb: "trigger-added", objectType: "trigger", objectId: trigger.id, summary: trigger.name });
          this.emit({ type: "company.changed", companyId: id });
          return this.json(res, 201, { trigger: { ...trigger, config, state: undefined } });
        }
        case "GET /companies/:id/triggers":
          return this.json(res, 200, { triggers: store.listTriggers(id).map(t => ({ ...t, config: JSON.parse(t.config), state: undefined })) });
        case "PATCH /triggers/:id": {
          const engine = this.triggerEngine();
          const t = store.getTrigger(id);
          if (!t) throw new HttpError(404, "trigger not found");
          const body = await readJson(req);
          if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
          store.updateTrigger(id, { enabled: body.enabled });
          if (body.enabled) engine.arm(store.getTrigger(id)!); else engine.disarm(id);
          this.emit({ type: "company.changed", companyId: t.company_id });
          return this.json(res, 200, { trigger: { ...store.getTrigger(id)!, config: JSON.parse(t.config), state: undefined } });
        }
        case "DELETE /triggers/:id": {
          const engine = this.triggerEngine();
          const t = store.getTrigger(id);
          if (!t) throw new HttpError(404, "trigger not found");
          engine.disarm(id);
          store.deleteTrigger(id);
          this.emit({ type: "company.changed", companyId: t.company_id });
          res.writeHead(204).end();
          return;
        }
        case "POST /triggers/:id/check": {
          const t = store.getTrigger(id);
          if (!t) throw new HttpError(404, "trigger not found");
          if (t.kind === "files") throw new HttpError(400, "folder triggers fire on changes; there is nothing to poll");
          return this.json(res, 200, await this.triggerEngine().check(id));
        }
        case "POST /companies/:id/goals": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          const agents = store.listAgents(id);
          const manager = body.manager !== undefined ? resolveAgent(store, id, String(body.manager)) : agents.find(a => a.role === "ceo") ?? agents.find(a => !a.reports_to_agent_id);
          if (!manager) throw new HttpError(400, "the company needs a manager (hire the General Manager, or pass manager)");
          const goal = store.createGoal({ id: newGoalId(), companyId: id, managerAgentId: manager.id, title: str(body.title, "title", 300), body: typeof body.body === "string" ? body.body.slice(0, 20_000) : undefined });
          store.activity({ companyId: id, actor: "user", verb: "goal-created", objectType: "goal", objectId: goal.id, summary: goal.title.slice(0, 120) });
          this.emit({ type: "goal.changed", goalId: goal.id, companyId: id });
          return this.json(res, 201, { goal });
        }
        case "GET /companies/:id/goals":
          return this.json(res, 200, { goals: store.listGoals(id).map(g => ({ ...g, ledger: g.ledger ? JSON.parse(g.ledger) : null })) });
        case "GET /goals/:id": {
          const goal = store.getGoal(id);
          if (!goal) throw new HttpError(404, "goal not found");
          return this.json(res, 200, { goal: { ...goal, ledger: goal.ledger ? JSON.parse(goal.ledger) : null }, tasks: store.goalTasks(id) });
        }
        case "POST /goals/:id/run": {
          const goal = store.getGoal(id);
          if (!goal) throw new HttpError(404, "goal not found");
          if (!this.o.runGoal) throw new HttpError(404, "goals are not enabled on this daemon");
          if (this.goalBusy) throw new HttpError(409, "another goal is running; try again when it finishes");
          if (goal.status === "DONE" || goal.status === "RUNNING") throw new HttpError(409, `goal is ${goal.status}`);
          // A goal takes many steps: it runs in the background and reports through goal.changed events.
          this.goalBusy = true;
          void this.o.runGoal(id).catch(() => undefined).finally(() => { this.goalBusy = false; this.emit({ type: "goal.changed", goalId: id, companyId: goal.company_id }); });
          return this.json(res, 202, { goal: { ...store.getGoal(id)!, ledger: undefined }, running: true });
        }
        case "GET /tasks/:id/events": {
          if (!store.getTask(id)) throw new HttpError(404, "task not found");
          return this.json(res, 200, { events: store.taskEvents(id, Number(url.searchParams.get("after") ?? 0) || 0) });
        }
        case "GET /companies/:id/approvals": {
          const status = url.searchParams.get("status") ?? undefined;
          return this.json(res, 200, { approvals: store.listApprovals(id, status).map(a => ({ ...a, paths: JSON.parse(a.paths) })) });
        }
        case "POST /approvals/:id": {
          if (!this.o.approvals) throw new HttpError(404, "approvals are not enabled on this daemon");
          const approval = store.getApproval(id);
          if (!approval) throw new HttpError(404, "approval not found");
          const body = await readJson(req);
          if (body.decision !== "allow" && body.decision !== "reject") throw new HttpError(400, "decision must be allow or reject");
          if (!this.o.approvals.decide(id, body.decision)) throw new HttpError(409, `approval is already ${store.getApproval(id)?.status}`);
          const decided = store.getApproval(id)!;
          this.emit({ type: "approval.decided", approvalId: id, companyId: decided.company_id, status: decided.status });
          return this.json(res, 200, { approval: { ...decided, paths: JSON.parse(decided.paths) } });
        }
        case "GET /templates":
          return this.json(res, 200, { templates: AGENT_TEMPLATES.map(t => ({ id: t.id, names: t.names, role: t.role, domain: t.domain, reportsTo: t.reportsTo, tier: t.tier, effort: t.effort, routines: t.routines.map(r => ({ key: r.key, names: r.names, rrule: r.rrule, preflight: r.preflight.type })) })) });
        case "GET /companies/:id/panel":
          return this.json(res, 200, panel(store, id, this.now()));
        case "GET /companies/:id/prices":
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          return this.json(res, 200, { prices: store.facts(id, "price", url.searchParams.get("url") ?? undefined) });
        case "POST /companies/:id/hire": {
          const body = await readJson(req);
          const models = this.o.chat ? await this.o.chat.userModels() : { keys: new Set<never>() };
          const result = hire(store, id, body, models, this.now());
          // Plan 4.4: every company with agents gets its nightly memory consolidation.
          if (this.o.memory) ensureConsolidationRoutine(store, id, this.now());
          this.emit({ type: "company.changed", companyId: id });
          return this.json(res, 201, result);
        }
        case "PATCH /agents/:id": {
          const body = await readJson(req);
          const agent = updateAgent(store, id, body, provider => this.o.chat?.canUse(provider) ?? false);
          this.emit({ type: "agent.status", agentId: agent.id, status: agent.status });
          this.emit({ type: "company.changed", companyId: agent.company_id });
          return this.json(res, 200, { agent });
        }
        case "PATCH /companies/:id": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          if (body.monthlyBudgetUsd !== undefined) {
            const v = body.monthlyBudgetUsd;
            if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000)) throw new HttpError(400, "monthlyBudgetUsd must be 0–1000000 or null");
            store.setCompanyBudget(id, v as number | null);
            store.activity({ companyId: id, actor: "user", verb: "budget-set", objectType: "company", objectId: id, summary: v === null ? "company budget removed" : `company budget $${(v as number).toFixed(2)}/month` });
          }
          this.emit({ type: "company.changed", companyId: id });
          return this.json(res, 200, { company: store.getCompany(id) });
        }
        case "GET /companies/:id/tasks": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const status = url.searchParams.get("status") ?? undefined;
          if (status && !(TASK_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "unknown status");
          return this.json(res, 200, { tasks: store.listTasks(id, status) });
        }
        case "POST /companies/:id/tasks": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          const assignee = body.assignee === undefined || body.assignee === null ? null : resolveAgent(store, id, String(body.assignee));
          if (body.assignee !== undefined && body.assignee !== null && !assignee) throw new HttpError(400, "assignee must be an agent of this company (id or name)");
          const priority = body.priority === undefined ? 0 : Number(body.priority);
          if (!Number.isInteger(priority) || priority < -10 || priority > 10) throw new HttpError(400, "priority must be an integer from -10 to 10");
          const task = store.createTask({
            companyId: id, title: str(body.title, "title", 300), body: typeof body.body === "string" ? body.body.slice(0, 20_000) : undefined,
            assigneeAgentId: assignee?.id ?? null, createdBy: "user", priority, origin: body.origin === "chat" ? "chat" : "manual",
          });
          store.activity({ companyId: id, actor: "user", verb: "task-created", objectType: "task", objectId: task.id, summary: task.title.slice(0, 120) });
          this.emit({ type: "task.changed", taskId: task.id, companyId: id });
          return this.json(res, 201, { task });
        }
        case "GET /tasks/:id": {
          const task = store.getTask(id);
          if (!task) throw new HttpError(404, "task not found");
          return this.json(res, 200, { task });
        }
        case "PATCH /tasks/:id": {
          const task = store.getTask(id);
          if (!task) throw new HttpError(404, "task not found");
          const body = await readJson(req);
          if (body.status !== undefined) {
            // Cancel an open task; reopen a finished, failed or cancelled one. A running task is left to finish.
            if (body.status === "CANCELLED" && task.status === "OPEN") store.updateTask(id, { status: "CANCELLED", endedAt: new Date().toISOString() });
            else if (body.status === "OPEN" && ["DONE", "FAILED", "CANCELLED"].includes(task.status)) store.updateTask(id, { status: "OPEN", note: null, lockedByRunId: null });
            else throw new HttpError(409, `cannot move a ${task.status} task to ${String(body.status)}`);
          }
          if (body.assignee !== undefined) {
            if (task.status === "RUNNING") throw new HttpError(409, "cannot reassign a running task");
            const assignee = body.assignee === null ? null : resolveAgent(store, task.company_id, String(body.assignee));
            if (body.assignee !== null && !assignee) throw new HttpError(400, "assignee must be an agent of this company (id or name)");
            store.updateTask(id, { assigneeAgentId: assignee?.id ?? null });
          }
          this.emit({ type: "task.changed", taskId: id, companyId: task.company_id });
          return this.json(res, 200, { task: store.getTask(id) });
        }
        case "POST /tasks/:id/run": {
          const task = store.getTask(id);
          if (!task) throw new HttpError(404, "task not found");
          if (!this.o.runTask) throw new HttpError(404, "tasks are not enabled");
          if (this.taskBusy) throw new HttpError(409, "another task is running; try again shortly");
          this.taskBusy = true;
          try {
            const result = await this.o.runTask(id);
            this.emit({ type: "task.changed", taskId: id, companyId: task.company_id });
            return this.json(res, 200, { ...result, task: store.getTask(id) });
          } finally {
            this.taskBusy = false;
          }
        }
        case "GET /browser/:id": {
          if (parts[2] !== "policy") throw new HttpError(404, "not found");
          return this.json(res, 200, { policy: this.browser().policy() });
        }
        case "PUT /browser/:id": {
          if (parts[2] !== "policy") throw new HttpError(404, "not found");
          const body = await readJson(req);
          const list = (v: unknown, field: string) => {
            if (!Array.isArray(v) || v.length > 500 || !v.every(p => typeof p === "string" && /^(\*|(\*\.)?[a-z0-9.-]{1,253})$/i.test(p))) throw new HttpError(400, `${field} must be a list of host patterns (example.com, *.gov, *)`);
            return (v as string[]).map(p => p.toLowerCase());
          };
          const policy = { allow: list(body.allow, "allow"), deny: list(body.deny, "deny") };
          this.browser().setPolicy(policy);
          return this.json(res, 200, { policy });
        }
        case "POST /browser/:id": {
          if (parts[2] !== "read") throw new HttpError(404, "not found");
          const body = await readJson(req);
          return this.json(res, 200, { page: await this.browser().read(str(body.url, "url", 2000)) });
        }
        case "GET /skills":
          return this.json(res, 200, { skills: this.skills().list(), projects: this.skills().config().projects });
        case "GET /skills/:id": {
          const skill = isSkillName(parts[2]) ? this.skills().get(parts[2]) : null;
          if (!skill) throw new HttpError(404, "skill not found");
          return this.json(res, 200, { skill });
        }
        case "GET /agents/:id/skills": {
          if (!store.getAgent(id)) throw new HttpError(404, "agent not found");
          return this.json(res, 200, { skills: store.agentSkills(id) });
        }
        case "PUT /agents/:id/skills": {
          const agent = store.getAgent(id);
          if (!agent) throw new HttpError(404, "agent not found");
          const body = await readJson(req);
          if (!Array.isArray(body.skills) || body.skills.length > 20 || !body.skills.every(isSkillName)) throw new HttpError(400, "skills must be a list of at most 20 skill names");
          const known = new Set(this.skills().list().map(s => s.name));
          const missing = (body.skills as string[]).filter(s => !known.has(s));
          if (missing.length) throw new HttpError(400, `unknown skills: ${missing.join(", ")}`);
          store.setAgentSkills(id, body.skills);
          store.activity({ companyId: agent.company_id, actor: "user", verb: "skills-set", objectType: "agent", objectId: id, summary: `${agent.name}: ${(body.skills as string[]).join(", ") || "none"}` });
          this.emit({ type: "company.changed", companyId: agent.company_id });
          return this.json(res, 200, { skills: store.agentSkills(id) });
        }
        case "GET /companies/:id/memory": {
          // ?q= searches (optionally ?scope=), ?path= reads one note, otherwise the list of notes.
          const memory = this.memory();
          const q = url.searchParams.get("q"); const path = url.searchParams.get("path");
          if (q !== null) return this.json(res, 200, await memory.searchHybrid(id, q.slice(0, 500), { limit: Number(url.searchParams.get("limit") ?? 10) || 10, scope: url.searchParams.get("scope") ?? undefined }));
          if (path !== null) {
            const content = memory.read(id, path);
            if (content === null) throw new HttpError(404, "no such note yet");
            return this.json(res, 200, { path, content });
          }
          memory.reindex(id);
          const agents = store.listAgents(id).map(a => ({ id: a.id, name: a.name, ...memory.agentPaths(a) }));
          return this.json(res, 200, { docs: memory.list(id), agents });
        }
        case "PUT /companies/:id/memory": {
          const memory = this.memory();
          const body = await readJson(req);
          if (typeof body.path !== "string" || typeof body.content !== "string") throw new HttpError(400, "path and content are required");
          // Provenance only (same token either way): an edit made through `braavo mcp serve` is labelled so the
          // user can see in activity and git history what an outside agent wrote into an agent's memory.
          const author = req.headers["x-braavo-client"] === "mcp" ? "mcp" : "user";
          const doc = memory.write(id, body.path, body.content, author);
          store.activity({ companyId: id, actor: author, verb: "memory-edited", objectType: "memory", objectId: body.path, summary: body.path });
          this.emit({ type: "company.changed", companyId: id });
          return this.json(res, 200, { doc });
        }
        case "GET /companies/:id/routines":
          return this.json(res, 200, { routines: store.listRoutines(id) });
        case "POST /companies/:id/routines": {
          if (!store.getCompany(id)) throw new HttpError(404, "company not found");
          const body = await readJson(req);
          // Runaway guard (design §6.3): a routine run cannot create routines.
          if (body.origin === "routine") throw new HttpError(403, "routines cannot create routines");
          const agent = store.getAgent(str(body.agentId, "agentId", 80));
          if (!agent || agent.company_id !== id) throw new HttpError(400, "agentId must be an agent of this company");
          const rrule = str(body.rrule, "rrule", 200);
          if (!isSupportedRrule(rrule)) throw new HttpError(400, "rrule must be FREQ=MINUTELY|HOURLY|DAILY|WEEKLY with optional INTERVAL (minimum 15 minutes), or DAILY|WEEKLY|MONTHLY with BYHOUR/BYMINUTE/BYDAY/BYMONTHDAY");
          const timezone = str(body.timezone ?? "UTC", "timezone", 64);
          try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new HttpError(400, "unknown time zone"); }
          const routine = store.createRoutine({
            companyId: id, agentId: agent.id, name: str(body.name, "name", 120), prompt: str(body.prompt, "prompt", 20_000), rrule, timezone,
            createdBy: "user", preflight: body.preflight, delivery: body.delivery, catchUp: body.catchUp === "skip" ? "skip" : "once",
            nextFireAt: firstFireAt(rrule, this.now(), timezone)!,
          });
          return this.json(res, 201, { routine });
        }
        case "POST /routines/:id/run":
          return this.json(res, 200, await this.runNow(id));
        case "GET /routines/:id/executions": {
          if (!store.getRoutine(id)) throw new HttpError(404, "routine not found");
          return this.json(res, 200, { executions: store.executions(id) });
        }
        case "GET /models":
          return this.json(res, 200, await this.chat().models());
        case "GET /conversations":
          return this.json(res, 200, { conversations: this.chat().list(Number(url.searchParams.get("limit") ?? 50) || 50, url.searchParams.get("before") ?? undefined, url.searchParams.get("agentId") ?? undefined) });
        case "POST /conversations": {
          const body = await readJson(req);
          return this.json(res, 201, { conversation: this.chat().create({ title: body.title, provider: body.provider, model: body.model, effort: body.effort, agentId: body.agentId }) });
        }
        case "POST /conversations/import": {
          const body = await readJson(req, MAX_IMPORT_BODY_BYTES);
          return this.json(res, 200, this.chat().import(body.source, body.conversations));
        }
        case "GET /conversations/:id":
          return this.json(res, 200, this.chat().get(id));
        case "PATCH /conversations/:id": {
          const body = await readJson(req);
          return this.json(res, 200, { conversation: this.chat().update(id, body) });
        }
        case "DELETE /conversations/:id":
          this.chat().delete(id);
          res.writeHead(204).end();
          return;
        case "GET /conversations/:id/export": {
          const out = this.chat().export(id, url.searchParams.get("format") ?? undefined);
          res.writeHead(200, { "Content-Type": out.contentType, "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" });
          res.end(out.body);
          return;
        }
        case "POST /conversations/:id/abort":
          return this.json(res, 200, { aborted: this.chat().abort(id) });
        case "POST /conversations/:id/messages": {
          const body = await readJson(req);
          await this.streamTurn(id, body.content, res);
          return;
        }
        case "GET /search":
          return this.json(res, 200, { results: this.chat().search(url.searchParams.get("q"), Number(url.searchParams.get("limit") ?? 20) || 20) });
        default:
          throw new HttpError(404, "not found");
      }
    } catch (error) {
      const known = error instanceof HttpError || error instanceof ChatError || error instanceof CompanyError || error instanceof MemoryError || error instanceof SkillError || error instanceof BrowseError;
      const status = known ? error.status : 500;
      const code = error instanceof ChatError ? error.code : error instanceof HttpError ? error.code : undefined;
      this.json(res, status, { error: known ? error.message : "internal error", ...(code ? { code } : {}) });
    }
  }

  private chat(): ChatService {
    if (!this.o.chat) throw new HttpError(404, "chat is not enabled on this daemon");
    return this.o.chat;
  }

  private browser(): NonNullable<DaemonOptions["browser"]> {
    if (!this.o.browser) throw new HttpError(404, "the agent browser is not enabled on this daemon");
    return this.o.browser;
  }

  private triggerEngine(): TriggerEngine {
    if (!this.o.triggers) throw new HttpError(404, "triggers are not enabled on this daemon");
    return this.o.triggers;
  }

  private skills(): SkillRegistry {
    if (!this.o.skills) throw new HttpError(404, "skills are not enabled on this daemon");
    return this.o.skills;
  }

  private memory(): CompanyMemory {
    if (!this.o.memory) throw new HttpError(404, "company memory is not enabled on this daemon");
    return this.o.memory;
  }

  /** SSE turn: headers go out with the first event, so validation errors still answer as plain JSON. */
  private async streamTurn(id: string, content: unknown, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    const write = (event: ChatEvent) => {
      if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const { type, ...data } = event;
      if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    await this.chat().send(id, content, write, controller.signal);
    res.end();
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
}

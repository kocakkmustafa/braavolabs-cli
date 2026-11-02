import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { usdFor, type PriceOverrides } from "./pricing";
/**
 * Local daemon storage (platform docs/ai-company/TASARIM.tr.md §3–4): one
 * SQLite file (WAL) holding the company, agents, tasks, runs, routines and
 * their execution ledger, conversations and costs. Built-in `node:sqlite`
 * keeps the CLI near-dependency-free. Secrets never land here (keychain only).
 * Schema changes are append-only numbered migrations.
 */

const MIGRATIONS: string[] = [
  `CREATE TABLE company (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, mission TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'ACTIVE', monthly_budget_usd REAL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE agent (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
     name TEXT NOT NULL, role TEXT NOT NULL, title TEXT, system_prompt TEXT NOT NULL DEFAULT '',
     autonomy TEXT NOT NULL DEFAULT 'BALANCED', reports_to_agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
     provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, effort_rounding TEXT NOT NULL DEFAULT 'down',
     status TEXT NOT NULL DEFAULT 'idle', budget_usd_monthly REAL, heartbeat_rrule TEXT,
     engine TEXT NOT NULL DEFAULT 'native', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX agent_company ON agent(company_id);
   CREATE TABLE task (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
     title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', assignee_agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
     created_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', locked_by_run_id TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE routine (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt TEXT NOT NULL,
     rrule TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
     preflight TEXT NOT NULL DEFAULT '{"type":"none"}', delivery TEXT NOT NULL DEFAULT 'inbox',
     catch_up TEXT NOT NULL DEFAULT 'once', concurrency TEXT NOT NULL DEFAULT 'skip-if-running',
     max_runs_per_day INTEGER NOT NULL DEFAULT 24, created_by TEXT NOT NULL,
     last_fired_at TEXT, next_fire_at TEXT, created_at TEXT NOT NULL);
   CREATE TABLE routine_execution (
     id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
     scheduled_for TEXT NOT NULL, fired_at TEXT NOT NULL, outcome TEXT NOT NULL, run_id TEXT, note TEXT);
   CREATE INDEX routine_execution_routine ON routine_execution(routine_id, fired_at);
   CREATE TABLE conversation (
     id TEXT PRIMARY KEY, company_id TEXT, agent_id TEXT, title TEXT NOT NULL DEFAULT '',
     provider TEXT, model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE message (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
     role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
   CREATE VIRTUAL TABLE message_fts USING fts5(content, content='message', content_rowid='rowid');
   CREATE TRIGGER message_ai AFTER INSERT ON message BEGIN INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content); END;
   CREATE TRIGGER message_ad AFTER DELETE ON message BEGIN INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content); END;
   CREATE TABLE cost_event (
     id TEXT PRIMARY KEY, company_id TEXT, agent_id TEXT, run_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, at TEXT NOT NULL);
   CREATE TABLE activity (
     id TEXT PRIMARY KEY, company_id TEXT, actor TEXT NOT NULL, verb TEXT NOT NULL,
     object_type TEXT, object_id TEXT, summary TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
   CREATE INDEX activity_company ON activity(company_id, at);`,
  // 2: chat (plan 1.2) — per-conversation model/effort, idempotent imports, stop reasons.
  `ALTER TABLE conversation ADD COLUMN effort TEXT;
   ALTER TABLE conversation ADD COLUMN source TEXT;
   ALTER TABLE conversation ADD COLUMN external_id TEXT;
   ALTER TABLE message ADD COLUMN stop_reason TEXT;
   CREATE UNIQUE INDEX conversation_external ON conversation(source, external_id) WHERE external_id IS NOT NULL;
   CREATE INDEX conversation_updated ON conversation(updated_at);
   CREATE INDEX message_conversation ON message(conversation_id, at);`,
  // 3: temporal facts (design §7.8, FK-13) — e.g. a competitor page's prices over time.
  `CREATE TABLE fact (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
     subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
     valid_from TEXT NOT NULL, valid_to TEXT, source TEXT);
   CREATE INDEX fact_subject ON fact(company_id, subject, predicate, valid_from);`,
  // 4: tasks (plan 2.3) and USD cost/budgets (plan 2.9, FK-12).
  `ALTER TABLE cost_event ADD COLUMN priced INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE task ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE task ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
   ALTER TABLE task ADD COLUMN result TEXT;
   ALTER TABLE task ADD COLUMN note TEXT;
   ALTER TABLE task ADD COLUMN conversation_id TEXT;
   ALTER TABLE task ADD COLUMN started_at TEXT;
   ALTER TABLE task ADD COLUMN ended_at TEXT;
   CREATE INDEX task_company ON task(company_id, status, priority);
   CREATE INDEX cost_event_company ON cost_event(company_id, at);`,
  // 5: company memory (plan 4.1–4.3) — scope tree, frozen per-conversation snapshot, full-text index.
  `ALTER TABLE agent ADD COLUMN department TEXT;
   ALTER TABLE conversation ADD COLUMN memory_snapshot TEXT;
   CREATE TABLE memory_doc (
     company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE, path TEXT NOT NULL, scope TEXT NOT NULL,
     mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (company_id, path));
   CREATE VIRTUAL TABLE memory_fts USING fts5(company_id UNINDEXED, path UNINDEXED, scope UNINDEXED, heading, content, folded,
     tokenize = 'unicode61 remove_diacritics 2');`,
  // 6: skills (plan 5.3) — which SKILL.md skills an agent uses, frozen per conversation like memory.
  `CREATE TABLE agent_skill (
     agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE, skill TEXT NOT NULL, position INTEGER NOT NULL,
     PRIMARY KEY (agent_id, skill));
   ALTER TABLE conversation ADD COLUMN skills_snapshot TEXT;`,
  // 7: optional memory vectors (plan 4.3) — one normalised float32 embedding per chunk and model.
  `CREATE TABLE memory_vec (
     company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE, path TEXT NOT NULL, chunk INTEGER NOT NULL,
     model TEXT NOT NULL, hash TEXT NOT NULL, scope TEXT NOT NULL, heading TEXT NOT NULL, excerpt TEXT NOT NULL, vector BLOB NOT NULL,
     PRIMARY KEY (company_id, path, chunk, model));`,
  // 8: CLI employees (plan 3.1) — working folder, approval policy, structured task events, approval queue.
  `ALTER TABLE agent ADD COLUMN workdir TEXT;
   ALTER TABLE agent ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'ask';
   CREATE TABLE task_event (
     task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (task_id, seq));
   CREATE TABLE approval (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE, agent_id TEXT, task_id TEXT,
     title TEXT NOT NULL, tool TEXT NOT NULL, paths TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
     created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT);
   CREATE INDEX approval_status ON approval(company_id, status, created_at);`,
  // 9: compaction (plan 4.4) — a running summary per conversation and the last message it covers.
  `ALTER TABLE conversation ADD COLUMN summary TEXT;
   ALTER TABLE conversation ADD COLUMN summary_upto TEXT;`,
  // 10: the manager's ledger (plan 4.5) — goals with their task and progress ledgers; steps link back.
  `CREATE TABLE goal (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
     manager_agent_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
     ledger TEXT, replans INTEGER NOT NULL DEFAULT 0, note TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX goal_company ON goal(company_id, created_at);
   ALTER TABLE task ADD COLUMN goal_id TEXT;`,
  // 11: event triggers (plan 5.4) — rss, web change and folder watches that open tasks.
  `CREATE TABLE trigger (
     id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
     agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL,
     config TEXT NOT NULL, task_title TEXT, task_body TEXT, enabled INTEGER NOT NULL DEFAULT 1,
     state TEXT NOT NULL DEFAULT '{}', note TEXT, last_fired_at TEXT, created_at TEXT NOT NULL);
   CREATE INDEX trigger_company ON trigger(company_id);
   CREATE INDEX task_created_by ON task(created_by, created_at);`,
];

export interface TaskRow {
  id: string; company_id: string; title: string; body: string; assignee_agent_id: string | null; created_by: string; status: string;
  locked_by_run_id: string | null; priority: number; origin: string; result: string | null; note: string | null; conversation_id: string | null;
  started_at: string | null; ended_at: string | null; created_at: string; updated_at: string;
}
export const TASK_STATUSES = ["OPEN", "RUNNING", "DONE", "FAILED", "CANCELLED"] as const;

export interface TriggerRow {
  id: string; company_id: string; agent_id: string; name: string; kind: string; config: string; task_title: string | null;
  task_body: string | null; enabled: number; state: string; note: string | null; last_fired_at: string | null; created_at: string;
}

export interface GoalRow {
  id: string; company_id: string; manager_agent_id: string; title: string; body: string; status: string;
  ledger: string | null; replans: number; note: string | null; result: string | null; created_at: string; updated_at: string;
}

export interface ApprovalRow {
  id: string; company_id: string; agent_id: string | null; task_id: string | null; title: string; tool: string; paths: string;
  status: string; created_at: string; decided_at: string | null; decided_by: string | null;
}

export interface CompanyRow { id: string; name: string; mission: string; status: string; monthly_budget_usd: number | null; created_at: string; updated_at: string }
export interface AgentRow {
  id: string; company_id: string; name: string; role: string; title: string | null; system_prompt: string; autonomy: string;
  reports_to_agent_id: string | null; provider: string; model: string; effort: string | null; effort_rounding: string;
  status: string; budget_usd_monthly: number | null; heartbeat_rrule: string | null; engine: string; created_at: string; updated_at: string;
  department: string | null;
  workdir: string | null;
  approval_policy: string;
}
export interface RoutineRow {
  id: string; company_id: string; agent_id: string; name: string; prompt: string; rrule: string; timezone: string; enabled: number;
  preflight: string; delivery: string; catch_up: string; concurrency: string; max_runs_per_day: number; created_by: string;
  last_fired_at: string | null; next_fire_at: string | null; created_at: string;
}

export interface ConversationRow {
  id: string; company_id: string | null; agent_id: string | null; title: string; provider: string | null; model: string | null;
  effort: string | null; source: string | null; external_id: string | null; created_at: string; updated_at: string;
  memory_snapshot: string | null;
  skills_snapshot: string | null;
  summary: string | null;
  summary_upto: string | null;
}
export interface ConversationSummary extends ConversationRow { message_count: number; last_message: string | null }
export interface MessageRow { id: string; conversation_id: string; role: string; content: string; at: string; stop_reason: string | null }

export class DaemonStore {
  /** User price overrides (~/.braavo/prices.json); built-in prices cover Anthropic and local runtimes. */
  priceOverrides: PriceOverrides = {};
  readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Conversations and company data are private to this OS user (WAL side files too).
    if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
    for (let i = row.v; i < MIGRATIONS.length; i++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[i]);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(i + 1, this.now());
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }

  schemaVersion(): number {
    return (this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
  }

  close(): void { this.db.close(); }

  // ─── Company ───────────────────────────────────────────────────────────
  createCompany(input: { name: string; mission?: string; monthlyBudgetUsd?: number }): CompanyRow {
    const at = this.now(); const id = `co_${randomUUID()}`;
    this.db.prepare("INSERT INTO company(id, name, mission, monthly_budget_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.name, input.mission ?? "", input.monthlyBudgetUsd ?? null, at, at);
    this.activity({ companyId: id, actor: "user", verb: "created", objectType: "company", objectId: id, summary: input.name });
    return this.getCompany(id)!;
  }
  getCompany(id: string): CompanyRow | undefined { return this.db.prepare("SELECT * FROM company WHERE id = ?").get(id) as CompanyRow | undefined; }
  listCompanies(): CompanyRow[] { return this.db.prepare("SELECT * FROM company ORDER BY created_at").all() as unknown as CompanyRow[]; }

  // ─── Agents ────────────────────────────────────────────────────────────
  createAgent(input: {
    companyId: string; name: string; role: string; title?: string; systemPrompt?: string; provider: string; model: string;
    effort?: string; effortRounding?: string; reportsToAgentId?: string | null; budgetUsdMonthly?: number; engine?: string; autonomy?: string;
    heartbeatRrule?: string; status?: string;
  }): AgentRow {
    const at = this.now(); const id = `ag_${randomUUID()}`;
    this.db.prepare(`INSERT INTO agent(id, company_id, name, role, title, system_prompt, autonomy, reports_to_agent_id, provider, model,
        effort, effort_rounding, budget_usd_monthly, engine, heartbeat_rrule, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.companyId, input.name, input.role, input.title ?? null, input.systemPrompt ?? "", input.autonomy ?? "BALANCED",
        input.reportsToAgentId ?? null, input.provider, input.model, input.effort ?? null, input.effortRounding ?? "down",
        input.budgetUsdMonthly ?? null, input.engine ?? "native", input.heartbeatRrule ?? null, input.status ?? "idle", at, at);
    this.activity({ companyId: input.companyId, actor: "user", verb: "hired", objectType: "agent", objectId: id, summary: input.name });
    return this.getAgent(id)!;
  }
  getAgent(id: string): AgentRow | undefined { return this.db.prepare("SELECT * FROM agent WHERE id = ?").get(id) as AgentRow | undefined; }
  listAgents(companyId: string): AgentRow[] { return this.db.prepare("SELECT * FROM agent WHERE company_id = ? ORDER BY created_at").all(companyId) as unknown as AgentRow[]; }
  updateAgent(id: string, patch: { provider?: string; model?: string; effort?: string | null; status?: string; budgetUsdMonthly?: number | null; reportsToAgentId?: string | null; department?: string | null }): void {
    const cur = this.getAgent(id);
    if (!cur) return;
    this.db.prepare("UPDATE agent SET provider = ?, model = ?, effort = ?, status = ?, budget_usd_monthly = ?, reports_to_agent_id = ?, department = ?, updated_at = ? WHERE id = ?")
      .run(patch.provider ?? cur.provider, patch.model ?? cur.model, patch.effort === undefined ? cur.effort : patch.effort, patch.status ?? cur.status,
        patch.budgetUsdMonthly === undefined ? cur.budget_usd_monthly : patch.budgetUsdMonthly,
        patch.reportsToAgentId === undefined ? cur.reports_to_agent_id : patch.reportsToAgentId,
        patch.department === undefined ? cur.department : patch.department, this.now(), id);
  }
  // ─── Triggers (plan 5.4) ──────────────────────────────────────────────
  createTrigger(t: { id: string; companyId: string; agentId: string; name: string; kind: string; config: unknown; taskTitle?: string; taskBody?: string }): TriggerRow {
    this.db.prepare("INSERT INTO trigger(id, company_id, agent_id, name, kind, config, task_title, task_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.id, t.companyId, t.agentId, t.name, t.kind, JSON.stringify(t.config), t.taskTitle ?? null, t.taskBody ?? null, this.now());
    return this.getTrigger(t.id)!;
  }
  getTrigger(id: string): TriggerRow | undefined { return this.db.prepare("SELECT * FROM trigger WHERE id = ?").get(id) as TriggerRow | undefined; }
  listTriggers(companyId: string): TriggerRow[] { return this.db.prepare("SELECT * FROM trigger WHERE company_id = ? ORDER BY created_at").all(companyId) as unknown as TriggerRow[]; }
  listAllTriggers(): TriggerRow[] { return this.db.prepare("SELECT * FROM trigger ORDER BY created_at").all() as unknown as TriggerRow[]; }
  updateTrigger(id: string, patch: { state?: string; note?: string | null; lastFiredAt?: string; enabled?: boolean }): void {
    const cur = this.getTrigger(id);
    if (!cur) return;
    this.db.prepare("UPDATE trigger SET state = ?, note = ?, last_fired_at = ?, enabled = ? WHERE id = ?").run(
      patch.state ?? cur.state, patch.note === undefined ? cur.note : patch.note, patch.lastFiredAt ?? cur.last_fired_at,
      patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0, id);
  }
  deleteTrigger(id: string): boolean { return Number(this.db.prepare("DELETE FROM trigger WHERE id = ?").run(id).changes) > 0; }
  triggerTasksSince(triggerId: string, sinceIso: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM task WHERE created_by = ? AND created_at >= ?").get(`trigger:${triggerId}`, sinceIso) as { n: number }).n;
  }

  // ─── Goals (plan 4.5) ─────────────────────────────────────────────────
  createGoal(input: { id: string; companyId: string; managerAgentId: string; title: string; body?: string }): GoalRow {
    const now = this.now();
    this.db.prepare("INSERT INTO goal(id, company_id, manager_agent_id, title, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)")
      .run(input.id, input.companyId, input.managerAgentId, input.title, input.body ?? "", now, now);
    return this.getGoal(input.id)!;
  }
  getGoal(id: string): GoalRow | undefined { return this.db.prepare("SELECT * FROM goal WHERE id = ?").get(id) as GoalRow | undefined; }
  listGoals(companyId: string): GoalRow[] { return this.db.prepare("SELECT * FROM goal WHERE company_id = ? ORDER BY created_at DESC LIMIT 50").all(companyId) as unknown as GoalRow[]; }
  updateGoal(id: string, patch: { status?: string; ledger?: string; note?: string | null; result?: string | null; replans?: number }): void {
    const cur = this.getGoal(id);
    if (!cur) return;
    this.db.prepare("UPDATE goal SET status = ?, ledger = ?, note = ?, result = ?, replans = ?, updated_at = ? WHERE id = ?").run(
      patch.status ?? cur.status, patch.ledger ?? cur.ledger, patch.note === undefined ? cur.note : patch.note,
      patch.result === undefined ? cur.result : patch.result, patch.replans ?? cur.replans, this.now(), id);
  }
  setTaskGoal(taskId: string, goalId: string): void { this.db.prepare("UPDATE task SET goal_id = ? WHERE id = ?").run(goalId, taskId); }
  goalTasks(goalId: string): TaskRow[] { return this.db.prepare("SELECT * FROM task WHERE goal_id = ? ORDER BY created_at, rowid").all(goalId) as unknown as TaskRow[]; }

  setConversationSummary(id: string, summary: string, uptoMessageId: string): void {
    this.db.prepare("UPDATE conversation SET summary = ?, summary_upto = ? WHERE id = ?").run(summary, uptoMessageId, id);
  }

  // ─── CLI employees (plan 3.1) ─────────────────────────────────────────
  setWorker(agentId: string, w: { workdir?: string | null; approvalPolicy?: string }): void {
    const cur = this.getAgent(agentId);
    if (!cur) return;
    this.db.prepare("UPDATE agent SET workdir = ?, approval_policy = ?, updated_at = ? WHERE id = ?")
      .run(w.workdir === undefined ? cur.workdir : w.workdir, w.approvalPolicy ?? cur.approval_policy, this.now(), agentId);
  }
  addTaskEvent(taskId: string, kind: string, data: unknown): void {
    const next = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM task_event WHERE task_id = ?").get(taskId) as { n: number }).n;
    if (next > 2_000) return; // a runaway agent cannot fill the disk
    this.db.prepare("INSERT INTO task_event(task_id, seq, at, kind, data) VALUES (?, ?, ?, ?, ?)").run(taskId, next, this.now(), kind, JSON.stringify(data).slice(0, 20_000));
  }
  taskEvents(taskId: string, afterSeq = 0): Array<{ seq: number; at: string; kind: string; data: unknown }> {
    return (this.db.prepare("SELECT seq, at, kind, data FROM task_event WHERE task_id = ? AND seq > ? ORDER BY seq").all(taskId, afterSeq) as Array<{ seq: number; at: string; kind: string; data: string }>)
      .map(r => ({ seq: r.seq, at: r.at, kind: r.kind, data: JSON.parse(r.data) }));
  }
  createApproval(a: { companyId: string; agentId: string; taskId: string | null; title: string; tool: string; paths: string[] }): string {
    const id = `ap_${randomUUID()}`;
    this.db.prepare("INSERT INTO approval(id, company_id, agent_id, task_id, title, tool, paths, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(id, a.companyId, a.agentId, a.taskId, a.title.slice(0, 300), a.tool.slice(0, 40), JSON.stringify(a.paths.slice(0, 20)), this.now());
    return id;
  }
  decideApproval(id: string, status: "allowed" | "rejected" | "expired", by: string): boolean {
    return Number(this.db.prepare("UPDATE approval SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'").run(status, this.now(), by, id).changes) > 0;
  }
  getApproval(id: string): ApprovalRow | undefined { return this.db.prepare("SELECT * FROM approval WHERE id = ?").get(id) as ApprovalRow | undefined; }
  listApprovals(companyId: string, status?: string): ApprovalRow[] {
    return this.db.prepare("SELECT * FROM approval WHERE company_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 100").all(companyId, status ?? null, status ?? null) as unknown as ApprovalRow[];
  }

  /** The agent's skills in the order the user gave them (plan 5.3). */
  agentSkills(agentId: string): string[] {
    return (this.db.prepare("SELECT skill FROM agent_skill WHERE agent_id = ? ORDER BY position").all(agentId) as Array<{ skill: string }>).map(r => r.skill);
  }
  setAgentSkills(agentId: string, skills: string[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM agent_skill WHERE agent_id = ?").run(agentId);
      const ins = this.db.prepare("INSERT INTO agent_skill(agent_id, skill, position) VALUES (?, ?, ?)");
      [...new Set(skills)].forEach((s, i) => ins.run(agentId, s, i));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Token totals per agent since `sinceIso` (cost_event rows). */
  agentCosts(companyId: string, sinceIso: string): Array<{ agent_id: string | null; input_tokens: number; output_tokens: number; usd: number; runs: number }> {
    return this.db.prepare(`SELECT agent_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(usd) AS usd, COUNT(*) AS runs
        FROM cost_event WHERE company_id = ? AND at >= ? GROUP BY agent_id`).all(companyId, sinceIso) as unknown as Array<{ agent_id: string | null; input_tokens: number; output_tokens: number; usd: number; runs: number }>;
  }
  /** Latest execution per routine of a company. */
  lastExecutions(companyId: string): Array<{ routine_id: string; fired_at: string; outcome: string; note: string | null }> {
    return this.db.prepare(`SELECT e.routine_id, e.fired_at, e.outcome, e.note FROM routine_execution e JOIN routine r ON r.id = e.routine_id
        WHERE r.company_id = ? AND e.rowid = (SELECT x.rowid FROM routine_execution x WHERE x.routine_id = e.routine_id ORDER BY x.fired_at DESC, x.rowid DESC LIMIT 1)`)
      .all(companyId) as unknown as Array<{ routine_id: string; fired_at: string; outcome: string; note: string | null }>;
  }
  setAgentStatus(id: string, status: string): void {
    this.db.prepare("UPDATE agent SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), id);
  }

  // ─── Routines ──────────────────────────────────────────────────────────
  createRoutine(input: {
    companyId: string; agentId: string; name: string; prompt: string; rrule: string; timezone: string; createdBy: string;
    preflight?: unknown; delivery?: string; catchUp?: string; nextFireAt: string;
  }): RoutineRow {
    const id = `rt_${randomUUID()}`;
    this.db.prepare(`INSERT INTO routine(id, company_id, agent_id, name, prompt, rrule, timezone, preflight, delivery, catch_up, created_by, next_fire_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.companyId, input.agentId, input.name, input.prompt, input.rrule, input.timezone, JSON.stringify(input.preflight ?? { type: "none" }),
        input.delivery ?? "inbox", input.catchUp ?? "once", input.createdBy, input.nextFireAt, this.now());
    return this.getRoutine(id)!;
  }
  getRoutine(id: string): RoutineRow | undefined { return this.db.prepare("SELECT * FROM routine WHERE id = ?").get(id) as RoutineRow | undefined; }
  listRoutines(companyId?: string): RoutineRow[] {
    return (companyId
      ? this.db.prepare("SELECT * FROM routine WHERE company_id = ? ORDER BY created_at").all(companyId)
      : this.db.prepare("SELECT * FROM routine ORDER BY created_at").all()) as unknown as RoutineRow[];
  }
  recordExecution(input: { routineId: string; scheduledFor: string; outcome: string; runId?: string; note?: string; nextFireAt: string; fired: boolean }): void {
    const at = this.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO routine_execution(id, routine_id, scheduled_for, fired_at, outcome, run_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`rx_${randomUUID()}`, input.routineId, input.scheduledFor, at, input.outcome, input.runId ?? null, input.note ?? null);
      this.db.prepare(`UPDATE routine SET next_fire_at = ?${input.fired ? ", last_fired_at = ?" : ""} WHERE id = ?`)
        .run(...(input.fired ? [input.nextFireAt, at, input.routineId] : [input.nextFireAt, input.routineId]));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  executions(routineId: string, limit = 50): Array<{ scheduled_for: string; fired_at: string; outcome: string; note: string | null }> {
    return this.db.prepare("SELECT scheduled_for, fired_at, outcome, note FROM routine_execution WHERE routine_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?")
      .all(routineId, limit) as unknown as Array<{ scheduled_for: string; fired_at: string; outcome: string; note: string | null }>;
  }

  // ─── Conversations ─────────────────────────────────────────────────────
  createConversation(input: {
    companyId?: string; agentId?: string; title?: string; provider?: string; model?: string; effort?: string | null;
    source?: string; externalId?: string; createdAt?: string; memorySnapshot?: string; skillsSnapshot?: string;
  }): string {
    const at = input.createdAt ?? this.now(); const id = `cv_${randomUUID()}`;
    this.db.prepare(`INSERT INTO conversation(id, company_id, agent_id, title, provider, model, effort, source, external_id, memory_snapshot, skills_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.companyId ?? null, input.agentId ?? null, input.title ?? "", input.provider ?? null, input.model ?? null, input.effort ?? null,
        input.source ?? null, input.externalId ?? null, input.memorySnapshot || null, input.skillsSnapshot || null, at, at);
    return id;
  }
  getConversation(id: string): ConversationRow | undefined { return this.db.prepare("SELECT * FROM conversation WHERE id = ?").get(id) as ConversationRow | undefined; }
  findConversation(source: string, externalId: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversation WHERE source = ? AND external_id = ?").get(source, externalId) as ConversationRow | undefined;
  }
  /** Newest first; `before` pages by updated_at. Routine transcripts (agent conversations) are included. */
  latestConversation(source: string): ConversationRow | undefined {
    return this.db.prepare("SELECT * FROM conversation WHERE source = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(source) as ConversationRow | undefined;
  }
  listConversations(limit = 50, before?: string, agentId?: string): ConversationSummary[] {
    return this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS message_count,
        (SELECT substr(m.content, 1, 200) FROM message m WHERE m.conversation_id = c.id ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS last_message
        FROM conversation c WHERE (? IS NULL OR c.updated_at < ?) AND (? IS NULL OR c.agent_id = ?) ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`)
      .all(before ?? null, before ?? null, agentId ?? null, agentId ?? null, limit) as unknown as ConversationSummary[];
  }
  updateConversation(id: string, patch: { title?: string; provider?: string; model?: string; effort?: string | null }): void {
    const cur = this.getConversation(id);
    if (!cur) return;
    this.db.prepare("UPDATE conversation SET title = ?, provider = ?, model = ?, effort = ?, updated_at = ? WHERE id = ?")
      .run(patch.title ?? cur.title, patch.provider ?? cur.provider, patch.model ?? cur.model, patch.effort === undefined ? cur.effort : patch.effort, this.now(), id);
  }
  deleteConversation(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM conversation WHERE id = ?").run(id).changes) > 0;
  }
  addMessage(conversationId: string, role: string, content: string, opts: { at?: string; stopReason?: string } = {}): string {
    const id = `ms_${randomUUID()}`; const at = opts.at ?? this.now();
    this.db.prepare("INSERT INTO message(id, conversation_id, role, content, at, stop_reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, conversationId, role, content, at, opts.stopReason ?? null);
    this.db.prepare("UPDATE conversation SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(at, conversationId);
    return id;
  }
  messages(conversationId: string): MessageRow[] {
    return this.db.prepare("SELECT * FROM message WHERE conversation_id = ? ORDER BY at, rowid").all(conversationId) as unknown as MessageRow[];
  }
  /** Full-text search over message history (FTS5); the query is passed as a quoted phrase, never raw syntax. */
  searchMessages(query: string, limit = 20): Array<{ id: string; conversation_id: string; role: string; content: string; snippet: string; at: string }> {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    return this.db.prepare(`SELECT m.id, m.conversation_id, m.role, m.content, m.at, snippet(message_fts, 0, '', '', '…', 16) AS snippet
        FROM message_fts f JOIN message m ON m.rowid = f.rowid WHERE message_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(phrase, limit) as unknown as Array<{ id: string; conversation_id: string; role: string; content: string; snippet: string; at: string }>;
  }

  // ─── Facts ─────────────────────────────────────────────────────────────
  /** Record a value; when it differs from the current one, the current one is closed (bi-temporal, no deletes). */
  recordFact(input: { companyId: string; subject: string; predicate: string; value: string; at?: string; source?: string }): boolean {
    const at = input.at ?? this.now();
    const current = this.db.prepare("SELECT id, value FROM fact WHERE company_id = ? AND subject = ? AND predicate = ? AND valid_to IS NULL").get(input.companyId, input.subject, input.predicate) as { id: string; value: string } | undefined;
    if (current?.value === input.value) return false;
    if (current) this.db.prepare("UPDATE fact SET valid_to = ? WHERE id = ?").run(at, current.id);
    this.db.prepare("INSERT INTO fact(id, company_id, subject, predicate, value, valid_from, source) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(`fa_${randomUUID()}`, input.companyId, input.subject, input.predicate, input.value, at, input.source ?? null);
    return true;
  }
  facts(companyId: string, predicate: string, subject?: string): Array<{ subject: string; value: string; valid_from: string; valid_to: string | null }> {
    return this.db.prepare(`SELECT subject, value, valid_from, valid_to FROM fact WHERE company_id = ? AND predicate = ? AND (? IS NULL OR subject = ?)
        ORDER BY subject, valid_from, rowid`).all(companyId, predicate, subject ?? null, subject ?? null) as unknown as Array<{ subject: string; value: string; valid_from: string; valid_to: string | null }>;
  }

  // ─── Cost ──────────────────────────────────────────────────────────────
  /** Records tokens and, when the model is priced, USD; returns the USD (null when unpriced). */
  recordCost(input: { companyId?: string; agentId?: string; runId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; usd?: number }): number | null {
    const usd = input.usd ?? usdFor(input.provider, input.model, input.inputTokens, input.outputTokens, this.priceOverrides);
    this.db.prepare("INSERT INTO cost_event(id, company_id, agent_id, run_id, provider, model, input_tokens, output_tokens, usd, priced, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`ce_${randomUUID()}`, input.companyId ?? null, input.agentId ?? null, input.runId ?? null, input.provider, input.model, input.inputTokens, input.outputTokens, usd ?? 0, usd === null ? 0 : 1, this.now());
    return usd;
  }
  /** Priced USD and unpriced call count since `sinceIso`, for a company or one agent. */
  spend(companyId: string, sinceIso: string, agentId?: string): { usd: number; unpriced: number } {
    const row = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0) AS unpriced
        FROM cost_event WHERE company_id = ? AND at >= ? AND (? IS NULL OR agent_id = ?)`).get(companyId, sinceIso, agentId ?? null, agentId ?? null) as { usd: number; unpriced: number };
    return { usd: row.usd, unpriced: row.unpriced };
  }
  costEvents(companyId: string): Array<{ agent_id: string | null; provider: string; model: string; input_tokens: number; output_tokens: number; usd: number }> {
    return this.db.prepare("SELECT agent_id, provider, model, input_tokens, output_tokens, usd FROM cost_event WHERE company_id = ? ORDER BY at, rowid")
      .all(companyId) as unknown as Array<{ agent_id: string | null; provider: string; model: string; input_tokens: number; output_tokens: number; usd: number }>;
  }

  // ─── Tasks (plan 2.3) ──────────────────────────────────────────────────
  createTask(input: { companyId: string; title: string; body?: string; assigneeAgentId?: string | null; createdBy: string; priority?: number; origin?: string }): TaskRow {
    const id = `tk_${randomUUID()}`; const now = this.now();
    this.db.prepare(`INSERT INTO task(id, company_id, title, body, assignee_agent_id, created_by, status, priority, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`)
      .run(id, input.companyId, input.title, input.body ?? "", input.assigneeAgentId ?? null, input.createdBy, input.priority ?? 0, input.origin ?? "manual", now, now);
    return this.getTask(id)!;
  }
  getTask(id: string): TaskRow | undefined { return this.db.prepare("SELECT * FROM task WHERE id = ?").get(id) as TaskRow | undefined; }
  listTasks(companyId: string, status?: string, limit = 100): TaskRow[] {
    return this.db.prepare(`SELECT * FROM task WHERE company_id = ? AND (? IS NULL OR status = ?)
        ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'OPEN' THEN 1 ELSE 2 END, priority DESC, created_at DESC LIMIT ?`)
      .all(companyId, status ?? null, status ?? null, limit) as unknown as TaskRow[];
  }
  updateTask(id: string, patch: { status?: string; assigneeAgentId?: string | null; result?: string | null; note?: string | null; conversationId?: string; startedAt?: string; endedAt?: string; lockedByRunId?: string | null }): void {
    const cur = this.getTask(id);
    if (!cur) return;
    this.db.prepare(`UPDATE task SET status = ?, assignee_agent_id = ?, result = ?, note = ?, conversation_id = ?, started_at = ?, ended_at = ?, locked_by_run_id = ?, updated_at = ? WHERE id = ?`)
      .run(patch.status ?? cur.status, patch.assigneeAgentId === undefined ? cur.assignee_agent_id : patch.assigneeAgentId,
        patch.result === undefined ? cur.result : patch.result, patch.note === undefined ? cur.note : patch.note,
        patch.conversationId ?? cur.conversation_id, patch.startedAt ?? cur.started_at, patch.endedAt ?? cur.ended_at,
        patch.lockedByRunId === undefined ? cur.locked_by_run_id : patch.lockedByRunId, this.now(), id);
  }
  /** Atomically claims an OPEN task for a run; false when another run got it first. */
  claimTask(id: string, runId: string): boolean {
    const r = this.db.prepare("UPDATE task SET status = 'RUNNING', locked_by_run_id = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN' AND locked_by_run_id IS NULL")
      .run(runId, this.now(), this.now(), id) as { changes: number | bigint };
    return Number(r.changes) === 1;
  }
  /** OPEN tasks with an assignee, highest priority and oldest first. */
  runnableTasks(limit = 10): TaskRow[] {
    return this.db.prepare(`SELECT t.* FROM task t JOIN agent a ON a.id = t.assignee_agent_id
        -- Goal steps are run by the manager's ledger loop, never by the tick (plan 4.5).
        WHERE t.status = 'OPEN' AND t.locked_by_run_id IS NULL AND a.status IN ('idle', 'running') AND t.origin != 'goal'
        ORDER BY t.priority DESC, t.created_at LIMIT ?`).all(limit) as unknown as TaskRow[];
  }
  setCompanyBudget(id: string, monthlyBudgetUsd: number | null): void {
    this.db.prepare("UPDATE company SET monthly_budget_usd = ?, updated_at = ? WHERE id = ?").run(monthlyBudgetUsd, this.now(), id);
  }
  /** Whether an activity with this verb/object exists since `sinceIso` (once-per-month budget alerts). */
  hasActivity(companyId: string, verb: string, objectId: string, sinceIso: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM activity WHERE company_id = ? AND verb = ? AND object_id = ? AND at >= ? LIMIT 1").get(companyId, verb, objectId, sinceIso));
  }

  // ─── Activity ──────────────────────────────────────────────────────────
  activity(input: { companyId?: string; actor: string; verb: string; objectType?: string; objectId?: string; summary?: string }): void {
    this.db.prepare("INSERT INTO activity(id, company_id, actor, verb, object_type, object_id, summary, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`ac_${randomUUID()}`, input.companyId ?? null, input.actor, input.verb, input.objectType ?? null, input.objectId ?? null, input.summary ?? "", this.now());
  }
  recentActivity(companyId: string, limit = 50): Array<{ actor: string; verb: string; summary: string; at: string }> {
    return this.db.prepare("SELECT actor, verb, summary, at FROM activity WHERE company_id = ? ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(companyId, limit) as unknown as Array<{ actor: string; verb: string; summary: string; at: string }>;
  }
}

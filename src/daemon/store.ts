import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
];

export interface CompanyRow { id: string; name: string; mission: string; status: string; monthly_budget_usd: number | null; created_at: string; updated_at: string }
export interface AgentRow {
  id: string; company_id: string; name: string; role: string; title: string | null; system_prompt: string; autonomy: string;
  reports_to_agent_id: string | null; provider: string; model: string; effort: string | null; effort_rounding: string;
  status: string; budget_usd_monthly: number | null; heartbeat_rrule: string | null; engine: string; created_at: string; updated_at: string;
}
export interface RoutineRow {
  id: string; company_id: string; agent_id: string; name: string; prompt: string; rrule: string; timezone: string; enabled: number;
  preflight: string; delivery: string; catch_up: string; concurrency: string; max_runs_per_day: number; created_by: string;
  last_fired_at: string | null; next_fire_at: string | null; created_at: string;
}

export interface ConversationRow {
  id: string; company_id: string | null; agent_id: string | null; title: string; provider: string | null; model: string | null;
  effort: string | null; source: string | null; external_id: string | null; created_at: string; updated_at: string;
}
export interface ConversationSummary extends ConversationRow { message_count: number; last_message: string | null }
export interface MessageRow { id: string; conversation_id: string; role: string; content: string; at: string; stop_reason: string | null }

export class DaemonStore {
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
  updateAgent(id: string, patch: { provider?: string; model?: string; effort?: string | null; status?: string; budgetUsdMonthly?: number | null; reportsToAgentId?: string | null }): void {
    const cur = this.getAgent(id);
    if (!cur) return;
    this.db.prepare("UPDATE agent SET provider = ?, model = ?, effort = ?, status = ?, budget_usd_monthly = ?, reports_to_agent_id = ?, updated_at = ? WHERE id = ?")
      .run(patch.provider ?? cur.provider, patch.model ?? cur.model, patch.effort === undefined ? cur.effort : patch.effort, patch.status ?? cur.status,
        patch.budgetUsdMonthly === undefined ? cur.budget_usd_monthly : patch.budgetUsdMonthly,
        patch.reportsToAgentId === undefined ? cur.reports_to_agent_id : patch.reportsToAgentId, this.now(), id);
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
    source?: string; externalId?: string; createdAt?: string;
  }): string {
    const at = input.createdAt ?? this.now(); const id = `cv_${randomUUID()}`;
    this.db.prepare(`INSERT INTO conversation(id, company_id, agent_id, title, provider, model, effort, source, external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.companyId ?? null, input.agentId ?? null, input.title ?? "", input.provider ?? null, input.model ?? null, input.effort ?? null,
        input.source ?? null, input.externalId ?? null, at, at);
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
  listConversations(limit = 50, before?: string): ConversationSummary[] {
    return this.db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS message_count,
        (SELECT substr(m.content, 1, 200) FROM message m WHERE m.conversation_id = c.id ORDER BY m.at DESC, m.rowid DESC LIMIT 1) AS last_message
        FROM conversation c WHERE (? IS NULL OR c.updated_at < ?) ORDER BY c.updated_at DESC, c.rowid DESC LIMIT ?`)
      .all(before ?? null, before ?? null, limit) as unknown as ConversationSummary[];
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

  // ─── Cost ──────────────────────────────────────────────────────────────
  recordCost(input: { companyId?: string; agentId?: string; runId?: string; provider: string; model: string; inputTokens: number; outputTokens: number; usd?: number }): void {
    this.db.prepare("INSERT INTO cost_event(id, company_id, agent_id, run_id, provider, model, input_tokens, output_tokens, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`ce_${randomUUID()}`, input.companyId ?? null, input.agentId ?? null, input.runId ?? null, input.provider, input.model, input.inputTokens, input.outputTokens, input.usd ?? 0, this.now());
  }
  costEvents(companyId: string): Array<{ agent_id: string | null; provider: string; model: string; input_tokens: number; output_tokens: number; usd: number }> {
    return this.db.prepare("SELECT agent_id, provider, model, input_tokens, output_tokens, usd FROM cost_event WHERE company_id = ? ORDER BY at, rowid")
      .all(companyId) as unknown as Array<{ agent_id: string | null; provider: string; model: string; input_tokens: number; output_tokens: number; usd: number }>;
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

/**
 * MIRROR of @braavo/core (braavolabs platform monorepo, packages/braavo-core/src/company.ts
 * at dbb047d). The CLI is a separate repo and cannot import the workspace package, so the
 * file is copied verbatim below this header, the same discipline as forge/relay-protocol.ts.
 * Change it in @braavo/core first, then re-copy.
 */
import { z } from "zod";
import { AGENT_EFFORTS, type AgentEffort, type EffortRounding } from "./effort";
import { AI_PROVIDERS } from "./providers";

/**
 * Company, agent and routine shapes for the AI company (docs/ai-company/TASARIM.tr.md §4–6).
 * Same names and meanings as the platform Prisma models, plus the org fields the
 * design adds (reportsTo, provider, effort, effortRounding, status, budget, heartbeat).
 * Storage-neutral: the cloud server maps these to Postgres, the local daemon to SQLite.
 */

export const AGENT_STATUSES = ["idle", "running", "waiting", "error", "paused"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AUTONOMY_LEVELS = ["SUPERVISED", "BALANCED", "AUTONOMOUS"] as const;

const id = z.string().min(1).max(64);

export const AgentSpecSchema = z.object({
  id,
  companyId: id,
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(80),
  title: z.string().max(80).optional(),
  systemPrompt: z.string().max(20_000),
  tools: z.array(z.string().min(1).max(120)).default([]),
  autonomy: z.enum(AUTONOMY_LEVELS).default("BALANCED"),
  reportsToAgentId: id.nullable().default(null),
  provider: z.enum(AI_PROVIDERS),
  model: z.string().min(1).max(200),
  effort: z.enum(AGENT_EFFORTS as unknown as [AgentEffort, ...AgentEffort[]]).optional(),
  effortRounding: z.enum(["down", "up"] as const satisfies readonly EffortRounding[]).default("down"),
  status: z.enum(AGENT_STATUSES).default("idle"),
  budgetUsdMonthly: z.number().nonnegative().max(100_000).optional(),
  heartbeatRrule: z.string().max(500).optional(),
  /** `native` = our agent loop; `acp:<name>` = an external agent over ACP; `process` = a local command. */
  engine: z.string().regex(/^(native|process|acp:[a-z0-9-]{1,40})$/).default("native"),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export type OrgIssue =
  | { kind: "self-report"; agentId: string }
  | { kind: "unknown-manager"; agentId: string; managerId: string }
  | { kind: "cross-company"; agentId: string; managerId: string }
  | { kind: "cycle"; agentIds: string[] };

/** Every agent has at most one manager in the same company; no self-reports, unknown managers or cycles. */
export function validateOrg(agents: readonly Pick<AgentSpec, "id" | "companyId" | "reportsToAgentId">[]): OrgIssue[] {
  const byId = new Map(agents.map(a => [a.id, a]));
  const issues: OrgIssue[] = [];
  for (const a of agents) {
    const m = a.reportsToAgentId;
    if (m === null || m === undefined) continue;
    if (m === a.id) issues.push({ kind: "self-report", agentId: a.id });
    else if (!byId.has(m)) issues.push({ kind: "unknown-manager", agentId: a.id, managerId: m });
    else if (byId.get(m)!.companyId !== a.companyId) issues.push({ kind: "cross-company", agentId: a.id, managerId: m });
  }
  const reported = new Set<string>();
  for (const start of agents) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null | undefined = start.id;
    while (cur && byId.has(cur) && !onPath.has(cur)) {
      path.push(cur); onPath.add(cur);
      const next: string | null | undefined = byId.get(cur)!.reportsToAgentId;
      if (next === cur) break; // self-report is reported above
      cur = next;
    }
    if (cur && onPath.has(cur) && byId.get(cur)!.reportsToAgentId !== cur) {
      const cycle = path.slice(path.indexOf(cur)).sort();
      const key = cycle.join(",");
      if (!reported.has(key)) { reported.add(key); issues.push({ kind: "cycle", agentIds: cycle }); }
    }
  }
  return issues;
}

/** True when `toId` is a direct or indirect report of `fromId` (delegation only flows down). */
export function canDelegate(agents: readonly Pick<AgentSpec, "id" | "reportsToAgentId">[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const byId = new Map(agents.map(a => [a.id, a]));
  const seen = new Set<string>();
  let cur = byId.get(toId)?.reportsToAgentId ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === fromId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.reportsToAgentId ?? null;
  }
  return false;
}

export interface OrgNode { id: string; children: OrgNode[] }

/** Forest of reporting lines (roots report to a human). Agents caught in a cycle are omitted; validate first. */
export function orgTree(agents: readonly Pick<AgentSpec, "id" | "reportsToAgentId">[]): OrgNode[] {
  const children = new Map<string | null, string[]>();
  const ids = new Set(agents.map(a => a.id));
  for (const a of agents) {
    const parent = a.reportsToAgentId && ids.has(a.reportsToAgentId) && a.reportsToAgentId !== a.id ? a.reportsToAgentId : null;
    children.set(parent, [...(children.get(parent) ?? []), a.id]);
  }
  const build = (nodeId: string, seen: Set<string>): OrgNode => ({
    id: nodeId,
    children: (children.get(nodeId) ?? []).filter(c => !seen.has(c)).map(c => build(c, new Set([...seen, c]))),
  });
  return (children.get(null) ?? []).map(root => build(root, new Set([root])));
}

// ─── Routines ───────────────────────────────────────────────────────────

export const NOTIFY_KINDS = ["price", "plans", "promo", "release", "text"] as const;

function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

export const RoutineSpecSchema = z.object({
  id,
  companyId: id,
  agentId: id,
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(20_000),
  /** RFC 5545 recurrence rule, e.g. FREQ=HOURLY;INTERVAL=6. */
  rrule: z.string().regex(/^(RRULE:)?FREQ=(MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/).max(500),
  timezone: z.string().refine(isTimeZone, "unknown IANA time zone"),
  enabled: z.boolean().default(true),
  preflight: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("web"), urls: z.array(z.url({ protocol: /^https?$/ })).min(1).max(20), notify: z.array(z.enum(NOTIFY_KINDS)).min(1) }),
    z.object({ type: z.literal("rss"), urls: z.array(z.url({ protocol: /^https?$/ })).min(1).max(20) }),
    z.object({ type: z.literal("script"), command: z.string().min(1).max(2000), allowedDomains: z.array(z.string().max(253)).max(20).default([]) }),
  ]).default({ type: "none" }),
  delivery: z.enum(["inbox", "push", "silent-unless-change"]).default("inbox"),
  catchUp: z.enum(["skip", "once"]).default("once"),
  concurrency: z.enum(["skip-if-running", "queue"]).default("skip-if-running"),
  maxRunsPerDay: z.number().int().min(1).max(1440).default(24),
  budgetUsdPerRun: z.number().nonnegative().max(1000).optional(),
  /** Set by the scheduler; a routine created from inside a routine run is refused (design §6.3). */
  createdBy: z.union([z.literal("user"), z.string().regex(/^agent:[A-Za-z0-9_-]{1,64}$/)]),
});
export type RoutineSpec = z.infer<typeof RoutineSpecSchema>;

/** Runaway guard: routines may not create routines. */
export function canCreateRoutine(context: { origin: "manual" | "chat" | "delegate" | "routine" | "heartbeat" }): boolean {
  return context.origin !== "routine";
}

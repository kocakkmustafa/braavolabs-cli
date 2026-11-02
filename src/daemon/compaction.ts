import type { ChatMessage } from "../core/providers";
import type { AgentRow, DaemonStore, MessageRow } from "./store";
import type { CompanyMemory } from "./memory";
import { firstFireAt } from "./scheduler";

/**
 * Compaction (plan 4.4).
 *
 * Conversations: when the history the model would see passes COMPACT_AT_TOKENS, the
 * older part is (1) read once more for durable facts, decisions and commitments, which
 * go silently into the agent's journal in company memory ("memory flush"), then
 * (2) folded into a summary stored on the conversation. Later turns send the summary
 * plus the recent messages. Nothing is deleted: every message stays in the archive and
 * in search.
 *
 * Memory, nightly: a "consolidate" routine (03:30 in the company's time zone) moves old
 * journal entries of every agent into monthly archive notes, and — when the routine's
 * agent has a usable model within budget — writes a short summary of them at the top of
 * the journal. Without a model it only archives (the user's model-free setup works).
 */

export const COMPACT_AT_TOKENS = 24_000;
export const KEEP_RECENT_MESSAGES = 8;
export const JOURNAL_KEEP_ENTRIES = 12;
export const JOURNAL_MAX_BYTES = 24_000;

/** A rough, provider-neutral estimate (≈4 characters per token) — enough to decide when to fold. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function historyTokens(messages: Array<{ content: string }>, summary: string | null): number {
  return estimateTokens(summary ?? "") + messages.reduce((n, m) => n + estimateTokens(m.content), 0);
}

/** Messages after the summarised point, oldest first. */
export function unsummarised(messages: MessageRow[], upto: string | null): MessageRow[] {
  if (!upto) return messages;
  const at = messages.findIndex(m => m.id === upto);
  return at < 0 ? messages : messages.slice(at + 1);
}

export const FLUSH_PROMPT = `Below is an earlier part of a conversation that is about to be shortened.
List what is worth remembering after it: durable facts, decisions, preferences, deadlines and open commitments.
Write at most 12 short Markdown bullets in the conversation's language. If nothing is worth keeping, answer exactly: NONE`;

export const SUMMARY_PROMPT = `Summarise the earlier part of this conversation so it can continue without it:
who wants what, decisions made, open questions, and key facts or numbers. At most 250 words, in the conversation's language, plain prose or bullets.`;

const transcript = (messages: Array<{ role: string; content: string }>) =>
  messages.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n").slice(-120_000);

export type Complete = (system: string, user: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

export interface CompactResult { flushed: boolean; summarized: number }

/**
 * Fold the older part of a conversation if it is long enough. `complete` runs one
 * non-streamed call on the conversation's own model; `journal` writes the flush.
 */
export async function compactIfNeeded(
  store: DaemonStore,
  conversationId: string,
  o: { complete: Complete; journal?: (title: string, text: string) => void; limitTokens?: number; keep?: number; onCost?: (inputTokens: number, outputTokens: number) => void },
): Promise<CompactResult | null> {
  const c = store.getConversation(conversationId);
  if (!c) return null;
  const all = store.messages(conversationId).filter(m => (m.role === "user" || m.role === "assistant") && m.content);
  const open = unsummarised(all, c.summary_upto);
  if (historyTokens(open, c.summary) < (o.limitTokens ?? COMPACT_AT_TOKENS)) return null;
  const keep = o.keep ?? KEEP_RECENT_MESSAGES;
  const older = open.slice(0, Math.max(0, open.length - keep));
  if (older.length < 2) return null;
  const text = transcript(older);

  let flushed = false;
  if (o.journal) {
    // A failed flush must not block the conversation; the summary below still runs.
    try {
      const r = await o.complete(FLUSH_PROMPT, text);
      o.onCost?.(r.inputTokens, r.outputTokens);
      const notes = r.text.trim();
      if (notes && notes.toUpperCase() !== "NONE") { o.journal(`Remembered from “${c.title || "a conversation"}”`, notes); flushed = true; }
    } catch { /* keep going */ }
  }
  const prior = c.summary ? `Summary so far:\n${c.summary}\n\n` : "";
  const r = await o.complete(SUMMARY_PROMPT, `${prior}${text}`);
  o.onCost?.(r.inputTokens, r.outputTokens);
  const summary = r.text.trim();
  if (!summary) return { flushed, summarized: 0 };
  store.setConversationSummary(conversationId, summary.slice(0, 8_000), older[older.length - 1].id);
  return { flushed, summarized: older.length };
}

/** What the model sees: the summary (as system context) and the messages after it. */
export function historyFor(store: DaemonStore, conversationId: string): { summary: string | null; messages: ChatMessage[] } {
  const c = store.getConversation(conversationId);
  const rows = store.messages(conversationId).filter(m => (m.role === "user" || m.role === "assistant") && m.content);
  return {
    summary: c?.summary ?? null,
    messages: unsummarised(rows, c?.summary_upto ?? null).map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
  };
}

// ── nightly consolidation ────────────────────────────────────────────────────

export const CONSOLIDATE_RRULE = "FREQ=DAILY;BYHOUR=3;BYMINUTE=30";

/** Journal text → entries at "## " headings (the preamble, if any, stays first). */
export function journalEntries(text: string): { head: string; entries: string[] } {
  const parts = text.split(/\n(?=## )/);
  const head = parts[0].startsWith("## ") ? "" : parts.shift()!.trim();
  return { head, entries: parts.map(p => p.trim()).filter(Boolean) };
}

export interface ConsolidateReport { agents: number; archived: number; summarized: number }

/**
 * Archive old journal entries of every agent; summarise them when `summarize` is given.
 * Every write goes through CompanyMemory, so it is committed to git and re-indexed.
 */
export async function consolidateMemory(
  store: DaemonStore, memory: CompanyMemory, companyId: string,
  o: { summarize?: (agent: AgentRow, text: string) => Promise<string>; now?: () => string } = {},
): Promise<ConsolidateReport> {
  const now = o.now?.() ?? new Date().toISOString();
  const report: ConsolidateReport = { agents: 0, archived: 0, summarized: 0 };
  for (const agent of store.listAgents(companyId)) {
    const { notes } = memory.agentPaths(agent);
    const text = memory.read(companyId, notes);
    if (!text) continue;
    const { head, entries } = journalEntries(text);
    if (entries.length <= JOURNAL_KEEP_ENTRIES && Buffer.byteLength(text) <= JOURNAL_MAX_BYTES) continue;
    const keep = Math.min(JOURNAL_KEEP_ENTRIES, Math.max(1, entries.length - 1));
    const older = entries.slice(0, entries.length - keep);
    const recent = entries.slice(entries.length - keep);
    const archivePath = notes.replace(/notes\.md$/, `archive/${now.slice(0, 7)}.md`);
    memory.append(companyId, archivePath, `\n${older.join("\n\n")}\n`, "consolidation");
    let summary = "";
    if (o.summarize) {
      try { summary = (await o.summarize(agent, older.join("\n\n"))).trim().slice(0, 4_000); } catch { summary = ""; }
    }
    const preamble = [
      head && !/^## Consolidated/m.test(head) ? head : "",
      summary ? `## Consolidated through ${now.slice(0, 10)}\n\n${summary}` : "",
      `_Older entries: ${archivePath.split("/").slice(-2).join("/")}_`,
    ].filter(Boolean).join("\n\n");
    memory.write(companyId, notes, `${preamble}\n\n${recent.join("\n\n")}\n`, "consolidation");
    report.agents += 1; report.archived += older.length; if (summary) report.summarized += 1;
  }
  return report;
}

/** One consolidation routine per company (on its manager, or its first agent); created once. */
export function ensureConsolidationRoutine(store: DaemonStore, companyId: string, now = new Date()): string | null {
  const routines = store.listRoutines(companyId);
  const existing = routines.find(r => { try { return (JSON.parse(r.preflight) as { type?: string }).type === "consolidate"; } catch { return false; } });
  if (existing) return existing.id;
  const agents = store.listAgents(companyId);
  const owner = agents.find(a => a.role === "ceo") ?? agents.find(a => !a.reports_to_agent_id) ?? agents[0];
  if (!owner) return null;
  const timezone = routines.find(r => r.timezone && r.timezone !== "UTC")?.timezone ?? "UTC";
  return store.createRoutine({
    companyId, agentId: owner.id, name: "Consolidate memory", prompt: "Consolidate the company's memory journals.",
    rrule: CONSOLIDATE_RRULE, timezone, createdBy: "system", preflight: { type: "consolidate" }, catchUp: "once",
    nextFireAt: firstFireAt(CONSOLIDATE_RRULE, now, timezone)!,
  }).id;
}

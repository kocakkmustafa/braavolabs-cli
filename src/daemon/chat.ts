import type { ConversationRow, ConversationSummary, DaemonStore, MessageRow } from "./store";
import { budgetBlock, checkBudgets } from "./budget";
import { withMemory } from "./memory";
import { AI_PROVIDERS, isAIProvider, LOCAL_PROVIDERS, type AIProviderType, type ChatMessage } from "../core/providers";
import { AGENT_EFFORTS } from "../core/effort";
import { suggestModel, type ModelSuggestion, type ModelTier } from "../core/templates";
import { DEFAULT_INFERENCE_TIMEOUT_MS } from "../forge/request-scope";
import { prepareCall, redact, type ProviderDeps } from "./provider";
/**
 * Multi-turn, streamed chat on the daemon (plan 1.2; contract docs/DAEMON-CHAT.md).
 * CLI, desktop and the phone (over the relay) all talk to this one service, so a
 * conversation started on one surface continues on another. Models run on the
 * user's own keys or local models only (founder decision K3).
 */

export const MAX_CHAT_CONTENT = 100_000;
const MAX_IMPORT_CONVERSATIONS = 500;
const MAX_IMPORT_MESSAGES = 2_000;

export class ChatError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export type ChatEvent =
  | { type: "message"; id: string; role: "user" }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; messageId: string | null; stopReason: string }
  | { type: "error"; error: string; code: string };

export interface ChatDeps extends ProviderDeps {
  /** Providers the user stored a key for (names only, never values). */
  keyProviders: () => string[];
  timeoutMs?: number;
  ollamaHost?: string;
  lmStudioHost?: string;
  /** Company memory (plan 4.1): an agent conversation starts with a frozen snapshot of it. */
  memory?: { snapshot(agentId: string): string };
}

export interface ConversationDto {
  id: string; title: string; provider: string | null; model: string | null; effort: string | null;
  companyId: string | null; agentId: string | null; source: string | null; createdAt: string; updatedAt: string;
  messageCount?: number; lastMessage?: string | null;
}
export interface MessageDto { id: string; role: string; content: string; at: string; stopReason: string | null }

export interface ImportConversation {
  externalId: string; title?: string; provider?: string; model?: string; createdAt?: string;
  messages: Array<{ role: "user" | "assistant"; content: string; at?: string }>;
}

const TIERS: ModelTier[] = ["strong", "mid", "light", "analysis"];

async function localModels(fetchImpl: typeof fetch, url: string, pick: (body: any) => unknown[]): Promise<string[]> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) }); // a loaded machine answers slowly
    if (!res.ok) return [];
    return pick(await res.json()).filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200).slice(0, 100);
  } catch { return []; }
}

/** The user's own keys (names only) and the models pulled into Ollama / LM Studio (K3). */
export async function detectUserModels(keyProviders: string[], o: { fetchImpl?: typeof fetch; ollamaHost?: string; lmStudioHost?: string } = {}): Promise<{ keys: Set<AIProviderType>; local: { OLLAMA: string[]; LMSTUDIO: string[] } }> {
  const f = o.fetchImpl ?? fetch;
  const [ollama, lmstudio] = await Promise.all([
    localModels(f, `${o.ollamaHost ?? "http://localhost:11434"}/api/tags`, body => (body?.models ?? []).map((m: { name?: unknown }) => m.name)),
    localModels(f, `${o.lmStudioHost ?? "http://localhost:1234"}/v1/models`, body => (body?.data ?? []).map((m: { id?: unknown }) => m.id)),
  ]);
  return { keys: new Set(keyProviders.map(p => p.toUpperCase()).filter(isAIProvider)), local: { OLLAMA: ollama, LMSTUDIO: lmstudio } };
}

function toDto(c: ConversationRow | ConversationSummary): ConversationDto {
  const dto: ConversationDto = {
    id: c.id, title: c.title, provider: c.provider, model: c.model, effort: c.effort, companyId: c.company_id, agentId: c.agent_id,
    source: c.source, createdAt: c.created_at, updatedAt: c.updated_at,
  };
  if ("message_count" in c) { dto.messageCount = c.message_count; dto.lastMessage = c.last_message; }
  return dto;
}
const messageDto = (m: MessageRow): MessageDto => ({ id: m.id, role: m.role, content: m.content, at: m.at, stopReason: m.stop_reason });

function checkModel(provider: unknown, model: unknown, effort: unknown): { provider: AIProviderType; model: string; effort: string | null } {
  if (!isAIProvider(provider)) throw new ChatError(400, "invalid", "unknown provider");
  if (typeof model !== "string" || !model.trim() || model.length > 200) throw new ChatError(400, "invalid", "model is required (≤200 chars)");
  if (effort !== undefined && effort !== null && !(AGENT_EFFORTS as readonly unknown[]).includes(effort)) throw new ChatError(400, "invalid", "unknown effort");
  return { provider, model: model.trim(), effort: (effort as string | null | undefined) ?? null };
}

export class ChatService {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly store: DaemonStore, private readonly deps: ChatDeps, private readonly onChange: (conversationId: string) => void = () => {}) {}

  /** Providers with a stored key, pulled local models, and a suggestion per tier — never key values. */
  async models(): Promise<{ providers: Array<{ id: AIProviderType; hasKey: boolean; local: boolean }>; local: { OLLAMA: string[]; LMSTUDIO: string[] }; suggestions: Record<ModelTier, ModelSuggestion> }> {
    const user = await detectUserModels(this.deps.keyProviders(), this.deps);
    const keyed = user.keys; const local = user.local;
    const suggestions = Object.fromEntries(TIERS.map(t => [t, suggestModel(t, user)])) as Record<ModelTier, ModelSuggestion>;
    return { providers: AI_PROVIDERS.map(id => ({ id, hasKey: keyed.has(id), local: LOCAL_PROVIDERS.has(id) })), local, suggestions };
  }

  /** The user's own keys and pulled local models, as @braavo/core UserModels. */
  async userModels(): Promise<{ keys: Set<AIProviderType>; local: { OLLAMA: string[]; LMSTUDIO: string[] } }> {
    const m = await this.models();
    return { keys: new Set(m.providers.filter(p => p.hasKey).map(p => p.id)), local: m.local };
  }

  /** True when the daemon can call this provider now: a stored key, or a local provider. */
  canUse(provider: string): boolean {
    if (!isAIProvider(provider)) return false;
    return LOCAL_PROVIDERS.has(provider) || this.deps.keyProviders().some(p => p.toUpperCase() === provider);
  }

  list(limit = 50, before?: string, agentId?: string): ConversationDto[] {
    return this.store.listConversations(Math.min(Math.max(limit, 1), 200), before, agentId).map(toDto);
  }

  /**
   * A plain conversation, or one with an agent (`agentId`): the agent's model and
   * effort unless the caller picks others, its system prompt on every turn, and
   * its spend counted against the agent's and the company's budgets.
   */
  create(input: { title?: unknown; provider?: unknown; model?: unknown; effort?: unknown; source?: string; agentId?: unknown }): ConversationDto {
    let agent: ReturnType<DaemonStore["getAgent"]>;
    if (input.agentId !== undefined && input.agentId !== null) {
      agent = typeof input.agentId === "string" ? this.store.getAgent(input.agentId) : undefined;
      if (!agent) throw new ChatError(404, "not-found", "agent not found");
      if (agent.status === "error" && input.provider === undefined) throw new ChatError(400, "model-required", `${agent.name} needs setup: add a key or pull a local model (braavo setup)`);
    }
    const m = checkModel(input.provider ?? agent?.provider, input.model ?? agent?.model, input.effort === undefined ? agent?.effort : input.effort);
    const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
    const id = this.store.createConversation({
      title, provider: m.provider, model: m.model, effort: m.effort, source: input.source,
      ...(agent ? { agentId: agent.id, companyId: agent.company_id, memorySnapshot: this.deps.memory?.snapshot(agent.id) } : {}),
    });
    this.onChange(id);
    return toDto(this.store.getConversation(id)!);
  }

  get(id: string): { conversation: ConversationDto; messages: MessageDto[] } {
    const c = this.store.getConversation(id);
    if (!c) throw new ChatError(404, "not-found", "conversation not found");
    return { conversation: toDto(c), messages: this.store.messages(id).map(messageDto) };
  }

  update(id: string, patch: { title?: unknown; provider?: unknown; model?: unknown; effort?: unknown }): ConversationDto {
    const c = this.store.getConversation(id);
    if (!c) throw new ChatError(404, "not-found", "conversation not found");
    const next: { title?: string; provider?: string; model?: string; effort?: string | null } = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || patch.title.length > 200) throw new ChatError(400, "invalid", "title must be ≤200 chars");
      next.title = patch.title.trim();
    }
    if (patch.provider !== undefined || patch.model !== undefined || patch.effort !== undefined) {
      const m = checkModel(patch.provider ?? c.provider, patch.model ?? c.model, patch.effort === undefined ? c.effort : patch.effort);
      Object.assign(next, m);
    }
    this.store.updateConversation(id, next);
    this.onChange(id);
    return toDto(this.store.getConversation(id)!);
  }

  delete(id: string): void {
    this.inflight.get(id)?.abort();
    if (!this.store.deleteConversation(id)) throw new ChatError(404, "not-found", "conversation not found");
    this.onChange(id);
  }

  /** FK-7: a conversation as Markdown (readable, shareable) or JSON (lossless). */
  export(id: string, format: unknown): { contentType: string; filename: string; body: string } {
    const { conversation, messages } = this.get(id);
    const slug = (conversation.title || conversation.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "conversation";
    if (format === "json") return { contentType: "application/json", filename: `${slug}.json`, body: JSON.stringify({ conversation, messages }, null, 2) + "\n" };
    if (format !== undefined && format !== null && format !== "md") throw new ChatError(400, "invalid", "format must be md or json");
    const lines = [`# ${conversation.title || "Conversation"}`, "", `- Model: ${conversation.provider ?? "-"}/${conversation.model ?? "-"}${conversation.effort ? ` · effort ${conversation.effort}` : ""}`, `- Started: ${conversation.createdAt}`, ""];
    for (const m of messages) lines.push(`## ${m.role === "user" ? "You" : "Assistant"} · ${m.at.slice(0, 16).replace("T", " ")} UTC${m.stopReason && m.stopReason !== "end_turn" ? ` · ${m.stopReason}` : ""}`, "", m.content, "");
    return { contentType: "text/markdown; charset=utf-8", filename: `${slug}.md`, body: lines.join("\n") };
  }

  isBusy(id: string): boolean { return this.inflight.has(id); }

  abort(id: string): boolean {
    const c = this.inflight.get(id);
    c?.abort();
    return Boolean(c);
  }

  /**
   * One user turn. Validation failures throw ChatError before the first event, so
   * a server can still answer with a plain JSON error; after that everything,
   * provider errors included, arrives as events.
   */
  async send(id: string, content: unknown, emit: (event: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const c = this.store.getConversation(id);
    if (!c) throw new ChatError(404, "not-found", "conversation not found");
    if (typeof content !== "string" || !content.trim()) throw new ChatError(400, "invalid", "content is required");
    if (content.length > MAX_CHAT_CONTENT) throw new ChatError(413, "too-large", `content is limited to ${MAX_CHAT_CONTENT} characters`);
    if (this.inflight.has(id)) throw new ChatError(409, "busy", "a reply is already streaming in this conversation");
    if (!c.provider || !c.model) throw new ChatError(400, "model-required", "pick a model for this conversation first");
    const agent = c.agent_id ? this.store.getAgent(c.agent_id) : undefined;
    if (agent && c.company_id) {
      const blocked = budgetBlock(this.store, c.company_id, agent.id, new Date().toISOString());
      if (blocked) throw new ChatError(402, "budget", `${blocked}; raise the budget to spend again`);
    }
    const call = prepareCall({ provider: c.provider, model: c.model, effort: c.effort }, this.deps);
    if (!call.ok) throw new ChatError(400, call.code, call.message);

    const controller = new AbortController();
    this.inflight.set(id, controller);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const userId = this.store.addMessage(id, "user", content);
      if (!c.title) this.store.updateConversation(id, { title: content.trim().replace(/\s+/g, " ").slice(0, 60) });
      emit({ type: "message", id: userId, role: "user" });
      this.onChange(id);

      const history: ChatMessage[] = this.store.messages(id)
        .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
      let text = ""; let inputTokens = 0; let outputTokens = 0; let stopReason = "other"; let failed: string | undefined;
      try {
        const turnSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS)]);
        for await (const ev of call.stream({ system: agent ? withMemory(agent.system_prompt, c.memory_snapshot ?? "") : undefined, messages: history }, turnSignal)) {
          if (ev.type === "text") { text += ev.text; emit({ type: "delta", text: ev.text }); }
          else if (ev.type === "reasoning") emit({ type: "reasoning", text: ev.text });
          else if (ev.type === "usage") { inputTokens = ev.inputTokens; outputTokens = ev.outputTokens; }
          else if (ev.type === "done") stopReason = ev.stopReason;
        }
      } catch (error) {
        if (controller.signal.aborted) stopReason = "aborted";
        else { failed = redact(error instanceof Error ? error.message : String(error), call.apiKey, 300); stopReason = "error"; }
      }
      if (controller.signal.aborted) stopReason = "aborted";

      if (inputTokens || outputTokens) emit({ type: "usage", inputTokens, outputTokens });
      this.store.recordCost({ companyId: c.company_id ?? undefined, agentId: c.agent_id ?? undefined, runId: id, provider: c.provider, model: c.model, inputTokens, outputTokens });
      if (c.company_id) checkBudgets(this.store, c.company_id, c.agent_id ?? undefined, new Date().toISOString());
      const messageId = text ? this.store.addMessage(id, "assistant", text, { stopReason }) : null;
      if (failed) emit({ type: "error", error: failed, code: "provider" });
      emit({ type: "done", messageId, stopReason });
      this.onChange(id);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.inflight.delete(id);
    }
  }

  /** Idempotent on (source, externalId): a conversation already imported is skipped, never duplicated. */
  import(source: unknown, conversations: unknown): { imported: number; skipped: number; ids: string[] } {
    if (typeof source !== "string" || !/^[a-z0-9-]{1,40}$/.test(source)) throw new ChatError(400, "invalid", "source must be a short lower-case id");
    if (!Array.isArray(conversations) || conversations.length > MAX_IMPORT_CONVERSATIONS) throw new ChatError(400, "invalid", `conversations must be an array of at most ${MAX_IMPORT_CONVERSATIONS}`);
    const valid = conversations.map((raw, i) => {
      const c = raw as ImportConversation;
      if (typeof c?.externalId !== "string" || !c.externalId || c.externalId.length > 200) throw new ChatError(400, "invalid", `conversations[${i}].externalId is required`);
      if (!Array.isArray(c.messages) || c.messages.length > MAX_IMPORT_MESSAGES) throw new ChatError(400, "invalid", `conversations[${i}].messages must be an array`);
      for (const m of c.messages) {
        if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string" || m.content.length > MAX_CHAT_CONTENT) throw new ChatError(400, "invalid", `conversations[${i}] has an invalid message`);
      }
      return c;
    });
    const result = { imported: 0, skipped: 0, ids: [] as string[] };
    this.store.db.exec("BEGIN");
    try {
      for (const c of valid) {
        const existing = this.store.findConversation(source, c.externalId);
        if (existing) { result.skipped++; result.ids.push(existing.id); continue; }
        const createdAt = typeof c.createdAt === "string" && !Number.isNaN(Date.parse(c.createdAt)) ? new Date(c.createdAt).toISOString() : undefined;
        const id = this.store.createConversation({
          title: typeof c.title === "string" ? c.title.slice(0, 200) : "", provider: isAIProvider(c.provider) ? c.provider : undefined,
          model: typeof c.model === "string" ? c.model.slice(0, 200) : undefined, source, externalId: c.externalId, createdAt,
        });
        for (const m of c.messages) {
          const at = typeof m.at === "string" && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : undefined;
          this.store.addMessage(id, m.role, m.content, { at });
        }
        result.imported++; result.ids.push(id);
      }
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    for (const id of result.ids) this.onChange(id);
    return result;
  }

  search(query: unknown, limit = 20): Array<{ messageId: string; conversationId: string; role: string; snippet: string; at: string }> {
    if (typeof query !== "string" || !query.trim() || query.length > 200) throw new ChatError(400, "invalid", "q is required (≤200 chars)");
    return this.store.searchMessages(query.trim(), Math.min(Math.max(limit, 1), 100))
      .map(r => ({ messageId: r.id, conversationId: r.conversation_id, role: r.role, snippet: r.snippet || r.content.slice(0, 200), at: r.at }));
  }
}

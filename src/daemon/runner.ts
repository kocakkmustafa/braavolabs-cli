import type { DaemonStore } from "./store";
import { isAIProvider, LOCAL_PROVIDERS } from "../core/providers";
import { collectStream, streamAnthropic, streamOpenAICompatible, type AnthropicStreamingClient, type StreamRequest } from "../core/stream";
import { planAgentEffort } from "../core/effort";
import { DEFAULT_INFERENCE_TIMEOUT_MS } from "../forge/request-scope";
/**
 * Routine runner: one due routine → one model call for its agent, through the
 * @braavo/core streaming client (mirrored in src/core). The result lands in the
 * daemon's own SQLite (conversation + messages for search, cost event, activity).
 *
 * Keys come from the same local BYOK store as `braavo direct` (`braavo keys add
 * <provider>`, macOS keychain). A key value is only ever handed to the provider
 * client; it is never stored, logged, put in a note, or echoed back in an error.
 *
 * Not yet: tools/agent loop, preflight checks (only `{"type":"none"}` runs),
 * per-model USD pricing (cost events carry tokens, usd stays 0).
 */

export interface RunnerDeps {
  /** Local BYOK store; account names are lower-case provider ids ("anthropic", "groq"). */
  keys: { get(provider: string): string | undefined };
  fetchImpl?: typeof fetch;
  /** Builds the official SDK client for Anthropic; injected in tests. */
  anthropicClient?: (apiKey: string) => Promise<AnthropicStreamingClient>;
  timeoutMs?: number;
  maxTokens?: number;
}

export interface RunResult { outcome: string; note?: string }

const DEFAULT_MAX_TOKENS = 4096;

async function defaultAnthropicClient(apiKey: string): Promise<AnthropicStreamingClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey }) as unknown as AnthropicStreamingClient;
}

/** Some providers echo the rejected credential in error text; never let it reach the ledger. */
function redact(message: string, secret: string | undefined): string {
  return (secret ? message.split(secret).join("[redacted]") : message).slice(0, 200);
}

export async function runRoutine(store: DaemonStore, routineId: string, deps: RunnerDeps): Promise<RunResult> {
  const routine = store.getRoutine(routineId);
  if (!routine) return { outcome: "failed", note: "routine not found" };
  const agent = store.getAgent(routine.agent_id);
  if (!agent) return { outcome: "failed", note: "agent not found" };

  let preflight: { type?: unknown };
  try { preflight = JSON.parse(routine.preflight); } catch { preflight = {}; }
  if (preflight.type !== "none") return { outcome: "skipped-preflight-unsupported", note: `preflight ${String(preflight.type)} not implemented` };

  const provider = agent.provider;
  // Google uses its own REST surface and CUSTOM needs a base URL the agent row does not carry yet.
  if (!isAIProvider(provider) || provider === "GOOGLE" || provider === "CUSTOM") return { outcome: "failed", note: `provider ${provider} not supported by the daemon yet` };
  const keyName = provider.toLowerCase();
  const apiKey = LOCAL_PROVIDERS.has(provider) ? undefined : deps.keys.get(keyName);
  if (!LOCAL_PROVIDERS.has(provider) && !apiKey) return { outcome: "failed", note: `no ${keyName} key; run: braavo keys add ${keyName}` };

  // Per-agent effort: exact profiles only; anything else falls back to the provider default.
  const plan = agent.effort ? planAgentEffort({ provider, model: agent.model }, agent.effort, { rounding: agent.effort_rounding }) : undefined;
  const request: StreamRequest = {
    system: agent.system_prompt || undefined,
    messages: [{ role: "user", content: routine.prompt }],
    maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(plan?.status === "applied" ? { extraBody: plan.wire } : {}),
  };

  const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS);
  let result: Awaited<ReturnType<typeof collectStream>>;
  try {
    const events = provider === "ANTHROPIC"
      ? streamAnthropic(await (deps.anthropicClient ?? defaultAnthropicClient)(apiKey!), agent.model, request, { signal })
      : streamOpenAICompatible({ provider, model: agent.model, apiKey }, request, { fetchImpl: (deps.fetchImpl ?? fetch) as never, signal });
    result = await collectStream(events);
  } catch (error) {
    return { outcome: "failed", note: redact(error instanceof Error ? error.message : String(error), apiKey) };
  }

  const conversationId = store.createConversation({ companyId: routine.company_id, agentId: agent.id, title: routine.name });
  store.addMessage(conversationId, "user", routine.prompt);
  store.addMessage(conversationId, "assistant", result.text);
  store.recordCost({ companyId: routine.company_id, agentId: agent.id, runId: conversationId, provider, model: agent.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  store.activity({ companyId: routine.company_id, actor: agent.id, verb: "ran-routine", objectType: "routine", objectId: routine.id, summary: routine.name });

  const effortNote = plan ? (plan.status === "applied" ? `effort ${plan.providerEffort}` : `effort default (${plan.reason})`) : undefined;
  const note = [conversationId, `${result.inputTokens}/${result.outputTokens} tokens`, result.stopReason !== "end_turn" ? `stop ${result.stopReason}` : undefined, effortNote]
    .filter(Boolean).join(" · ");
  return { outcome: "ran", note };
}

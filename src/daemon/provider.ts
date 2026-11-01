import { isAIProvider, LOCAL_PROVIDERS, type StreamEvent } from "../core/providers";
import { streamAnthropic, streamOpenAICompatible, type AnthropicStreamingClient, type StreamRequest } from "../core/stream";
import { planAgentEffort, type AgentEffortPlan } from "../core/effort";
/**
 * One provider call for the daemon (routines and chat share it), through the
 * @braavo/core streaming client mirrored in src/core.
 *
 * Keys come from the same local BYOK store as `braavo direct` (`braavo keys add
 * <provider>`, macOS keychain). A key value is only ever handed to the provider
 * client; it is never stored, logged, put in a note, or echoed back in an error.
 */

export interface ProviderDeps {
  /** Local BYOK store; account names are lower-case provider ids ("anthropic", "groq"). */
  keys: { get(provider: string): string | undefined };
  fetchImpl?: typeof fetch;
  /** Builds the official SDK client for Anthropic; injected in tests. */
  anthropicClient?: (apiKey: string) => Promise<AnthropicStreamingClient>;
  maxTokens?: number;
}

export interface ProviderTarget { provider: string; model: string; effort?: string | null; effortRounding?: string | null }

export type PreparedCall =
  | { ok: true; apiKey?: string; effort?: AgentEffortPlan; stream(request: Omit<StreamRequest, "maxTokens" | "extraBody">, signal: AbortSignal): AsyncIterable<StreamEvent> }
  | { ok: false; code: "unsupported" | "missing-key"; message: string };

export const DEFAULT_MAX_TOKENS = 4096;

async function defaultAnthropicClient(apiKey: string): Promise<AnthropicStreamingClient> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey }) as unknown as AnthropicStreamingClient;
}

/** Some providers echo the rejected credential in error text; never let it reach a note or a client. */
export function redact(message: string, secret: string | undefined, max = 200): string {
  return (secret ? message.split(secret).join("[redacted]") : message).slice(0, max);
}

export function prepareCall(target: ProviderTarget, deps: ProviderDeps): PreparedCall {
  const provider = target.provider;
  // Google uses its own REST surface and CUSTOM needs a base URL the rows do not carry yet.
  if (!isAIProvider(provider) || provider === "GOOGLE" || provider === "CUSTOM") return { ok: false, code: "unsupported", message: `provider ${provider} not supported by the daemon yet` };
  const keyName = provider.toLowerCase();
  const apiKey = LOCAL_PROVIDERS.has(provider) ? undefined : deps.keys.get(keyName);
  if (!LOCAL_PROVIDERS.has(provider) && !apiKey) return { ok: false, code: "missing-key", message: `no ${keyName} key; run: braavo keys add ${keyName}` };

  // Per-agent effort: exact profiles only; anything else falls back to the provider default.
  const effort = target.effort ? planAgentEffort({ provider, model: target.model }, target.effort, { rounding: target.effortRounding ?? undefined }) : undefined;
  const extra = effort?.status === "applied" ? { extraBody: effort.wire } : {};
  return {
    ok: true, apiKey, effort,
    async *stream(request, signal) {
      const full: StreamRequest = { ...request, maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS, ...extra };
      if (provider === "ANTHROPIC") yield* streamAnthropic(await (deps.anthropicClient ?? defaultAnthropicClient)(apiKey!), target.model, full, { signal });
      else yield* streamOpenAICompatible({ provider, model: target.model, apiKey }, full, { fetchImpl: (deps.fetchImpl ?? fetch) as never, signal });
    },
  };
}

export function effortNote(plan: AgentEffortPlan | undefined): string | undefined {
  return plan ? (plan.status === "applied" ? `effort ${plan.providerEffort}` : `effort default (${plan.reason})`) : undefined;
}

/**
 * MIRROR of @braavo/core (braavolabs platform monorepo, packages/braavo-core/src/providers.ts
 * at 00071da). The CLI is a separate repo and cannot import the workspace package, so the
 * file is copied verbatim below this header, the same discipline as forge/relay-protocol.ts.
 * Change it in @braavo/core first, then re-copy.
 */
/**
 * Provider identities and defaults shared by the cloud server and the local daemon.
 * Mirrors packages/api/src/services/ai-client.ts (AIProviderType, PROVIDER_BASE_URLS,
 * LOCAL_PROVIDERS); a parity test keeps the two in step until the API consumes this package.
 */

export const AI_PROVIDERS = [
  "ANTHROPIC", "OPENAI", "GOOGLE", "MISTRAL", "GROQ", "OPENROUTER", "DEEPSEEK",
  "KIMI", "QWEN", "CEREBRAS", "ZHIPU", "OLLAMA", "LMSTUDIO", "CUSTOM",
] as const;
export type AIProviderType = (typeof AI_PROVIDERS)[number];

/** Providers that only require a base URL (no API key). */
export const LOCAL_PROVIDERS: ReadonlySet<AIProviderType> = new Set(["OLLAMA", "LMSTUDIO", "CUSTOM"]);

/** Chat-completions base URLs. ANTHROPIC and GOOGLE use their own SDK/REST surfaces. */
export const PROVIDER_BASE_URLS: Readonly<Record<Exclude<AIProviderType, "ANTHROPIC" | "GOOGLE">, string>> = Object.freeze({
  OPENAI: "https://api.openai.com/v1",
  MISTRAL: "https://api.mistral.ai/v1",
  GROQ: "https://api.groq.com/openai/v1",
  OPENROUTER: "https://openrouter.ai/api/v1",
  DEEPSEEK: "https://api.deepseek.com/v1",
  KIMI: "https://api.moonshot.ai/v1",
  QWEN: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  CEREBRAS: "https://api.cerebras.ai/v1",
  ZHIPU: "https://api.z.ai/api/paas/v4",
  OLLAMA: "http://localhost:11434/v1",
  LMSTUDIO: "http://localhost:1234/v1",
  CUSTOM: "",
});

export function isAIProvider(value: unknown): value is AIProviderType {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

/** Provider-neutral chat message. Tool results reference the call they answer. */
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ChatToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON text as produced by the model; parse with JSON.parse, never string-match. */
  argumentsJson: string;
}

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type ChatStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

/** One normalized streaming event, whatever the provider. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ChatToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: ChatStopReason };

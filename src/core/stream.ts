/**
 * MIRROR of @braavo/core (braavolabs platform monorepo, packages/braavo-core/src/stream.ts
 * at 00071da). The CLI is a separate repo and cannot import the workspace package, so the
 * file is copied verbatim below this header, the same discipline as forge/relay-protocol.ts.
 * Change it in @braavo/core first, then re-copy.
 */
import {
  LOCAL_PROVIDERS,
  PROVIDER_BASE_URLS,
  type AIProviderType,
  type ChatMessage,
  type ChatStopReason,
  type ChatToolCall,
  type ChatToolDef,
  type StreamEvent,
} from "./providers";

/**
 * Streaming chat for both runtimes. Transport is injected: the cloud server
 * passes its SSRF-guarded fetch (lib/ssrf.ts safeExternalFetch), the local
 * daemon passes global fetch. Nothing here reads keys from the environment.
 *
 * - OpenAI-compatible providers (OpenAI, Groq, Cerebras, Mistral, OpenRouter,
 *   DeepSeek, Kimi, Qwen, Zhipu, Ollama, LM Studio, custom): Chat Completions
 *   with `stream: true`, parsed from server-sent events.
 * - Anthropic: the official SDK's `client.messages.stream(...)`; the caller
 *   passes its SDK client, this module only maps the SDK's stream events.
 */

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; body?: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array> | null; text(): Promise<string>;
}>;

export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly provider: AIProviderType, detail: string) {
    super(`${provider} request failed (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderHttpError";
  }
}

// ─── Server-sent events ─────────────────────────────────────────────────

async function* toTextChunks(body: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const iterable: AsyncIterable<Uint8Array | string> = Symbol.asyncIterator in (body as object)
    ? body as AsyncIterable<Uint8Array | string>
    : (async function* () {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } } finally { reader.releaseLock(); }
      })();
  for await (const chunk of iterable) yield typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Parse an SSE byte/text stream into { event, data } messages (comments and empty data skipped). */
export async function* parseSse(body: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const flush = function* () {
    if (data.length) yield { event, data: data.join("\n") };
    event = undefined; data = [];
  };
  for await (const text of toTextChunks(body)) {
    buffer += text;
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
      if (line === "") { yield* flush(); continue; }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
    }
  }
  if (buffer) data.push(...(buffer.startsWith("data:") ? [buffer.slice(5).replace(/^ /, "")] : []));
  yield* flush();
}

// ─── OpenAI-compatible ──────────────────────────────────────────────────

export interface OpenAICompatibleConfig {
  provider: Exclude<AIProviderType, "ANTHROPIC" | "GOOGLE">;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface StreamRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  tools?: ChatToolDef[];
  /** Extra provider fields, e.g. the `wire` of an applied effort plan. */
  extraBody?: Record<string, unknown>;
}

function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({ role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argumentsJson } })) });
    } else out.push({ role: m.role, content: m.content });
  }
  return out;
}

const OPENAI_STOP: Record<string, ChatStopReason> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

export async function* streamOpenAICompatible(
  config: OpenAICompatibleConfig,
  request: StreamRequest,
  o: { fetchImpl: FetchLike; signal?: AbortSignal },
): AsyncGenerator<StreamEvent> {
  const base = (config.baseUrl?.trim() || PROVIDER_BASE_URLS[config.provider]).replace(/\/+$/, "");
  if (!base) throw new ProviderHttpError(0, config.provider, "base URL required");
  const local = LOCAL_PROVIDERS.has(config.provider);
  const body = {
    model: config.model,
    max_tokens: request.maxTokens,
    stream: true,
    // Usage in the final chunk; some local servers reject unknown fields, so only for hosted providers.
    ...(local ? {} : { stream_options: { include_usage: true } }),
    messages: toOpenAIMessages(request.system, request.messages),
    ...(request.tools?.length ? { tools: request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
    ...request.extraBody,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const res = await o.fetchImpl(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: o.signal });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new ProviderHttpError(res.status, config.provider, detail);
  }

  const calls = new Map<number, ChatToolCall>();
  let stop: ChatStopReason | undefined;
  for await (const message of parseSse(res.body)) {
    if (message.data === "[DONE]") break;
    let chunk: any;
    try { chunk = JSON.parse(message.data); } catch { continue; }
    if (chunk?.usage && typeof chunk.usage.prompt_tokens === "number") {
      yield { type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", text: reasoning };
    if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof part.index === "number" ? part.index : calls.size;
      const call = calls.get(index) ?? { id: "", name: "", argumentsJson: "" };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.argumentsJson += part.function.arguments;
      calls.set(index, call);
    }
    if (choice.finish_reason) stop = OPENAI_STOP[choice.finish_reason] ?? "other";
  }
  for (const [, call] of [...calls].sort((a, b) => a[0] - b[0])) yield { type: "tool_call", call };
  yield { type: "done", stopReason: stop ?? (calls.size ? "tool_use" : "end_turn") };
}

// ─── Anthropic (official SDK stream) ───────────────────────────────────

/** Structural slice of `@anthropic-ai/sdk`'s client: pass the real SDK instance. */
export interface AnthropicStreamingClient {
  messages: { stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): AsyncIterable<any> };
}

const ANTHROPIC_STOP: Record<string, ChatStopReason> = { end_turn: "end_turn", stop_sequence: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", refusal: "refusal", pause_turn: "other" };

function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  const push = (role: "user" | "assistant", block: unknown) => {
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(block); else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: JSON.parse(c.argumentsJson || "{}") });
    } else push("user", { type: "text", text: m.content });
  }
  return out;
}

export async function* streamAnthropic(
  client: AnthropicStreamingClient,
  model: string,
  request: StreamRequest,
  o: { signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const params: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens,
    messages: toAnthropicMessages(request.messages),
    ...(request.system ? { system: request.system } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    ...request.extraBody,
  };
  const blocks = new Map<number, ChatToolCall>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stop: ChatStopReason = "end_turn";
  for await (const ev of client.messages.stream(params, { signal: o.signal })) {
    switch (ev?.type) {
      case "message_start":
        inputTokens = ev.message?.usage?.input_tokens ?? 0;
        outputTokens = ev.message?.usage?.output_tokens ?? 0;
        break;
      case "content_block_start":
        if (ev.content_block?.type === "tool_use") blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, argumentsJson: "" });
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "text", text: ev.delta.text };
        else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) yield { type: "reasoning", text: ev.delta.thinking };
        else if (ev.delta?.type === "input_json_delta") { const b = blocks.get(ev.index); if (b) b.argumentsJson += ev.delta.partial_json ?? ""; }
        break;
      case "content_block_stop": {
        const b = blocks.get(ev.index);
        if (b) { yield { type: "tool_call", call: { ...b, argumentsJson: b.argumentsJson || "{}" } }; blocks.delete(ev.index); }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stop = ANTHROPIC_STOP[ev.delta.stop_reason] ?? "other";
        if (typeof ev.usage?.output_tokens === "number") outputTokens = ev.usage.output_tokens;
        break;
    }
  }
  yield { type: "usage", inputTokens, outputTokens };
  yield { type: "done", stopReason: stop };
}

/** Collect a stream into final text, tool calls, usage and stop reason. */
export async function collectStream(events: AsyncIterable<StreamEvent>): Promise<{ text: string; reasoning: string; toolCalls: ChatToolCall[]; inputTokens: number; outputTokens: number; stopReason: ChatStopReason }> {
  const result = { text: "", reasoning: "", toolCalls: [] as ChatToolCall[], inputTokens: 0, outputTokens: 0, stopReason: "other" as ChatStopReason };
  for await (const ev of events) {
    if (ev.type === "text") result.text += ev.text;
    else if (ev.type === "reasoning") result.reasoning += ev.text;
    else if (ev.type === "tool_call") result.toolCalls.push(ev.call);
    else if (ev.type === "usage") { result.inputTokens = ev.inputTokens; result.outputTokens = ev.outputTokens; }
    else result.stopReason = ev.stopReason;
  }
  return result;
}

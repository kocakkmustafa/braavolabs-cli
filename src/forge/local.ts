import { t } from "./locale";
import { withRequestScope, waitWithAbort, DEFAULT_INFERENCE_TIMEOUT_MS } from "./request-scope";
/**
 * braavo local — talk directly to a local Ollama server. No keys, no server
 * round-trip, works fully offline. Base URL defaults to
 * http://localhost:11434 and is overridable via OLLAMA_HOST.
 *
 * Uses Ollama's native /api/chat (stream:false) for completions and
 * /api/tags to discover installed models. `fetchImpl` is injectable so
 * tests never touch a real network or a real Ollama daemon.
 */

type FetchLike = (url: string, init?: any) => Promise<any>;

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

/** Resolve the Ollama base URL: explicit arg > OLLAMA_HOST env > default. */
export function resolveOllamaHost(explicit?: string): string {
  const raw = explicit ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
  return raw.replace(/\/+$/, "");
}

export class OllamaUnreachableError extends Error {
  constructor(host: string) {
    super(t("Ollama not reachable — is it running?"));
    this.name = "OllamaUnreachableError";
    this.host = host;
  }
  host: string;
}

async function doFetch(fetchImpl: FetchLike, host: string, path: string, init?: any): Promise<any> {
  try {
    return await waitWithAbort(fetchImpl(`${host}${path}`, init), init?.signal);
  } catch (error) {
    if (init?.signal?.aborted) throw init.signal.reason ?? error;
    // Network-level failure (connection refused, DNS, etc.) — Ollama isn't up.
    throw new OllamaUnreachableError(host);
  }
}

export interface OllamaModel {
  name: string;
}

/** GET /api/tags — installed local models. */
export async function listOllamaModels(
  host: string,
  o: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  const fetchImpl = o.fetchImpl ?? (globalThis.fetch as FetchLike);
  return withRequestScope(o, async scope => {
  const res = await scope.wait(doFetch(fetchImpl, host, "/api/tags", { signal: scope.signal }));
  if (!res.ok) throw new OllamaUnreachableError(host);
  const body: any = await scope.wait(res.json());
  const models: OllamaModel[] = Array.isArray(body?.models) ? body.models : [];
  return models.map((m) => m.name).filter(Boolean);
  });
}

export interface OllamaChatResult {
  content: string;
  model: string;
}

/** POST /api/chat with stream:false — one-shot, non-streamed completion. */
export async function ollamaChat(
  host: string,
  model: string,
  question: string,
  o: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OllamaChatResult> {
  const fetchImpl = o.fetchImpl ?? (globalThis.fetch as FetchLike);
  return withRequestScope({ ...o, timeoutMs: o.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS }, async scope => {
  const res = await scope.wait(doFetch(fetchImpl, host, "/api/chat", {
    signal: scope.signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: question }],
    }),
  }));
  if (!res.ok) {
    const body: any = await scope.wait(res.json()).catch(error => { if (scope.signal.aborted) throw scope.signal.reason; if (error instanceof SyntaxError) return {}; throw error; });
    throw new Error(body?.error ?? t("Ollama request failed ({0})", res.status));
  }
  const body: any = await scope.wait(res.json());
  const content = body?.message?.content ?? "";
  return { content: String(content), model: String(body?.model ?? model) };
  });
}

/**
 * Pick a model: explicit choice wins; otherwise the first installed model.
 * Throws (does not silently fall back to a hardcoded name) when neither is
 * available — we never guess what's installed.
 */
export async function resolveOllamaModel(
  host: string,
  explicit: string | undefined,
  o: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  if (explicit) return explicit;
  const models = await listOllamaModels(host, o);
  if (!models.length) {
    throw new Error(t("No local Ollama models installed. Run: ollama pull <model>"));
  }
  return models[0];
}

import { withRequestScope, DEFAULT_INFERENCE_TIMEOUT_MS } from "./request-scope";
import { t } from "./locale";
/**
 * braavo direct — single-shot BYOK completions straight to a provider's API,
 * bypassing the Braavolabs server entirely. Uses whatever key `braavo keys
 * add <provider>` stored locally; the key never touches the network except
 * as that provider's own auth header, and is never logged or echoed.
 *
 * Scope (Lane-A v1): anthropic, openai, groq. Each provider's request shape
 * differs (auth header, endpoint, response envelope) — kept explicit below
 * rather than papered over, so the differences are auditable.
 *
 * Model defaults are deliberately conservative, dated API identifiers — NOT
 * a claim of "latest". Override with --model; see README for how to pick a
 * current one from the provider's own docs.
 */

type FetchLike = (url: string, init?: any) => Promise<any>;

export const DIRECT_PROVIDERS = ["anthropic", "openai", "groq"] as const;
export type DirectProvider = (typeof DIRECT_PROVIDERS)[number];

export function isDirectProvider(p: string): p is DirectProvider {
  return (DIRECT_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Documented defaults (as of writing) — stable, dated model IDs, not
 * "whatever is newest". Always overridable via --model.
 */
export const DIRECT_DEFAULT_MODEL: Record<DirectProvider, string> = {
  anthropic: "claude-3-5-sonnet-20241022",
  openai: "gpt-4o-mini",
  groq: "llama-3.1-8b-instant",
};

export class DirectApiError extends Error {
  status: number;
  provider: DirectProvider;
  constructor(provider: DirectProvider, status: number, message: string) {
    super(message);
    this.name = "DirectApiError";
    this.status = status;
    this.provider = provider;
  }
}

export interface DirectChatResult {
  content: string;
  model: string;
  provider: DirectProvider;
}

interface ProviderSpec {
  url: string;
  headers: (apiKey: string) => Record<string, string>;
  body: (model: string, question: string) => unknown;
  parse: (json: any) => string;
}

const SPECS: Record<DirectProvider, ProviderSpec> = {
  // Anthropic Messages API: key goes in x-api-key, NOT Authorization/Bearer.
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    body: (model, question) => ({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: question }],
    }),
    parse: (json) => {
      const block = Array.isArray(json?.content) ? json.content.find((c: any) => c?.type === "text") : undefined;
      return String(block?.text ?? "");
    },
  },
  // OpenAI chat completions: Bearer auth.
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: (model, question) => ({
      model,
      messages: [{ role: "user", content: question }],
    }),
    parse: (json) => String(json?.choices?.[0]?.message?.content ?? ""),
  },
  // Groq: OpenAI-compatible endpoint + auth shape.
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: (model, question) => ({
      model,
      messages: [{ role: "user", content: question }],
    }),
    parse: (json) => String(json?.choices?.[0]?.message?.content ?? ""),
  },
};

/** Single-shot completion straight to `provider` using a locally stored BYOK key. */
export async function directChat(
  provider: DirectProvider,
  apiKey: string,
  model: string,
  question: string,
  o: { fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DirectChatResult> {
  const fetchImpl = o.fetchImpl ?? (globalThis.fetch as FetchLike);
  const spec = SPECS[provider];
  return withRequestScope({ ...o, timeoutMs: o.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS }, async scope => {
  const res = await scope.wait(fetchImpl(spec.url, {
    signal: scope.signal,
    method: "POST",
    headers: spec.headers(apiKey),
    body: JSON.stringify(spec.body(model, question)),
    redirect: "manual",
  }));
  // Provider-specific auth headers (including x-api-key) must not be replayed
  // to a redirect target. Keep the same fail-closed boundary as apiFetch.
  if ((res.status >= 300 && res.status < 400) || res.redirected === true) {
    throw new DirectApiError(provider, 502, t("Refusing a redirected provider response"));
  }
  if (typeof res.url === "string" && res.url) {
    let origin: string;
    try { origin = new URL(res.url).origin; }
    catch { throw new DirectApiError(provider, 502, t("Invalid provider response URL")); }
    if (origin !== new URL(spec.url).origin) {
      throw new DirectApiError(provider, 502, t("Provider response escaped its configured origin"));
    }
  }
  const json: any = await scope.wait(res.json()).catch(error => { if (scope.signal.aborted) throw scope.signal.reason; if (error instanceof SyntaxError) return {}; throw error; });
  if (!res.ok) {
    const message = json?.error?.message ?? json?.error ?? res.statusText ?? `request failed (${res.status})`;
    // Some providers echo the rejected credential in their error text.
    const safeMessage = apiKey ? String(message).split(apiKey).join("[redacted]") : String(message);
    throw new DirectApiError(provider, res.status, safeMessage);
  }
  return { content: spec.parse(json), model, provider };
  });
}

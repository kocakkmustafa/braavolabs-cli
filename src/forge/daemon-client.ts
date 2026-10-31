/**
 * braavo chat — client for the local daemon's chat API (docs/DAEMON-CHAT.md).
 * Finds the daemon through ~/.braavo/daemon/state.json + token, talks JSON and
 * reads streamed turns as SSE. The token is read per call and never printed.
 * Transport is injected so tests run without a real daemon.
 */

export type ChatStreamEvent =
  | { type: "message"; id: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; messageId: string | null; stopReason: string }
  | { type: "error"; error: string; code?: string };

export class DaemonRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export interface DaemonEndpoint { port: number; token: string }

export class DaemonClient {
  constructor(private readonly endpoint: DaemonEndpoint, private readonly fetchImpl: typeof fetch = fetch) {}

  private async raw(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(`http://127.0.0.1:${this.endpoint.port}/v1${path}`, {
      method, signal,
      headers: { Authorization: `Bearer ${this.endpoint.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let parsed: { error?: string; code?: string } = {};
      try { parsed = await res.json() as typeof parsed; } catch { /* non-JSON error body */ }
      throw new DaemonRequestError(res.status, parsed.error ?? `daemon answered ${res.status}`, parsed.code);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** One streamed turn; resolves after `done` (or the stream ends). Abort via `signal`. */
  async turn(conversationId: string, content: string, onEvent: (ev: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.raw("POST", `/conversations/${encodeURIComponent(conversationId)}/messages`, { content }, signal);
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const ev = parseFrame(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        if (ev) onEvent(ev);
      }
    }
  }
}

export function parseFrame(block: string): ChatStreamEvent | null {
  let type = ""; let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!type || !data) return null;
  try { return { type, ...JSON.parse(data) } as ChatStreamEvent; } catch { return null; }
}

/** `PROVIDER/model` → parts; the model may itself contain slashes (openai/gpt-oss-20b). */
export function parseModelFlag(value: string): { provider: string; model: string } | undefined {
  const cut = value.indexOf("/");
  if (cut <= 0 || cut === value.length - 1) return undefined;
  return { provider: value.slice(0, cut).toUpperCase(), model: value.slice(cut + 1) };
}

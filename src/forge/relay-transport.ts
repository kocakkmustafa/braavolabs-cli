/**
 * Real relay transport — the runtime implementation of RelayBridge's
 * injected `RelayTransport` (relay-bridge.ts). A near-verbatim port of the
 * Desktop app's own transport (Companion channel Dilim 2a, sealed —
 * `packages/desktop/src/relay-transport.ts`), swapped onto braavo's own
 * `apiFetch`/`Config` (client.ts/config.ts) instead of the Desktop's. Two
 * request shapes:
 *   - register/postEvent: plain JSON request/response, so these reuse
 *     client.ts's `apiFetch` VERBATIM — same Bearer-token contract, same
 *     transparent single-refresh-on-401, same Config shape as every other
 *     authenticated `braavo` → API call.
 *   - subscribeCommands: a long-lived Server-Sent-Events stream
 *     (`GET /relay/sessions/:id/commands`, packages/api/.../relay/router.ts)
 *     that needs a custom `Authorization: Bearer` header — Node's fetch has
 *     no header-carrying `EventSource`, so this reads the response body as a
 *     stream and parses SSE frames by hand (fetch + ReadableStream, not
 *     EventSource) — the same reason the Desktop mirror hand-parses SSE from
 *     its webview.
 *
 * Stream establishment uses apiFetch's credential-host, redirect and single
 * 401-refresh controls too. The subscription belongs to its captured session;
 * logout/account replacement and unsubscribe suppress subsequent commands.
 * Dropped streams reconnect with bounded backoff and the server's lastEventId
 * resume query. The subscription retains its delivered sequence cursor and
 * ignores replayed commands. A server done marker ends it permanently. This
 * does not guarantee phone delivery beyond the server's bounded replay buffer.
 */
import { apiFetch, ApiError, AuthenticationProtocolError, AuthenticationPersistenceError, SessionChangedError, captureSession, isCurrentSession } from "./client";
import { isConfigOwnerCurrent, UntrustedHostError, type Config } from "./config";
import type { RelayTransport } from "./relay-bridge";
import { ControlCommandSchema, type SessionEventInput, type SessionRegistration } from "./relay-protocol";

type FetchLike = (url: string, init?: any) => Promise<any>;

// A plain relay request (register/postEvent) must not hang forever — a
// TCP-connected but unresponsive relay (slow-loris) would otherwise leave the
// promise pending indefinitely. `spawnVendorBridged` already treats the
// relay mirror as best-effort (a start()/postEvent() failure never blocks or
// kills the spawned vendor CLI — see spawn.ts), so bounding the request here
// is the defence-in-depth half (frees the promise + lets that best-effort
// handling actually run instead of hanging). 10s is generous for a JSON
// round-trip.
const RELAY_REQUEST_TIMEOUT_MS = 10_000;

// A single SSE frame is tiny (a bounded ControlCommand). A malicious/hung
// relay that streams bytes WITHOUT a "\n\n" terminator would otherwise grow
// the receive buffer to OOM. Past this bound we drop the oversized partial
// frame (fail-closed) rather than killing the stream.
const MAX_SSE_BUFFER = 256 * 1024;
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** Backoff must be cancellable so a stopped bridge leaves no retry timer. */
function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof SessionChangedError || error instanceof UntrustedHostError ||
      error instanceof AuthenticationProtocolError || error instanceof AuthenticationPersistenceError) return false;
  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  return true; // Network/stream failure; ownership is checked before retry.
}

/** The server emits id:seq plus a session-bound command envelope. */
function parseCommandFrame(block: string, sessionId: string) {
  const payload = parseSseEvent(block);
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { sessionId?: unknown; seq?: unknown; ts?: unknown };
  if (envelope.sessionId !== sessionId || typeof envelope.seq !== "number"
      || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0 || typeof envelope.ts !== "string") return null;
  let id = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (!/^\d+$/.test(id) || Number(id) !== envelope.seq) return null;
  const parsed = ControlCommandSchema.safeParse(payload);
  return parsed.success ? { command: parsed.data, seq: envelope.seq } : null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface RelayTransportOptions {
  cfg: Config;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Persist cfg after a refresh; defaults to apiFetch's own default (see client.ts). */
  save?: (c: Config) => void;
}

// ── pure SSE framing (unit-tested independent of any real network) ──────

/**
 * Split accumulated stream text into complete `"\n\n"`-terminated SSE event
 * blocks plus the leftover partial tail (kept for the next chunk). Pure —
 * no I/O — so it is exercised directly in tests without a real stream.
 */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts, rest };
}

/**
 * Parse one SSE event block into its JSON-decoded `data:` payload. Returns
 * null for a keepalive/comment-only block (`: keepalive …`), a `event: done`
 * marker with no data line, or malformed JSON — all of which the caller
 * ignores rather than treating as a command.
 */
export function parseSseEvent(block: string): unknown | null {
  // SSE spec: an event may carry MULTIPLE `data:` lines that are joined with
  // "\n" to form the payload (a naive parser that keeps only the last line
  // mis-parses a multi-line data field to null). Strip exactly one leading
  // space per line (spec), join, then JSON-decode.
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    // "id:"/"event:" lines and ": comment" keepalives are not needed by the
    // command-dispatch path in this slice — ignored on purpose.
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n").trim();
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── the real transport ────────────────────────────────────────────────

export function createRelayTransport(opts: RelayTransportOptions): RelayTransport {
  const { cfg } = opts;

  return {
    async register(reg: SessionRegistration) {
      const res = await withTimeout(
        apiFetch("/relay/sessions", {
          method: "POST",
          body: reg,
          cfg,
          fetchImpl: opts.fetchImpl,
          save: opts.save,
        }),
        RELAY_REQUEST_TIMEOUT_MS,
        "register",
      );
      if (typeof res?.sessionId !== "string" || !res.sessionId.trim()) {
        throw new ApiError(502, "Invalid relay registration response");
      }
      return { sessionId: res.sessionId };
    },

    async postEvent(sessionId: string, ev: SessionEventInput) {
      await withTimeout(
        apiFetch(`/relay/sessions/${encodeURIComponent(sessionId)}/events`, {
          method: "POST",
          body: ev,
          cfg,
          fetchImpl: opts.fetchImpl,
          save: opts.save,
        }),
        RELAY_REQUEST_TIMEOUT_MS,
        "postEvent",
      );
    },

    subscribeCommands(sessionId: string, onCmd: (raw: unknown) => void) {
      const controller = new AbortController();
      const owner = captureSession(cfg);
      let stopped = false;
      const active = () => !stopped && isCurrentSession(cfg, owner) && isConfigOwnerCurrent(cfg);

      void (async () => {
        let lastSeq = 0;
        let retryDelay = RECONNECT_INITIAL_MS;
        while (active()) {
          const connection = new AbortController();
          const abortConnection = () => connection.abort();
          controller.signal.addEventListener("abort", abortConnection, { once: true });
          let reader: any;
          try {
            const cursor = lastSeq > 0 ? `?lastEventId=${lastSeq}` : "";
            const res = await apiFetch(`/relay/sessions/${encodeURIComponent(sessionId)}/commands${cursor}`, {
              cfg, fetchImpl: opts.fetchImpl, save: opts.save,
              stream: true, signal: connection.signal,
            });
            if (!active()) break;
            const body = res?.body;
            if (!body || typeof body.getReader !== "function") { stopped = true; break; }
            reader = body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (active()) {
              const { done, value } = await reader.read();
              if (done || !active()) break;
              buffer += decoder.decode(value, { stream: true });
              const { events, rest } = splitSseEvents(buffer);
              buffer = rest.length > MAX_SSE_BUFFER ? "" : rest;
              for (const block of events) {
                if (!active()) break;
                if (block.length > MAX_SSE_BUFFER) continue;
                if (block.split("\n").some(line => line.startsWith("event:") && line.slice(6).trim() === "done")) {
                  stopped = true;
                  break;
                }
                const frame = parseCommandFrame(block, sessionId);
                if (!frame || frame.seq <= lastSeq) continue;
                // Record delivery before the callback: it may throw after
                // taking effect, which must not cause that command to replay.
                lastSeq = frame.seq;
                retryDelay = RECONNECT_INITIAL_MS;
                try { onCmd(frame.command); } catch { /* isolate local callbacks */ }
              }
            }
          } catch (error) {
            if (!retryable(error)) stopped = true;
          } finally {
            controller.signal.removeEventListener("abort", abortConnection);
            connection.abort();
            try { await reader?.cancel?.(); } catch { /* already aborted/closed */ }
            try { reader?.releaseLock?.(); } catch { /* already released */ }
          }
          if (!active()) break;
          await waitForReconnect(retryDelay, controller.signal);
          retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2);
        }
      })();

      return () => {
        stopped = true;
        controller.abort();
      };
    },
  };
}

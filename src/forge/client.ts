import { t } from "./locale";
/**
 * braavo API client — the same dep-free fetch + single-401-refresh pattern the
 * braavo bin uses, but factored so tests can inject `fetchImpl` and `save`
 * (no disk, no network). Non-2xx throws `ApiError` (caller prints via ui.fail
 * + exit) instead of exiting inside the helper — keeps it unit-testable.
 *
 * Endpoint contracts are load-bearing here (see server routers):
 *   POST /research/compare   → { id, status:"PENDING" }  (async; poll GET /research/:id)
 *   GET  /research/:id        → full session row (PENDING→RUNNING→COMPLETED|FAILED)
 *   POST /research/cascade    → synchronous result (NO companyId in body)
 *   GET  /billing/savings     → savings report (tenant-scoped, no companyId)
 */
import { requestScope, withRequestScope, waitWithAbort, positiveTimeout, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_INFERENCE_TIMEOUT_MS } from "./request-scope";
import { Config, isConfigOwnerCurrent, saveConfigIfCurrent, assertHostSafeForCredentials, UntrustedHostError } from "./config";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Authentication response/persistence failures are terminal for a relay. */
export class AuthenticationProtocolError extends ApiError {}
export class AuthenticationPersistenceError extends Error {
  constructor(cause: unknown) {
    super(t("Could not persist refreshed authentication"), { cause });
    this.name = "AuthenticationPersistenceError";
  }
}

// Keep this distinct from malformed refresh data, persistence and host errors.
// Raw callers handle HTTP failures as results; normal callers need the status
// so a relay can retry a temporary authentication-service outage.
class TransientRefreshError extends ApiError {}

type FetchLike = (url: string, init?: any) => Promise<any>;

export interface RequestOpts {
  /** One wall-clock budget for headers, refresh waiting, replay and JSON body. */
  timeoutMs?: number;
  method?: string;
  body?: unknown;
  auth?: boolean;
  raw?: boolean;
  /** Return a successful response's stream without consuming it as JSON. */
  stream?: boolean;
  /** Cancel the request, including a replay after authentication refresh. */
  signal?: AbortSignal;
  cfg: Config;
  /** Persist cfg after a refresh; defaults to the conditional on-disk save. */
  save?: (c: Config) => void | Promise<void>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface RawResult {
  status: number;
  statusText: string;
  body: any;
}

/** A logout/login transition must invalidate even an identical restored pair. */
export class SessionChangedError extends Error {
  constructor() {
    super(t("Session changed while the request was pending"));
    this.name = "SessionChangedError";
  }
}
export interface SessionSnapshot {
  revision: number;
  apiUrl: string;
  token?: string;
  refreshToken?: string;
}
const sessions = new WeakMap<Config, SessionSnapshot>();
const refreshes = new WeakMap<Config, { owner: SessionSnapshot; promise: Promise<string | undefined> }>();

function currentSession(cfg: Config): SessionSnapshot {
  let state = sessions.get(cfg);
  if (!state) {
    state = { revision: 0, apiUrl: cfg.apiUrl, token: cfg.token, refreshToken: cfg.refreshToken };
    sessions.set(cfg, state);
  } else if (state.apiUrl !== cfg.apiUrl || state.token !== cfg.token || state.refreshToken !== cfg.refreshToken) {
    state.revision++;
    state.apiUrl = cfg.apiUrl; state.token = cfg.token; state.refreshToken = cfg.refreshToken;
  }
  return state;
}
export function captureSession(cfg: Config): SessionSnapshot {
  return { ...currentSession(cfg) };
}
export function isCurrentSession(cfg: Config, owner: SessionSnapshot): boolean {
  const state = currentSession(cfg);
  return state.revision === owner.revision && state.apiUrl === owner.apiUrl;
}
export function invalidateSession(cfg: Config): void {
  currentSession(cfg).revision++;
}
function assertSession(cfg: Config, owner: SessionSnapshot): void {
  if (!isCurrentSession(cfg, owner)) throw new SessionChangedError();
}

/** One refresh per captured owner/pair. Rotation itself keeps that owner alive. */
async function refreshSession(
  cfg: Config,
  owner: SessionSnapshot,
  doFetch: FetchLike,
  save: (c: Config) => void | Promise<void>,
): Promise<string | undefined> {
  assertSession(cfg, owner);
  const pending = refreshes.get(cfg);
  if (pending && pending.owner.revision === owner.revision && pending.owner.apiUrl === owner.apiUrl) {
    // Rotation updates memory before async persistence finishes. Join that
    // flight before reusing its pair so a late 401 cannot bypass a failed save.
    const token = await pending.promise;
    assertSession(cfg, owner);
    return token === undefined ? undefined : cfg.token;
  }
  const current = currentSession(cfg);
  if (current.token !== owner.token || current.refreshToken !== owner.refreshToken) {
    return current.token; // A late 401 can reuse the already rotated pair.
  }
  if (!owner.refreshToken) return undefined;
  let flight = refreshes.get(cfg);
  if (!flight || flight.owner.revision !== owner.revision || flight.owner.apiUrl !== owner.apiUrl ||
      flight.owner.token !== owner.token || flight.owner.refreshToken !== owner.refreshToken) {
    const promise = withRequestScope({ timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS }, async scope => {
      const r = await scope.wait(doFetch(`${owner.apiUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: owner.refreshToken }),
        signal: scope.signal,
      }));
      assertNotAborted(scope.signal);
      assertSession(cfg, owner);
      if (!r.ok) {
        if (r.status === 408 || r.status === 429 || (r.status >= 500 && r.status < 600)) {
          throw new TransientRefreshError(r.status, t("Authentication refresh temporarily unavailable"));
        }
        return undefined;
      }
      let d: { token?: string; refreshToken?: string };
      try { d = await scope.wait(r.json()); }
      catch (error) {
        if (error instanceof SyntaxError) throw new AuthenticationProtocolError(503, t("Invalid authentication response"));
        throw error; // A dropped refresh response body is still a transport failure.
      }
      assertSession(cfg, owner);
      assertNotAborted(scope.signal);
      if (typeof d?.token !== "string" || !d.token.trim() ||
          (d.refreshToken !== undefined && (typeof d.refreshToken !== "string" || !d.refreshToken.trim()))) {
        throw new AuthenticationProtocolError(503, t("Invalid authentication response"));
      }
      cfg.token = d.token;
      if (d.refreshToken !== undefined) cfg.refreshToken = d.refreshToken;
      // These writes are our own rotation, not a new account/session.
      current.token = cfg.token; current.refreshToken = cfg.refreshToken;
      try { await save(cfg); }
      catch (error) { throw new AuthenticationPersistenceError(error); }
      finally { assertSession(cfg, owner); assertNotAborted(scope.signal); }
      return cfg.token;
    });
    flight = { owner, promise };
    refreshes.set(cfg, flight);
    const cleanup = () => { if (refreshes.get(cfg) === flight) refreshes.delete(cfg); };
    void promise.then(cleanup, cleanup);
  }
  const token = await flight.promise;
  assertSession(cfg, owner);
  return token === undefined ? undefined : cfg.token;
}


/**
 * JSON request against the configured API base. Mirrors braavo's behavior:
 * Bearer auth by default, exactly one transparent refresh on 401, `raw` mode
 * hands back {status,body} so callers can branch on codes.
 */
export async function apiFetch(path: string, opts: RequestOpts): Promise<any> {
  const scope = requestScope(opts);
  try {
    assertNotAborted(scope.signal);
    const result = await scope.wait(apiFetchWithinScope(path, { ...opts, signal: scope.signal }));
    if (opts.stream && !opts.raw && result?.body) return scope.streamResponse(result);
    scope.dispose();
    return result;
  } catch (error) { scope.dispose(); throw error; }
}

async function apiFetchWithinScope(path: string, opts: RequestOpts): Promise<any> {
  const { cfg } = opts;
  const owner = captureSession(cfg);
  // BR-P0-004 — custom-host credential safety. Every credential the CLI holds
  // crosses this function: the password in the /auth/login body, the Bearer
  // access token on authed calls, and the refresh token on the 401 retry. Gate
  // the destination BEFORE any of them is put on the wire. cfg.apiUrl is
  // attacker-influenceable via `--api`, BRAAVO_API_URL and ~/.braavo/config.json.
  assertHostSafeForCredentials(owner.apiUrl, { allowCustomHost: cfg.allowCustomHost });
  const authed = opts.auth !== false;
  const save = opts.save ?? ((next: Config) => {
    let persisted = false;
    try {
      persisted = saveConfigIfCurrent(next, owner);
    } finally {
      if (!persisted) {
        invalidateSession(next);
        next.token = undefined; next.refreshToken = undefined;
      }
    }
    if (!persisted) throw new SessionChangedError();
  });
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const expectedOrigin = new URL(owner.apiUrl).origin;

  const checkedFetch: FetchLike = async (url, init = {}) => {
    // Native fetch follows 301/302/307/308 by default and can replay a POST
    // body and Authorization header to the redirect target. That would bypass
    // the host gate above after it had already approved only the initial URL.
    const res = await waitWithAbort(doFetch(url, { ...init, redirect: "manual" }), init.signal);
    const status = Number(res?.status);
    if ((status >= 300 && status < 400) || res?.redirected === true) {
      throw new UntrustedHostError(
        t("Refusing credential-bearing redirect from {0}; no redirected request was sent.", expectedOrigin),
      );
    }
    if (typeof res?.url === "string" && res.url !== "") {
      let responseOrigin: string;
      try {
        responseOrigin = new URL(res.url).origin;
      } catch {
        throw new UntrustedHostError(t("Refusing a response with an invalid final URL."));
      }
      if (responseOrigin !== expectedOrigin) {
        throw new UntrustedHostError(
          t("Refusing a response that escaped the approved API origin {0}.", expectedOrigin),
        );
      }
    }
    return res;
  };

  const req = (tok?: string) => {
    assertSession(cfg, owner);
    assertNotAborted(opts.signal);
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error(t("Request aborted"));
    return checkedFetch(`${owner.apiUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(opts.stream ? { Accept: "text/event-stream" } : {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  };

  let res = await req(authed ? owner.token : undefined);
  assertSession(cfg, owner);
    assertNotAborted(opts.signal);

  // Transparent single refresh on 401 (never on /auth/* to avoid loops).
  if (res.status === 401 && authed && owner.refreshToken && !path.startsWith("/auth/")) {
    let token: string | undefined;
    try {
      token = await waitWithAbort(refreshSession(cfg, owner, checkedFetch, save), opts.signal);
    } catch (error) {
      assertSession(cfg, owner);
    assertNotAborted(opts.signal);
      if (opts.raw && error instanceof TransientRefreshError) {
        return { status: error.status, statusText: error.message, body: { error: error.message } } satisfies RawResult;
      }
      throw error;
    }
    if (token) res = await req(token);
    assertSession(cfg, owner);
    assertNotAborted(opts.signal);
  }

  if (opts.raw) {
    const body = res.status === 204 ? null : await waitWithAbort(res.json(), opts.signal).catch(error => { assertNotAborted(opts.signal); if (error instanceof SyntaxError) return {}; throw error; });
    assertSession(cfg, owner);
    assertNotAborted(opts.signal);
    return { status: res.status, statusText: res.statusText, body } satisfies RawResult;
  }

  if (!res.ok) {
    const b = (await waitWithAbort(res.json(), opts.signal).catch(error => { assertNotAborted(opts.signal); if (error instanceof SyntaxError) return {}; throw error; })) as { error?: string; message?: string };
    assertSession(cfg, owner);
    assertNotAborted(opts.signal);
    throw new ApiError(res.status, b.error ?? b.message ?? res.statusText);
  }
  if (opts.stream) return res;
  if (res.status === 204) return null;
  const body = await waitWithAbort(res.json(), opts.signal);
  assertSession(cfg, owner);
    assertNotAborted(opts.signal);
  return body;
}

// ── typed command wrappers ──────────────────────────────────────────────────

/** Matches the server's auth response verbatim (auth.service.ts): login /
 * register / refresh all return this exact shape, refreshToken always present.
 * Aligned with the Desktop client + server truth (audit C3 drift fix). */
export interface LoginResult {
  token: string;
  refreshToken: string;
  user: { id: string; email: string; name: string | null; role: string };
  tenant: { id: string; name: string; slug: string; plan: string };
}

export async function login(
  cfg: Config,
  creds: { email: string; password: string },
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<LoginResult> {
  return apiFetch("/auth/login", {
    method: "POST",
    body: creds,
    cfg,
    auth: false,
    fetchImpl: o.fetchImpl,
    save: o.save,
  });
}

export interface CompareParams {
  selections?: { provider: string; model: string; reasoningEffort?: "low" | "medium" | "high" }[];
  companyId: string;
  query: string;
  maxCandidates?: number;
  maxTokensPerCandidate?: number;
  maxCostUsd?: number;
}

/** POST /research/compare — returns the async session stub { id, status }. */
export async function startCompare(
  cfg: Config,
  p: CompareParams,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void; signal?: AbortSignal } = {},
): Promise<{ id: string; status: string }> {
  const body: Record<string, unknown> = { companyId: p.companyId, query: p.query };
  if (p.maxCandidates !== undefined) body.maxCandidates = p.maxCandidates;
  if (p.maxTokensPerCandidate !== undefined) body.maxTokensPerCandidate = p.maxTokensPerCandidate;
  if (p.maxCostUsd !== undefined) body.maxCostUsd = p.maxCostUsd;
  if (p.selections !== undefined) body.selections = p.selections;
  const result = await abortable(apiFetch(p.selections === undefined ? "/research/compare" : "/research/compare/selected", {
    method: "POST", body, cfg, fetchImpl: o.fetchImpl, save: o.save, signal: o.signal,
  }), o.signal);
  if (typeof result?.id !== "string" || !result.id.trim()) {
    throw new ApiError(502, t("Invalid compare response; inspect research sessions before retrying."));
  }
  return result;
}

const COMPARE_TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const RUN_TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "STOPPED", "CANCELLED"]);

export interface PollOptions {
  fetchImpl?: FetchLike;
  save?: (c: Config) => void;
  signal?: AbortSignal;
  intervalMs?: number;
  maxAttempts?: number;
  /** Total polling budget, including requests, refresh, parsing and delays. */
  timeoutMs?: number;
  requestTimeoutMs?: number;
  onTick?: (status: string, attempt: number) => void;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error(t("Request aborted"));
}

/** A caller can leave a shared token refresh without cancelling other requests. */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error(t("Request aborted"))); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    pending.then(value => { cleanup(); signal.aborted ? abort() : resolve(value); },
      error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function pollDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error(t("Request aborted"))); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** GET /research/:id — the poll endpoint for both /research and /research/compare. */
export async function getSession(
  cfg: Config,
  id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void; signal?: AbortSignal } = {},
): Promise<any> {
  return abortable(apiFetch(`/research/${encodeURIComponent(id)}`, { cfg, ...o }), o.signal);
}

async function pollResource(
  cfg: Config, path: string, terminal: Set<string>, label: string, o: PollOptions,
): Promise<any> {
  const owner = captureSession(cfg);
  const assertOwner = () => {
    assertSession(cfg, owner);
    if (!isConfigOwnerCurrent(cfg)) throw new SessionChangedError();
  };
  const maxAttempts = o.maxAttempts ?? 150;
  if (maxAttempts !== Infinity && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) throw new RangeError(t("maxAttempts must be a positive integer"));
  const intervalMs = o.intervalMs ?? 2000;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new RangeError(t("intervalMs must be a finite non-negative number"));
  const deadline = Date.now() + positiveTimeout(o.timeoutMs, 300_000);
  const requestMs = positiveTimeout(o.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    assertNotAborted(o.signal);
    assertOwner();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const result = await abortable(apiFetch(path, {
      cfg, fetchImpl: o.fetchImpl, save: o.save, signal: o.signal, timeoutMs: Math.min(requestMs, remainingMs),
    }), o.signal);
    assertNotAborted(o.signal);
    assertOwner();
    if (typeof result?.status !== "string" || !result.status.trim()) {
      throw new ApiError(502, t("Invalid status while polling {0}", label));
    }
    o.onTick?.(result.status, attempt);
    assertNotAborted(o.signal);
    assertOwner();
    if (terminal.has(result.status)) return result;
    if (attempt < maxAttempts) await pollDelay(Math.min(intervalMs, Math.max(1, deadline - Date.now())), o.signal);
  }
  throw new ApiError(408, t("Timed out polling {0}", label));
}

/** Stop waiting by aborting signal; this does not cancel remote inference. */
export async function pollCompare(cfg: Config, id: string, o: PollOptions = {}): Promise<any> {
  return pollResource(cfg, `/research/${encodeURIComponent(id)}`, COMPARE_TERMINAL_STATES,
    `research session ${id}`, o);
}

/** Watch until terminal or a 30-minute local waiting budget; remote work is unchanged. */
export async function pollRun(cfg: Config, id: string, o: PollOptions = {}): Promise<any> {
  return pollResource(cfg, `/runs/${encodeURIComponent(id)}`, RUN_TERMINAL_STATES, `run ${id}`,
    { intervalMs: 3000, maxAttempts: Infinity, timeoutMs: 1_800_000, ...o });
}

export interface CancelCompareResult {
  success: true;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
}

/** Explicit server soft-cancel; terminal COMPLETED/FAILED results are preserved. */
export async function cancelCompare(
  cfg: Config, id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void; signal?: AbortSignal } = {},
): Promise<CancelCompareResult> {
  const result = await abortable(apiFetch(`/research/${encodeURIComponent(id)}/cancel`, {
    cfg, method: "POST", body: {}, ...o,
  }), o.signal);
  if (result?.success !== true || !COMPARE_TERMINAL_STATES.has(result?.status)) {
    throw new ApiError(502, t("Invalid cancellation response; inspect the research session before retrying."));
  }
  return result;
}

export interface CascadeParams {
  prompt: string;
  confidenceThreshold?: number;
  secondOpinion?: boolean;
  budgetUsdCap?: number;
}

/**
 * POST /research/cascade — SYNCHRONOUS. Deliberately sends NO companyId: the
 * endpoint is a direct tenant-scoped prompt cascade (tenant derived from JWT).
 */
export async function cascade(
  cfg: Config,
  p: CascadeParams,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<any> {
  const body: Record<string, unknown> = { prompt: p.prompt };
  if (p.confidenceThreshold !== undefined) body.confidenceThreshold = p.confidenceThreshold;
  if (p.secondOpinion !== undefined) body.secondOpinion = p.secondOpinion;
  if (p.budgetUsdCap !== undefined) body.budgetUsdCap = p.budgetUsdCap;
  return apiFetch("/research/cascade", { method: "POST", body, cfg, ...o, timeoutMs: o.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS });
}

/** POST /auth/logout — best-effort server-side refresh-token revocation. Sends
 * the refresh token in the body so the server can revoke even when the ACCESS
 * token has expired: the endpoint is auth-optional and falls back to the refresh
 * token when the bearer is dead (audit #1 — without the body an expired bearer
 * 401s and the refresh token survives sign-out). Raw so a failure (offline /
 * already-expired) is swallowed by the caller; local creds are cleared
 * regardless. Server replies 200 { message }. */
export async function logout(
  cfg: Config,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<RawResult> {
  return apiFetch("/auth/logout", { method: "POST", body: { refreshToken: cfg.refreshToken }, cfg, raw: true, fetchImpl: o.fetchImpl, save: o.save });
}

/** GET /billing/savings?days=N — tenant-scoped, no companyId. */
export async function savings(
  cfg: Config,
  p: { days?: number } = {},
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  const q = p.days !== undefined ? `?days=${encodeURIComponent(String(p.days))}` : "";
  return apiFetch(`/billing/savings${q}`, { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

// ── Media orchestration (FAZ E backend: image via fal.ai FLUX, TTS via
// Google/ElevenLabs). Contract: the server RE-computes the estimate and
// rejects generate unless acknowledgedCostUsd ≥ it (honesty mandate), so the
// CLI must always preview → show cost → send that exact estimate as the ack. ──

/** POST /media/preview → { estimate:{usd,units,note,...}, keyConfigured, acknowledgementRequired }. No spend. */
export async function mediaPreview(
  cfg: Config,
  body: Record<string, unknown>,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch("/media/preview", { method: "POST", body, cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/** POST /media/generate (raw so the caller can branch on 400 COST_ACK_REQUIRED / 402 no-key). */
export async function mediaGenerate(
  cfg: Config,
  body: Record<string, unknown>,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<RawResult> {
  return apiFetch("/media/generate", { method: "POST", body, cfg, raw: true, fetchImpl: o.fetchImpl, save: o.save });
}

/** GET /media/catalog → provider key-status (masked) + model/price catalogue. */
export async function mediaCatalog(
  cfg: Config,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch("/media/catalog", { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/** PUT /media/keys/:provider — store a tenant-scoped media BYOK key (server encrypts). */
export async function mediaKeyPut(
  cfg: Config,
  provider: string,
  apiKey: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch(`/media/keys/${encodeURIComponent(provider)}`, { method: "PUT", body: { apiKey }, cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/** DELETE /media/keys/:provider. */
export async function mediaKeyDelete(
  cfg: Config,
  provider: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<RawResult> {
  return apiFetch(`/media/keys/${encodeURIComponent(provider)}`, { method: "DELETE", cfg, raw: true, fetchImpl: o.fetchImpl, save: o.save });
}

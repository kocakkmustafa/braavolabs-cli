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
import { Config, saveConfigIfCurrent, assertHostSafeForCredentials, UntrustedHostError } from "./config";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type FetchLike = (url: string, init?: any) => Promise<any>;

export interface RequestOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  raw?: boolean;
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
    super("Session changed while the request was pending");
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
    const promise = (async () => {
      const r = await doFetch(`${owner.apiUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: owner.refreshToken }),
      });
      assertSession(cfg, owner);
      if (!r.ok) return undefined;
      const d = (await r.json()) as { token?: string; refreshToken?: string };
      assertSession(cfg, owner);
      if (typeof d?.token !== "string" || !d.token.trim() ||
          (d.refreshToken !== undefined && (typeof d.refreshToken !== "string" || !d.refreshToken.trim()))) {
        throw new ApiError(503, "Invalid authentication response");
      }
      cfg.token = d.token;
      if (d.refreshToken !== undefined) cfg.refreshToken = d.refreshToken;
      // These writes are our own rotation, not a new account/session.
      current.token = cfg.token; current.refreshToken = cfg.refreshToken;
      try { await save(cfg); } finally { assertSession(cfg, owner); }
      return cfg.token;
    })();
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
    const res = await doFetch(url, { ...init, redirect: "manual" });
    const status = Number(res?.status);
    if ((status >= 300 && status < 400) || res?.redirected === true) {
      throw new UntrustedHostError(
        `Refusing credential-bearing redirect from ${expectedOrigin}; no redirected request was sent.`,
      );
    }
    if (typeof res?.url === "string" && res.url !== "") {
      let responseOrigin: string;
      try {
        responseOrigin = new URL(res.url).origin;
      } catch {
        throw new UntrustedHostError("Refusing a response with an invalid final URL.");
      }
      if (responseOrigin !== expectedOrigin) {
        throw new UntrustedHostError(
          `Refusing a response that escaped the approved API origin ${expectedOrigin}.`,
        );
      }
    }
    return res;
  };

  const req = (tok?: string) => {
    assertSession(cfg, owner);
    return checkedFetch(`${owner.apiUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  };

  let res = await req(authed ? owner.token : undefined);
  assertSession(cfg, owner);

  // Transparent single refresh on 401 (never on /auth/* to avoid loops).
  if (res.status === 401 && authed && owner.refreshToken && !path.startsWith("/auth/")) {
    const token = await refreshSession(cfg, owner, checkedFetch, save);
    if (token) res = await req(token);
    assertSession(cfg, owner);
  }

  if (opts.raw) {
    const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    assertSession(cfg, owner);
    return { status: res.status, statusText: res.statusText, body } satisfies RawResult;
  }

  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    assertSession(cfg, owner);
    throw new ApiError(res.status, b.error ?? b.message ?? res.statusText);
  }
  if (res.status === 204) return null;
  const body = await res.json();
  assertSession(cfg, owner);
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
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<{ id: string; status: string }> {
  const body: Record<string, unknown> = { companyId: p.companyId, query: p.query };
  if (p.maxCandidates !== undefined) body.maxCandidates = p.maxCandidates;
  if (p.maxTokensPerCandidate !== undefined) body.maxTokensPerCandidate = p.maxTokensPerCandidate;
  if (p.maxCostUsd !== undefined) body.maxCostUsd = p.maxCostUsd;
  return apiFetch("/research/compare", { method: "POST", body, cfg, fetchImpl: o.fetchImpl, save: o.save });
}

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** GET /research/:id — the poll endpoint for both /research and /research/compare. */
export async function getSession(
  cfg: Config,
  id: string,
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  return apiFetch(`/research/${encodeURIComponent(id)}`, { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

/** Poll GET /research/:id until it reaches a terminal state. */
export async function pollCompare(
  cfg: Config,
  id: string,
  o: {
    fetchImpl?: FetchLike;
    save?: (c: Config) => void;
    intervalMs?: number;
    maxAttempts?: number;
    onTick?: (status: string, attempt: number) => void;
  } = {},
): Promise<any> {
  const interval = o.intervalMs ?? 2000;
  const maxAttempts = o.maxAttempts ?? 150; // ~5 min at 2s
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = await getSession(cfg, id, { fetchImpl: o.fetchImpl, save: o.save });
    const status = String(session?.status ?? "");
    o.onTick?.(status, attempt);
    if (TERMINAL_STATES.has(status)) return session;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new ApiError(408, `Timed out polling research session ${id}`);
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
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  const body: Record<string, unknown> = { prompt: p.prompt };
  if (p.confidenceThreshold !== undefined) body.confidenceThreshold = p.confidenceThreshold;
  if (p.secondOpinion !== undefined) body.secondOpinion = p.secondOpinion;
  if (p.budgetUsdCap !== undefined) body.budgetUsdCap = p.budgetUsdCap;
  return apiFetch("/research/cascade", { method: "POST", body, cfg, fetchImpl: o.fetchImpl, save: o.save });
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

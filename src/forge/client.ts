/**
 * forge API client — the same dep-free fetch + single-401-refresh pattern the
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
import { Config, saveConfig } from "./config";

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
  /** Persist cfg after a refresh; defaults to the real on-disk saveConfig. */
  save?: (c: Config) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface RawResult {
  status: number;
  statusText: string;
  body: any;
}

/**
 * JSON request against the configured API base. Mirrors braavo's behavior:
 * Bearer auth by default, exactly one transparent refresh on 401, `raw` mode
 * hands back {status,body} so callers can branch on codes.
 */
export async function apiFetch(path: string, opts: RequestOpts): Promise<any> {
  const { cfg } = opts;
  const authed = opts.auth !== false;
  const save = opts.save ?? saveConfig;
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

  const req = (tok?: string) =>
    doFetch(`${cfg.apiUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

  let res = await req(authed ? cfg.token : undefined);

  // Transparent single refresh on 401 (never on /auth/* to avoid loops).
  if (res.status === 401 && authed && cfg.refreshToken && !path.startsWith("/auth/")) {
    const r = await doFetch(`${cfg.apiUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: cfg.refreshToken }),
    });
    if (r.ok) {
      const d = (await r.json()) as { token: string; refreshToken?: string };
      cfg.token = d.token;
      if (d.refreshToken) cfg.refreshToken = d.refreshToken;
      save(cfg);
      res = await req(cfg.token);
    }
  }

  if (opts.raw) {
    const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { status: res.status, statusText: res.statusText, body } satisfies RawResult;
  }

  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, b.error ?? b.message ?? res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── typed command wrappers ──────────────────────────────────────────────────

export interface LoginResult {
  token: string;
  refreshToken?: string;
  user?: { email?: string };
  tenant?: { name?: string; plan?: string };
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

/** GET /billing/savings?days=N — tenant-scoped, no companyId. */
export async function savings(
  cfg: Config,
  p: { days?: number } = {},
  o: { fetchImpl?: FetchLike; save?: (c: Config) => void } = {},
): Promise<any> {
  const q = p.days !== undefined ? `?days=${encodeURIComponent(String(p.days))}` : "";
  return apiFetch(`/billing/savings${q}`, { cfg, fetchImpl: o.fetchImpl, save: o.save });
}

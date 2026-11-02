import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * GitHub trigger (plan 5.4, GitHub part): repository events → tasks for an agent.
 *
 * - Sign-in: the "Braavolabs" GitHub App's OAuth device flow (no callback URL, no client
 *   secret on the user's computer). The user token stays in the OS keychain (`braavo keys`
 *   store, account "github-oauth"); it never goes to a Braavolabs server.
 * - Delivery, two ways:
 *   - poll (default): the repository Events API with ETag, so a quiet repository costs a
 *     304 and no rate limit. Works without any public address.
 *   - webhook: GitHub posts to `POST /v1/hooks/github/<trigger id>` on the daemon, reached
 *     through a forwarder the user runs (for example smee.io's client) or, later, the
 *     platform relay. Each trigger has its own secret; the body is checked against
 *     X-Hub-Signature-256 before anything is parsed, and deliveries are de-duplicated.
 *
 * Issue, pull request and comment text is written by anyone who can open an issue, so it
 * goes into the task fenced as untrusted content (the trigger rule), and trigger tasks keep
 * CLI workers on "ask" (workers.ts).
 */

export const GITHUB_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "release", "workflow_run", "discussion"] as const;
export type GithubEventName = (typeof GITHUB_EVENTS)[number];
export const DEFAULT_GITHUB_EVENTS: GithubEventName[] = ["issues", "pull_request", "release", "workflow_run"];
export type GithubMode = "poll" | "webhook";

/** Keychain accounts: the user's OAuth token, and one webhook secret per trigger. */
export const GITHUB_TOKEN_KEY = "github-oauth";
export const webhookSecretKey = (triggerId: string) => `github-webhook:${triggerId}`;

/**
 * The GitHub App's client ID (public, not a secret). Empty until the app is registered
 * (founder step K3); `BRAAVO_GITHUB_CLIENT_ID` overrides it for testing another app.
 */
export const GITHUB_APP_CLIENT_ID = "";
export const githubClientId = () => (process.env.BRAAVO_GITHUB_CLIENT_ID ?? "").trim() || GITHUB_APP_CLIENT_ID;

const API = "https://api.github.com";
const MAX_SEEN = 500;
const MAX_DELIVERIES = 200;
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<any>; text(): Promise<string> }>;

/** "owner/repo" with GitHub's own name rules, or null. */
export function parseRepo(s: string): string | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, ""));
  return m && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : null;
}

export function parseEvents(list: unknown): GithubEventName[] | null {
  if (list === undefined) return [...DEFAULT_GITHUB_EVENTS];
  const items = (Array.isArray(list) ? list : String(list).split(",")).map(x => String(x).trim()).filter(Boolean);
  if (!items.length || items.some(x => !(GITHUB_EVENTS as readonly string[]).includes(x))) return null;
  return [...new Set(items)] as GithubEventName[];
}

// ── events ──────────────────────────────────────────────────────────────────

export interface GithubEvent { key: string; event: GithubEventName; title: string; url: string; text: string }

/** Which actions open a task; the rest (edited, labeled, synchronize…) would only be noise. */
const ACTIONS: Record<GithubEventName, string[]> = {
  issues: ["opened", "reopened"],
  issue_comment: ["created"],
  pull_request: ["opened", "reopened", "ready_for_review"],
  pull_request_review: ["submitted"],
  release: ["published"],
  workflow_run: ["completed"],
  discussion: ["created"],
};
const FAILED_RUN = ["failure", "timed_out", "startup_failure"];
const isBot = (login?: string) => !!login && /\[bot\]$/.test(login);
const clip = (s: unknown, n: number) => (typeof s === "string" ? s : "").slice(0, n);

/**
 * One delivery (webhook name + payload, the same shape the Events API carries) → an event,
 * or null when the action is not one that opens a task. Bot comments and reviews are
 * skipped so CI bots cannot flood an agent.
 */
export function toEvent(name: string, p: any, repo: string): GithubEvent | null {
  if (!(GITHUB_EVENTS as readonly string[]).includes(name) || !p || typeof p !== "object") return null;
  const event = name as GithubEventName;
  if (!ACTIONS[event].includes(p.action)) return null;
  const who = clip(p.sender?.login ?? p.comment?.user?.login ?? p.review?.user?.login, 60);
  switch (event) {
    case "issues": case "pull_request": {
      const item = event === "issues" ? p.issue : p.pull_request;
      if (!item?.number) return null;
      const kind = event === "issues" ? "Issue" : "PR";
      return { key: `${event}:${item.number}:${p.action}:${item.updated_at ?? ""}`, event, url: clip(item.html_url, 500), title: `[${repo}] ${kind} #${item.number} ${p.action}: ${clip(item.title, 200)}`, text: `${clip(item.title, 300)}\n\nby ${clip(item.user?.login, 60)}\n\n${clip(item.body, 6_000)}` };
    }
    case "issue_comment": {
      if (!p.comment?.id || !p.issue?.number || isBot(p.comment.user?.login)) return null;
      return { key: `comment:${p.comment.id}`, event, url: clip(p.comment.html_url, 500), title: `[${repo}] Comment on #${p.issue.number}: ${clip(p.issue.title, 200)}`, text: `${clip(p.issue.title, 300)}\n\ncomment by ${clip(p.comment.user?.login, 60)}\n\n${clip(p.comment.body, 6_000)}` };
    }
    case "pull_request_review": {
      if (!p.review?.id || !p.pull_request?.number || isBot(p.review.user?.login)) return null;
      return { key: `review:${p.review.id}`, event, url: clip(p.review.html_url, 500), title: `[${repo}] Review on PR #${p.pull_request.number} (${clip(p.review.state, 30)}): ${clip(p.pull_request.title, 200)}`, text: `${clip(p.pull_request.title, 300)}\n\nreview by ${clip(p.review.user?.login, 60)}: ${clip(p.review.state, 30)}\n\n${clip(p.review.body, 6_000)}` };
    }
    case "release": {
      if (!p.release?.id) return null;
      return { key: `release:${p.release.id}`, event, url: clip(p.release.html_url, 500), title: `[${repo}] Release ${clip(p.release.tag_name, 100)}: ${clip(p.release.name, 200)}`, text: `${clip(p.release.name || p.release.tag_name, 300)}\n\n${clip(p.release.body, 8_000)}` };
    }
    case "workflow_run": return runEvent(p.workflow_run, repo);
    case "discussion": {
      if (!p.discussion?.number) return null;
      return { key: `discussion:${p.discussion.number}`, event, url: clip(p.discussion.html_url, 500), title: `[${repo}] Discussion #${p.discussion.number}: ${clip(p.discussion.title, 200)}`, text: `${clip(p.discussion.title, 300)}\n\nby ${clip(p.discussion.user?.login ?? who, 60)}\n\n${clip(p.discussion.body, 6_000)}` };
    }
  }
}

/** Only failed runs are worth a task: a green run needs no one. */
function runEvent(run: any, repo: string): GithubEvent | null {
  if (!run?.id || run.status !== "completed" || !FAILED_RUN.includes(run.conclusion)) return null;
  return { key: `run:${run.id}:${run.run_attempt ?? 1}`, event: "workflow_run", url: clip(run.html_url, 500), title: `[${repo}] ${clip(run.name, 120)} ${run.conclusion} on ${clip(run.head_branch, 120)}`, text: `Workflow "${clip(run.name, 120)}" ${run.conclusion}\nbranch: ${clip(run.head_branch, 120)}\ncommit: ${clip(run.head_sha, 40)} ${clip(run.head_commit?.message, 300)}\nevent: ${clip(run.event, 40)}` };
}

/** Events API type → webhook event name (the payloads share their shape). */
const API_TYPES: Record<string, GithubEventName> = {
  IssuesEvent: "issues", IssueCommentEvent: "issue_comment", PullRequestEvent: "pull_request",
  PullRequestReviewEvent: "pull_request_review", ReleaseEvent: "release", DiscussionEvent: "discussion",
};

// ── webhook ─────────────────────────────────────────────────────────────────

export const newWebhookSecret = () => randomBytes(32).toString("hex");

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body), compared in constant time. */
export function verifySignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ── polling ─────────────────────────────────────────────────────────────────

export interface GithubState { etag?: string; seen?: string[]; runsEtag?: string; runs?: string[]; deliveries?: string[] }

const headers = (token?: string, etag?: string): Record<string, string> => ({
  Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "braavo-cli",
  ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(etag ? { "If-None-Match": etag } : {}),
});

function apiProblem(status: number, res: { headers: { get(n: string): string | null } }, repo: string, signedIn: boolean): Error {
  if (status === 401) return new Error("GitHub sign-in expired or was revoked: run `braavo github login`");
  if (status === 404) return new Error(signedIn ? `${repo}: not found, or the Braavolabs GitHub App is not installed on it` : `${repo}: not found (a private repository needs \`braavo github login\`)`);
  if (status === 403 || status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return new Error(`GitHub rate limit${reset ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : ""}${signedIn ? "" : " (signing in raises the limit)"}`);
  }
  return new Error(`GitHub answered ${status}`);
}

/**
 * One poll of a repository. The first poll only records what is there. Returns new events
 * oldest first and the state to keep (ETags, seen ids).
 */
export async function pollRepo(repo: string, wanted: GithubEventName[], state: GithubState, token: string | undefined, fetchImpl: FetchLike): Promise<{ events: GithubEvent[]; state: GithubState }> {
  const next: GithubState = { ...state };
  const out: GithubEvent[] = [];
  const res = await fetchImpl(`${API}/repos/${repo}/events?per_page=100`, { headers: headers(token, state.etag) });
  if (res.status !== 304) {
    if (res.status !== 200) throw apiProblem(res.status, res, repo, !!token);
    const list = (await res.json()) as any[];
    const items = Array.isArray(list) ? list.filter(e => e && typeof e.id === "string") : [];
    const seen = new Set(state.seen ?? []);
    if (state.seen) {
      for (const e of [...items].reverse()) {
        const name = API_TYPES[e.type];
        if (seen.has(e.id) || !name || !wanted.includes(name)) continue;
        // The Events API leaves sender out of the payload; the actor is the same person.
        const ev = toEvent(name, { ...e.payload, sender: e.payload?.sender ?? e.actor }, repo);
        if (ev) out.push(ev);
      }
    }
    next.etag = res.headers.get("etag") ?? undefined;
    next.seen = [...items.map(e => e.id as string), ...(state.seen ?? []).filter(s => !items.some(e => e.id === s))].slice(0, MAX_SEEN);
  }
  // Workflow runs are not in the Events API: a second conditional request, only when asked for.
  if (wanted.includes("workflow_run")) {
    const r = await fetchImpl(`${API}/repos/${repo}/actions/runs?status=completed&per_page=20`, { headers: headers(token, state.runsEtag) });
    if (r.status !== 304) {
      if (r.status !== 200) throw apiProblem(r.status, r, repo, !!token);
      const runs = (((await r.json()) as any)?.workflow_runs ?? []) as any[];
      const keyOf = (run: any) => `${run.id}:${run.run_attempt ?? 1}`;
      const seen = new Set(state.runs ?? []);
      if (state.runs) for (const run of [...runs].reverse()) { if (!seen.has(keyOf(run))) { const ev = runEvent(run, repo); if (ev) out.push(ev); } }
      next.runsEtag = r.headers.get("etag") ?? undefined;
      next.runs = [...runs.map(keyOf), ...(state.runs ?? []).filter(k => !runs.some(run => keyOf(run) === k))].slice(0, MAX_SEEN);
    }
  }
  return { events: out, state: next };
}

/** Remember a webhook delivery id; false when it was already handled (GitHub redelivers). */
export function rememberDelivery(state: GithubState, id: string): boolean {
  const list = state.deliveries ?? [];
  if (list.includes(id)) return false;
  state.deliveries = [id, ...list].slice(0, MAX_DELIVERIES);
  return true;
}

// ── OAuth device flow ───────────────────────────────────────────────────────

export interface DeviceCode { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }
export interface GithubAuth { access: string; refresh?: string; expiresAt?: string; refreshExpiresAt?: string; login?: string }

const form = (body: Record<string, string>) => ({
  method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "braavo-cli" },
  body: new URLSearchParams(body).toString(),
});

export async function startDeviceFlow(clientId: string, fetchImpl: FetchLike): Promise<DeviceCode> {
  if (!clientId) throw new Error("the Braavolabs GitHub App is not registered yet (set BRAAVO_GITHUB_CLIENT_ID to use your own)");
  const res = await fetchImpl("https://github.com/login/device/code", form({ client_id: clientId }));
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200 || !data.device_code) throw new Error(`GitHub refused the sign-in request${data.error ? `: ${data.error}` : ""}`);
  return { device_code: data.device_code, user_code: data.user_code, verification_uri: data.verification_uri, interval: Number(data.interval) || 5, expires_in: Number(data.expires_in) || 900 };
}

const toAuth = (data: any, now: number): GithubAuth => ({
  access: data.access_token,
  ...(data.refresh_token ? { refresh: data.refresh_token } : {}),
  ...(data.expires_in ? { expiresAt: new Date(now + Number(data.expires_in) * 1000).toISOString() } : {}),
  ...(data.refresh_token_expires_in ? { refreshExpiresAt: new Date(now + Number(data.refresh_token_expires_in) * 1000).toISOString() } : {}),
});

/** Wait for the user to enter the code on github.com/login/device (RFC 8628 polling rules). */
export async function finishDeviceFlow(clientId: string, code: DeviceCode, fetchImpl: FetchLike, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)), now = () => Date.now()): Promise<GithubAuth> {
  let interval = code.interval;
  const deadline = now() + code.expires_in * 1000;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetchImpl("https://github.com/login/oauth/access_token", form({ client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }));
    const data = await res.json().catch(() => ({}));
    if (data.access_token) return toAuth(data, now());
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { interval = Number(data.interval) || interval + 5; continue; }
    if (data.error === "access_denied") throw new Error("sign-in was cancelled on GitHub");
    if (data.error === "expired_token") break;
    throw new Error(`GitHub sign-in failed${data.error ? `: ${data.error}` : ""}`);
  }
  throw new Error("the sign-in code expired; run `braavo github login` again");
}

/** A usable token: refreshed when it expires within five minutes; undefined when signed out. */
export async function currentToken(read: () => string | undefined, save: (auth: GithubAuth) => void, clientId: string, fetchImpl: FetchLike, now = () => Date.now()): Promise<string | undefined> {
  const raw = read();
  if (!raw) return undefined;
  let auth: GithubAuth;
  try { auth = JSON.parse(raw) as GithubAuth; } catch { return undefined; }
  if (!auth.expiresAt || Date.parse(auth.expiresAt) - now() > 5 * 60_000) return auth.access;
  if (!auth.refresh || !clientId) return undefined;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", form({ client_id: clientId, grant_type: "refresh_token", refresh_token: auth.refresh }));
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) return undefined;
  const fresh = { ...toAuth(data, now()), login: auth.login };
  save(fresh);
  return fresh.access;
}

export async function whoAmI(token: string, fetchImpl: FetchLike): Promise<string | undefined> {
  const res = await fetchImpl(`${API}/user`, { headers: headers(token) });
  return res.status === 200 ? clip((await res.json())?.login, 60) || undefined : undefined;
}

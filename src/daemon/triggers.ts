import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DaemonStore, TriggerRow } from "./store";
import { fetchChecked, readPage, type BrowserPolicy, type BrowseDeps } from "./browse";
import { htmlToText, normalizeForDiff, diffLines } from "../forge/monitor";
import { newWebhookSecret, pollRepo, rememberDelivery, toEvent, verifySignature, type FetchLike, type GithubEventName, type GithubMode, type GithubState } from "./github";

/**
 * Event triggers (plan 5.4, local part): something happens → a task for an agent.
 *
 * - rss: a feed (RSS 2.0 or Atom) gets a new item.
 * - web: a page's visible text changes (read through the agent browser: URL policy,
 *   private addresses refused, DNS pinned).
 * - files: a file matching a pattern appears or changes in a watched folder.
 * - github: repository events (issues, pull requests, releases, failed runs…), polled or
 *   pushed by webhook (github.ts).
 *
 * The first check of a feed or page only records what is there (no flood of old items).
 * Feed items and page changes come from outside, so they go into the task fenced as
 * untrusted content. Each trigger opens at most MAX_TASKS_PER_DAY tasks a day; a quiet
 * feed costs one small request per interval and no model call.
 * Slack and Gmail come later.
 */

export const TRIGGER_KINDS = ["rss", "web", "files", "github"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const MAX_TASKS_PER_DAY = 20;
export const MIN_EVERY_MINUTES = 5;
export const MAX_TRIGGERS_PER_COMPANY = 50;
export const MAX_FOLDER_TRIGGERS = 10;
const MAX_PENDING_FILES = 1_000;
const MAX_FEED_SCAN = 1_000_000;
const MAX_SEEN = 500;
const FILE_DEBOUNCE_MS = 2_000;

export interface TriggerConfig { url?: string; path?: string; pattern?: string; everyMinutes?: number; repo?: string; events?: GithubEventName[]; mode?: GithubMode }
export interface TriggerState extends GithubState { seen?: string[]; hash?: string; text?: string; files?: Record<string, number> }

// ── feeds ────────────────────────────────────────────────────────────────────

export interface FeedItem { id: string; title: string; link: string; summary: string }

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml);
  if (!m) return "";
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata ? cdata[1] : raw;
};
/** Feeds often carry entity-escaped HTML ("&lt;p&gt;"): decode, then strip the tags it revealed. */
const clean = (s: string, n: number) => htmlToText(htmlToText(s)).replace(/\s+/g, " ").trim().slice(0, n);

/**
 * RSS 2.0 <item> and Atom <entry>, tolerant of namespaces and CDATA; newest first as the feed lists them.
 * A linear scan (indexOf) over at most 1 MB and 100 items: a feed of unclosed tags cannot make it quadratic.
 */
export function parseFeed(xml: string): FeedItem[] {
  const src = xml.slice(0, MAX_FEED_SCAN);
  const lower = src.toLowerCase();
  const blocks: Array<[string, string, string]> = [];
  let pos = 0;
  while (blocks.length < 100) {
    const i = lower.indexOf("<item", pos); const e = lower.indexOf("<entry", pos);
    const start = i < 0 ? e : e < 0 ? i : Math.min(i, e);
    if (start < 0) break;
    const kind = start === i ? "item" : "entry";
    const after = lower[start + kind.length + 1];
    if (after !== ">" && after !== " " && after !== "\t" && after !== "\n" && after !== "\r") { pos = start + 1; continue; } // <items>, <entryLink>
    const open = lower.indexOf(">", start);
    const close = lower.indexOf(`</${kind}>`, open);
    if (open < 0 || close < 0) break;
    blocks.push(["", kind, src.slice(open + 1, close)]);
    pos = close + kind.length + 3;
  }
  return blocks.map(([, kind, body]) => {
    const atomLink = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(body)?.[1] ?? "";
    const link = (kind.toLowerCase() === "entry" ? atomLink : tag(body, "link")) || atomLink;
    const id = tag(body, "guid") || tag(body, "id") || link || tag(body, "title");
    return { id: id.trim().slice(0, 500), title: clean(tag(body, "title"), 300), link: link.trim().slice(0, 1_000), summary: clean(tag(body, "description") || tag(body, "summary") || tag(body, "content"), 1_500) };
  }).filter(i => i.id);
}

// ── files ────────────────────────────────────────────────────────────────────

/** "*.pdf", "invoices/**\/*.csv", "*" → a matcher on paths relative to the watched folder. */
export function globMatcher(pattern = "*"): (rel: string) => boolean {
  const p = pattern.trim() || "*";
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") { re += p[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += p[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern without a folder part matches the file name at any depth.
  const matcher = new RegExp(`^${p.includes("/") ? "" : "(?:.*/)?"}${re}$`);
  return rel => matcher.test(rel.split(sep).join("/"));
}

/** Folders a trigger may watch: absolute, existing, not the disk root or the whole home folder. */
export function watchableFolder(path: string): string | null {
  if (!isAbsolute(path)) return "path must be absolute";
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return "folder not found";
  if (abs === resolve("/") || abs === resolve(homedir())) return "watch a project folder, not the whole disk or home folder";
  return null;
}

// ── engine ───────────────────────────────────────────────────────────────────

export interface TriggerEvent { title: string; body: string; key: string }

export interface TriggerDeps {
  policy: () => BrowserPolicy;
  browse?: BrowseDeps;
  notify?: (title: string, body: string) => void;
  onTask?: (taskId: string, companyId: string) => void;
  now?: () => Date;
  /** Injected in tests; default node:fs watch (recursive). */
  watchImpl?: (path: string, onChange: (file: string) => void) => { close(): void };
  /** GitHub triggers: the signed-in user's token (refreshed), each trigger's webhook secret, and fetch. */
  github?: {
    token(): Promise<string | undefined>;
    secret(triggerId: string): string | undefined;
    saveSecret(triggerId: string, secret: string): void;
    removeSecret(triggerId: string): void;
    fetch?: FetchLike;
  };
}

export interface WebhookDelivery { event?: string; delivery?: string; signature?: string; raw: Buffer }

const fence = (source: string, text: string) =>
  `<untrusted_web_content url="${source.replace(/[<>"&\n\r]/g, " ")}">\n${text.replace(/<\/?\s*untrusted_web_content/gi, "[untrusted_web_content]")}\n</untrusted_web_content>`;

export const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

export class TriggerEngine {
  private timers = new Map<string, NodeJS.Timeout>();
  private watchers = new Map<string, { close(): void }>();
  private pending = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();

  constructor(private readonly store: DaemonStore, private readonly deps: TriggerDeps) {}

  /** Arm every enabled trigger (daemon start) — polls are staggered so they never fire at once. */
  start(): void {
    let i = 0;
    for (const t of this.store.listAllTriggers()) if (t.enabled) this.arm(t, (i++ % 10) * 15_000);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const w of this.watchers.values()) w.close();
    for (const p of this.pending.values()) clearTimeout(p);
    this.timers.clear(); this.watchers.clear(); this.pending.clear();
  }

  arm(t: TriggerRow, firstDelayMs = 0): void {
    this.disarm(t.id);
    const cfg = JSON.parse(t.config) as TriggerConfig;
    if (t.kind === "github" && cfg.mode === "webhook") return; // GitHub calls us
    if (t.kind === "files") {
      const watcher = (this.deps.watchImpl ?? defaultWatch)(cfg.path!, file => this.onFile(t.id, file));
      this.watchers.set(t.id, watcher);
      return;
    }
    const every = Math.max(cfg.everyMinutes ?? 30, MIN_EVERY_MINUTES) * 60_000;
    const loop = (delay: number) => {
      const timer = setTimeout(async () => { await this.check(t.id).catch(() => undefined); if (this.timers.has(t.id)) loop(every); }, delay);
      timer.unref?.();
      this.timers.set(t.id, timer);
    };
    loop(firstDelayMs);
  }

  disarm(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.watchers.get(id)?.close(); this.watchers.delete(id);
  }

  /** Poll one rss/web trigger now. Returns how many tasks it opened. */
  async check(id: string): Promise<{ fired: number; note?: string }> {
    const t = this.store.getTrigger(id);
    if (!t || !t.enabled || t.kind === "files" || this.running.has(id)) return { fired: 0 };
    if (t.kind === "github" && (JSON.parse(t.config) as TriggerConfig).mode === "webhook") return { fired: 0, note: "webhook trigger: GitHub sends events as they happen" };
    this.running.add(id);
    try {
      const cfg = JSON.parse(t.config) as TriggerConfig;
      const state = JSON.parse(t.state || "{}") as TriggerState;
      const events: TriggerEvent[] = [];
      if (t.kind === "github") {
        const gh = this.deps.github;
        const token = await gh?.token();
        const polled = await pollRepo(cfg.repo!, cfg.events ?? [], state, token, gh?.fetch ?? (fetch as unknown as FetchLike));
        Object.assign(state, polled.state);
        for (const e of polled.events) events.push({ key: e.key, title: e.title, body: `${e.url}\n\n${fence(e.url || `https://github.com/${cfg.repo}`, e.text)}` });
      } else if (t.kind === "rss") {
        const feed = await fetchChecked(cfg.url!, this.deps.policy(), { ...this.deps.browse, acceptHeader: "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.1", accept: /xml|rss|atom|text\/plain/i });
        const items = parseFeed(feed.body);
        const seen = new Set(state.seen ?? []);
        const fresh = state.seen ? items.filter(i => !seen.has(i.id)).reverse() : [];
        for (const item of fresh) events.push({ key: item.id, title: item.title || item.link, body: `${item.link}\n\n${fence(item.link || cfg.url!, `${item.title}\n\n${item.summary}`)}` });
        state.seen = [...items.map(i => i.id), ...(state.seen ?? []).filter(s => !items.some(i => i.id === s))].slice(0, MAX_SEEN);
      } else {
        const page = await readPage(cfg.url!, this.deps.policy(), this.deps.browse);
        const text = normalizeForDiff(page.text).slice(0, 50_000);
        const hash = createHash("sha256").update(text).digest("hex");
        if (state.hash && state.hash !== hash) {
          const { added, removed } = diffLines(state.text ?? "", text);
          const changes = [...added.slice(0, 15).map(l => `+ ${l}`), ...removed.slice(0, 10).map(l => `- ${l}`)].join("\n");
          events.push({ key: hash, title: page.title || cfg.url!, body: `${cfg.url}\n\n${fence(cfg.url!, changes || "(text changed)")}` });
        }
        state.hash = hash; state.text = text.slice(0, 20_000);
      }
      this.store.updateTrigger(id, { state: JSON.stringify(state), note: null });
      return { fired: this.fire(t, events) };
    } catch (error) {
      const note = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      this.store.updateTrigger(id, { note });
      return { fired: 0, note };
    } finally {
      this.running.delete(id);
    }
  }

  /** A new webhook secret for a GitHub trigger, kept in the keychain; shown to the user once. */
  createWebhookSecret(id: string): string {
    if (!this.deps.github) throw new Error("GitHub triggers are not enabled on this daemon");
    const secret = newWebhookSecret();
    this.deps.github.saveSecret(id, secret);
    return secret;
  }

  /** Forget a trigger: stop it and drop its webhook secret. */
  forget(t: TriggerRow): void {
    this.disarm(t.id);
    if (t.kind === "github") try { this.deps.github?.removeSecret(t.id); } catch { /* not there */ }
  }

  /**
   * A GitHub webhook delivery for one trigger. The signature is checked on the raw body
   * before it is parsed; redeliveries and other repositories' events are ignored.
   */
  ingestGithub(id: string, d: WebhookDelivery): { status: number; fired: number; note?: string } {
    const t = this.store.getTrigger(id);
    const cfg = t ? (JSON.parse(t.config) as TriggerConfig) : undefined;
    const secret = t && t.kind === "github" && cfg?.mode === "webhook" ? this.deps.github?.secret(id) : undefined;
    if (!t || !secret) return { status: 404, fired: 0 };
    if (!verifySignature(secret, d.raw, d.signature)) return { status: 401, fired: 0, note: "bad signature" };
    if (d.event === "ping") return { status: 200, fired: 0, note: "pong" };
    if (!t.enabled) return { status: 202, fired: 0, note: "trigger is off" };
    let payload: any;
    try { payload = JSON.parse(d.raw.toString("utf8")); } catch { return { status: 400, fired: 0, note: "invalid JSON" }; }
    if (String(payload?.repository?.full_name ?? "").toLowerCase() !== cfg!.repo!.toLowerCase()) return { status: 202, fired: 0, note: "other repository" };
    const state = JSON.parse(t.state || "{}") as TriggerState;
    if (d.delivery && !rememberDelivery(state, d.delivery.slice(0, 100))) return { status: 200, fired: 0, note: "already delivered" };
    this.store.updateTrigger(id, { state: JSON.stringify(state), note: null });
    const wanted = (cfg!.events ?? []) as string[];
    const e = wanted.includes(d.event ?? "") ? toEvent(d.event!, payload, cfg!.repo!) : null;
    if (!e) return { status: 202, fired: 0, note: "event not watched" };
    return { status: 200, fired: this.fire(t, [{ key: e.key, title: e.title, body: `${e.url}\n\n${fence(e.url || `https://github.com/${cfg!.repo}`, e.text)}` }]) };
  }

  private onFile(id: string, file: string): void {
    // Editors write in bursts: wait until the file has been quiet for a moment.
    const key = `${id}\u0000${file}`;
    // A folder in a write storm cannot grow the debounce table without bound: extra paths wait for the next event.
    if (!this.pending.has(key) && this.pending.size >= MAX_PENDING_FILES) return;
    clearTimeout(this.pending.get(key));
    const timer = setTimeout(() => {
      this.pending.delete(key);
      const t = this.store.getTrigger(id);
      if (!t || !t.enabled) return;
      const cfg = JSON.parse(t.config) as TriggerConfig;
      const abs = join(cfg.path!, file);
      const rel = relative(cfg.path!, abs);
      if (rel.startsWith("..") || rel.split(sep).some(p => p.startsWith(".")) || !globMatcher(cfg.pattern)(rel)) return;
      let mtime: number;
      try { const st = statSync(abs); if (!st.isFile()) return; mtime = Math.trunc(st.mtimeMs); } catch { return; }
      const state = JSON.parse(t.state || "{}") as TriggerState;
      const files = state.files ?? {};
      if (files[rel] === mtime) return;
      const isNew = files[rel] === undefined;
      files[rel] = mtime;
      const keys = Object.keys(files);
      if (keys.length > MAX_SEEN) for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete files[k];
      this.store.updateTrigger(id, { state: JSON.stringify({ ...state, files }) });
      this.fire(t, [{ key: `${rel}@${mtime}`, title: `${isNew ? "New" : "Changed"}: ${rel}`, body: `${isNew ? "A new file" : "A file changed"} in ${cfg.path}: ${rel}\nFull path: ${abs}` }]);
    }, FILE_DEBOUNCE_MS);
    timer.unref?.();
    this.pending.set(key, timer);
  }

  /** Open a task per event, within the daily cap. */
  private fire(t: TriggerRow, events: TriggerEvent[]): number {
    if (!events.length) return 0;
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const today = this.store.triggerTasksSince(t.id, `${now.slice(0, 10)}T00:00:00.000Z`);
    let fired = 0;
    for (const e of events) {
      if (today + fired >= MAX_TASKS_PER_DAY) {
        this.store.updateTrigger(t.id, { note: `daily limit of ${MAX_TASKS_PER_DAY} tasks reached; later events were skipped` });
        break;
      }
      const vars = { title: e.title, name: t.name };
      const task = this.store.createTask({
        companyId: t.company_id, assigneeAgentId: t.agent_id, createdBy: `trigger:${t.id}`, origin: "trigger",
        title: fill(t.task_title || "{title}", vars).slice(0, 300),
        body: `${t.task_body ? `${fill(t.task_body, vars)}\n\n` : ""}${e.body}`.slice(0, 20_000),
      });
      fired += 1;
      this.store.activity({ companyId: t.company_id, actor: `trigger:${t.id}`, verb: "trigger-fired", objectType: "task", objectId: task.id, summary: `${t.name}: ${e.title}`.slice(0, 200) });
      this.deps.onTask?.(task.id, t.company_id);
    }
    if (fired) {
      this.store.updateTrigger(t.id, { lastFiredAt: now });
      try { this.deps.notify?.(t.name, fired === 1 ? events[0].title.slice(0, 160) : `${fired} new tasks`); } catch { /* best effort */ }
    }
    return fired;
  }
}

function defaultWatch(path: string, onChange: (file: string) => void): FSWatcher {
  const w = watch(path, { recursive: true, persistent: false }, (_event, file) => { if (file) onChange(file.toString()); });
  w.on("error", () => { /* folder removed: stays quiet until re-armed */ });
  return w;
}

export const newTriggerId = () => `tg_${randomUUID()}`;

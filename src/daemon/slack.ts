import type { FetchLike } from "./github";
import type { AgentRow, DaemonStore } from "./store";
import type { PermissionRequest } from "./acp";

/**
 * Slack trigger (plan 5.4, Slack part): a mention of the app, or a direct message to it,
 * becomes a task; the agent's answer goes back to the same thread only after the user
 * approves it (external communication is "draft + approval").
 *
 * - The user's own Slack app, installed to their workspace, in Socket Mode: the daemon opens
 *   an outgoing WebSocket, so no public address is needed. Two tokens, both in the OS
 *   keychain: the bot token (xoxb-…, posts replies) and the app-level token (xapp-…,
 *   connections:write, opens the socket).
 * - Every envelope is acknowledged at once (Slack retries otherwise); retries and repeated
 *   event ids are de-duplicated by the trigger engine. Messages from bots, edits and other
 *   subtypes are ignored, so the app never answers itself.
 */

export const SLACK_BOT_KEY = "slack-bot";
export const SLACK_APP_KEY = "slack-app";
export const SLACK_EVENTS = ["mention", "dm"] as const;
export type SlackEventKind = (typeof SLACK_EVENTS)[number];

export interface SlackMessage { eventId: string; kind: SlackEventKind; channel: string; ts: string; threadTs: string; user: string; text: string }

export function parseSlackEvents(list: unknown): SlackEventKind[] | null {
  if (list === undefined) return [...SLACK_EVENTS];
  const items = (Array.isArray(list) ? list : String(list).split(",")).map(x => String(x).trim()).filter(Boolean);
  if (!items.length || items.some(x => !(SLACK_EVENTS as readonly string[]).includes(x))) return null;
  return [...new Set(items)] as SlackEventKind[];
}

/** Channel ids as Slack writes them (C…, G…, D…); anything else is refused. */
export function parseChannels(list: unknown): string[] | null {
  if (list === undefined || list === "") return [];
  const items = (Array.isArray(list) ? list : String(list).split(",")).map(x => String(x).trim()).filter(Boolean);
  return items.length <= 50 && items.every(x => /^[CGD][A-Z0-9]{6,20}$/.test(x)) ? [...new Set(items)] : null;
}

/** An Events API payload → a message worth a task, or null. */
export function toSlackMessage(payload: any): SlackMessage | null {
  const e = payload?.event;
  if (!e || typeof e !== "object" || e.bot_id || e.subtype || typeof e.text !== "string" || !e.channel || !e.ts) return null;
  let kind: SlackEventKind;
  if (e.type === "app_mention") kind = "mention";
  else if (e.type === "message" && e.channel_type === "im") kind = "dm";
  else return null;
  const text = e.text.replace(/<@[A-Z0-9]+>/g, "").trim().slice(0, 8_000);
  if (!text) return null;
  return { eventId: String(payload.event_id ?? `${e.channel}:${e.ts}`).slice(0, 100), kind, channel: e.channel, ts: e.ts, threadTs: e.thread_ts ?? e.ts, user: String(e.user ?? "").slice(0, 40), text };
}

const slackApi = async (method: string, token: string, fetchImpl: FetchLike, body?: Record<string, unknown>) => {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) throw new Error(`Slack ${method}: ${data?.error ?? `HTTP ${res.status}`}`);
  return data;
};

/** Who a token belongs to; also how `braavo slack connect` checks the tokens. */
export async function slackAuthTest(token: string, fetchImpl: FetchLike): Promise<{ team: string; user: string }> {
  const d = await slackApi("auth.test", token, fetchImpl);
  return { team: String(d.team ?? ""), user: String(d.user ?? "") };
}

/** Post the approved answer into the thread of the message that asked. */
export async function postSlackReply(botToken: string, channel: string, threadTs: string, text: string, fetchImpl: FetchLike): Promise<void> {
  // Slack caps a message at 40k characters; long answers keep their start.
  await slackApi("chat.postMessage", botToken, fetchImpl, { channel, thread_ts: threadTs, text: text.slice(0, 39_000), unfurl_links: false, unfurl_media: false });
}

export interface ReplyDeps {
  store: DaemonStore;
  replyFor(taskId: string): { channel: string; threadTs: string } | undefined;
  ask(agent: AgentRow, taskId: string, req: PermissionRequest): Promise<{ decision: "allow" | "reject" }>;
  botToken(): string | undefined;
  fetch: FetchLike;
  notify(title: string, body: string): void;
}

/**
 * After a Slack-triggered task: the answer waits as an approval ("slack.post") and is posted
 * to the thread only when the user allows it. Returns what happened.
 */
export async function replyAfterTask(taskId: string, d: ReplyDeps): Promise<"none" | "posted" | "rejected" | "failed"> {
  const target = d.replyFor(taskId);
  const task = target ? d.store.getTask(taskId) : undefined;
  const agent = task?.status === "DONE" && task.result && task.assignee_agent_id ? d.store.getAgent(task.assignee_agent_id) : undefined;
  if (!target || !task?.result || !agent) return "none";
  const { decision } = await d.ask(agent, taskId, { id: taskId, title: `Reply in Slack: ${task.result.replace(/\s+/g, " ").slice(0, 160)}`, tool: "slack.post", paths: [target.channel] });
  if (decision !== "allow") return "rejected";
  const bot = d.botToken();
  try {
    if (!bot) throw new Error("no bot token (braavo slack connect)");
    await postSlackReply(bot, target.channel, target.threadTs, task.result, d.fetch);
    return "posted";
  } catch (error) {
    try { d.notify("Slack", `reply not posted: ${(error as Error).message}`.slice(0, 200)); } catch { /* best effort */ }
    return "failed";
  }
}

// ── Socket Mode ─────────────────────────────────────────────────────────────

export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", cb: () => void): void;
}

export interface SlackSocketDeps {
  appToken(): string | undefined;
  fetch: FetchLike;
  /** Default: the global WebSocket (Node 22+). */
  connect?: (url: string) => SocketLike;
  /** Waits between reconnects; injectable for tests. */
  delay?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** One Socket Mode connection, reconnecting with backoff while started. */
export class SlackSocket {
  private socket?: SocketLike;
  private started = false;
  private attempt = 0;
  status: "off" | "connecting" | "connected" | "error" = "off";
  note?: string;

  constructor(private readonly deps: SlackSocketDeps, private readonly onMessage: (m: SlackMessage) => void) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  stop(): void {
    this.started = false;
    this.status = "off";
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
  }

  private async loop(): Promise<void> {
    while (this.started) {
      const closed = await this.connectOnce().catch((error: Error) => { this.status = "error"; this.note = error.message.slice(0, 200); this.deps.log?.(`slack: ${this.note}`); return null; });
      if (closed) await closed;
      if (!this.started) return;
      // 1 s, 2 s, 4 s … at most a minute; a healthy connection resets the count.
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6));
      await (this.deps.delay ?? (ms => new Promise(r => setTimeout(r, ms).unref?.())))(wait);
    }
  }

  /** Open one connection; resolves to a promise that settles when it closes. */
  private async connectOnce(): Promise<Promise<void>> {
    const token = this.deps.appToken();
    if (!token) throw new Error("no Slack app token: braavo slack connect");
    this.status = "connecting";
    const { url } = await slackApi("apps.connections.open", token, this.deps.fetch);
    const ws = (this.deps.connect ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(String(url));
    this.socket = ws;
    return new Promise<void>(resolve => {
      ws.addEventListener("message", e => {
        let env: any;
        try { env = JSON.parse(String(e.data)); } catch { return; }
        if (env?.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch { /* closing */ } }
        if (env?.type === "hello") { this.status = "connected"; this.note = undefined; this.attempt = 0; return; }
        if (env?.type === "disconnect") { try { ws.close(); } catch { /* closed */ } return; }
        if (env?.type !== "events_api") return;
        const m = toSlackMessage(env.payload);
        if (m) try { this.onMessage(m); } catch (error) { this.deps.log?.(`slack: ${(error as Error).message}`); }
      });
      const done = () => { if (this.socket === ws) this.socket = undefined; if (this.status !== "off") this.status = "connecting"; resolve(); };
      ws.addEventListener("close", done);
      ws.addEventListener("error", done);
    });
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * CLI employees (plan 3.1): the user's own Claude Code, Codex or Gemini CLI as an agent
 * in the org chart, driven over the Agent Client Protocol (ACP, JSON-RPC 2.0 on stdio).
 *
 * The daemon is the ACP *client*: it starts the agent in the employee's working folder,
 * sends the task as one prompt, and turns the agent's `session/update` stream into
 * structured events (message, tool call, diff, plan). Every `session/request_permission`
 * goes through the employee's approval policy; "ask" waits for the user's decision in the
 * panel (or times out to a reject). The client offers no file-system or terminal
 * capabilities: the agent works with its own tools inside its folder, under its own
 * sign-in — the daemon never sees the vendor's credentials.
 */

export const WORKER_ENGINES = ["claude-code", "codex", "gemini"] as const;
export type WorkerEngine = (typeof WORKER_ENGINES)[number];
export const isWorkerEngine = (v: unknown): v is WorkerEngine => (WORKER_ENGINES as readonly unknown[]).includes(v);

export interface Adapter { command: string; args: string[]; /** ACP auth method to use when the agent asks for one (the CLI's own cached sign-in). */ authMethod?: string }

/** Default ACP launchers: Gemini speaks ACP itself; Claude Code and Codex through Zed's adapters. */
export const DEFAULT_ADAPTERS: Record<WorkerEngine, Adapter> = {
  "claude-code": { command: "claude-code-acp", args: [] },
  codex: { command: "codex-acp", args: [] },
  // "oauth-personal" reuses the Google sign-in `gemini` keeps after the user logged in once.
  gemini: { command: "gemini", args: ["--acp"], authMethod: "oauth-personal" },
};

/** `~/.braavo/adapters.json` may replace a launcher, e.g. {"codex": {"command": "/opt/bin/codex-acp", "args": []}}. */
export function loadAdapters(file: string): Record<WorkerEngine, Adapter> {
  const out = { ...DEFAULT_ADAPTERS };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { command?: unknown; args?: unknown }>;
    for (const engine of WORKER_ENGINES) {
      const a = raw[engine] as { command?: unknown; args?: unknown; authMethod?: unknown } | undefined;
      if (a && typeof a.command === "string" && a.command.trim() && (a.args === undefined || (Array.isArray(a.args) && a.args.every(x => typeof x === "string")))) {
        out[engine] = { command: a.command.trim(), args: (a.args as string[] | undefined) ?? [], ...(typeof a.authMethod === "string" && a.authMethod ? { authMethod: a.authMethod } : {}) };
      }
    }
  } catch { /* defaults */ }
  return out;
}

// ── approval policy ──────────────────────────────────────────────────────────

export const APPROVAL_POLICIES = ["ask", "edits", "readonly"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

const READ_KINDS = new Set(["read", "search", "think"]);
const EDIT_KINDS = new Set(["edit", "move"]);

/**
 * What the policy says about one tool call, before anyone is asked:
 * - readonly: reads, searches and thinking run; everything else is refused.
 * - ask (default): reads run; edits, commands, deletes, fetches wait for the user.
 * - edits: reads and edits inside the working folder run; commands, deletes, fetches wait.
 * A path outside the working folder is never auto-allowed.
 */
export function policyDecision(policy: ApprovalPolicy, kind: string | undefined, paths: string[], workdir: string): "allow" | "reject" | "ask" {
  const inside = paths.every(p => { const r = relative(workdir, resolve(workdir, p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); });
  const k = kind ?? "other";
  if (READ_KINDS.has(k) && inside) return "allow";
  if (policy === "readonly") return "reject";
  if (policy === "edits" && EDIT_KINDS.has(k) && inside) return "allow";
  return "ask";
}

// ── events ───────────────────────────────────────────────────────────────────

export type WorkerEvent =
  | { kind: "message"; text: string }
  | { kind: "tool_call"; id: string; title: string; tool: string; status: string; paths: string[] }
  | { kind: "tool_update"; id: string; status: string; text?: string }
  | { kind: "diff"; id: string; path: string; oldText: string | null; newText: string }
  | { kind: "plan"; entries: Array<{ content: string; status: string }> }
  | { kind: "permission"; id: string; title: string; tool: string; decision: "allow" | "reject"; by: "policy" | "user" | "timeout" };

const MAX_EVENT_TEXT = 8_000;
const clip = (s: unknown, n = MAX_EVENT_TEXT) => (typeof s === "string" ? s.slice(0, n) : "");

/** One `session/update` → zero or more events (message chunks are merged by the caller). */
export function toEvents(update: any): WorkerEvent[] {
  if (!update || typeof update !== "object") return [];
  const out: WorkerEvent[] = [];
  const paths = (u: any) => (Array.isArray(u.locations) ? u.locations.map((l: any) => clip(l?.path, 500)).filter(Boolean) : []);
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content?.type === "text") out.push({ kind: "message", text: clip(update.content.text) });
      break;
    case "tool_call":
      out.push({ kind: "tool_call", id: clip(update.toolCallId, 200), title: clip(update.title, 300), tool: clip(update.kind, 40) || "other", status: clip(update.status, 40) || "pending", paths: paths(update) });
      break;
    case "tool_call_update": {
      const id = clip(update.toolCallId, 200);
      const texts: string[] = [];
      for (const c of Array.isArray(update.content) ? update.content : []) {
        if (c?.type === "diff") out.push({ kind: "diff", id, path: clip(c.path, 500), oldText: typeof c.oldText === "string" ? clip(c.oldText) : null, newText: clip(c.newText) });
        else if (c?.type === "content" && c.content?.type === "text") texts.push(clip(c.content.text, 2_000));
      }
      if (update.status || texts.length) out.push({ kind: "tool_update", id, status: clip(update.status, 40) || "in_progress", ...(texts.length ? { text: texts.join("\n").slice(0, 2_000) } : {}) });
      break;
    }
    case "plan":
      out.push({ kind: "plan", entries: (Array.isArray(update.entries) ? update.entries : []).slice(0, 50).map((e: any) => ({ content: clip(e?.content, 300), status: clip(e?.status, 40) || "pending" })) });
      break;
  }
  return out;
}

// ── client ───────────────────────────────────────────────────────────────────

export interface PermissionRequest { id: string; title: string; tool: string; paths: string[] }

export interface WorkerTurn {
  command: string;
  args: string[];
  authMethod?: string;
  cwd: string;
  prompt: string;
  onEvent(e: WorkerEvent): void;
  /** The policy already said "ask": resolve with the user's decision (or a timeout reject). */
  ask(req: PermissionRequest): Promise<{ decision: "allow" | "reject"; by: "user" | "timeout" }>;
  policy: ApprovalPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnImpl?: (command: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams;
}

export interface WorkerResult { stopReason: string; text: string; error?: string }

const ACP_PROTOCOL_VERSION = 1;

export class AcpError extends Error {}

/** One prompt to a fresh agent process; resolves after the agent's prompt response (or a failure). */
export async function runWorkerTurn(t: WorkerTurn): Promise<WorkerResult> {
  if (!existsSync(t.cwd)) throw new AcpError(`working folder not found: ${t.cwd}`);
  // Own process group (POSIX), so stopping the agent also stops the processes it started.
  const group = process.platform !== "win32";
  const child = (t.spawnImpl ?? ((cmd, args, cwd) => spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env, detached: group })))(t.command, t.args, t.cwd);
  const kill = () => {
    try { if (group && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch { try { child.kill(); } catch { /* gone */ } }
  };
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let text = "";
  let sessionId = "";
  let stderr = "";
  const send = (m: object) => { try { child.stdin.write(`${JSON.stringify(m)}\n`); } catch { /* process gone */ } };
  const request = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    send({ jsonrpc: "2.0", id, method, params });
  });

  const decide = async (params: any) => {
    const tc = params?.toolCall ?? {};
    const req: PermissionRequest = { id: clip(tc.toolCallId, 200), title: clip(tc.title, 300) || clip(tc.kind, 40) || "tool", tool: clip(tc.kind, 40) || "other", paths: (Array.isArray(tc.locations) ? tc.locations : []).map((l: any) => clip(l?.path, 500)).filter(Boolean) };
    const verdict = policyDecision(t.policy, req.tool, req.paths, t.cwd);
    const { decision, by } = verdict === "ask" ? await t.ask(req) : { decision: verdict, by: "policy" as const };
    t.onEvent({ kind: "permission", id: req.id, title: req.title, tool: req.tool, decision, by });
    const options: Array<{ optionId: string; kind: string }> = Array.isArray(params?.options) ? params.options : [];
    const pick = (kinds: string[]) => kinds.map(k => options.find(o => o.kind === k)).find(Boolean);
    const option = decision === "allow" ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  };

  const onMessage = async (msg: any) => {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(clip(msg.error.message, 300) || "agent error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      for (const e of toEvents(msg.params?.update)) {
        if (e.kind === "message") text += e.text;
        t.onEvent(e);
      }
      return;
    }
    if (msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        try { send({ jsonrpc: "2.0", id: msg.id, result: await decide(msg.params) }); }
        catch { send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }); }
      } else {
        // fs/* and terminal/* were not offered in initialize.
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${String(msg.method).slice(0, 60)} is not offered by this client` } });
      }
    }
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      try { void onMessage(JSON.parse(line)); } catch { /* not JSON: ignore (agents may log) */ }
    }
    if (buffer.length > 4 * 1024 * 1024) buffer = "";
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-2_000); });
  const exited = new Promise<number | null>(res => child.on("close", code => res(code)));
  child.on("error", err => { for (const p of pending.values()) p.reject(new AcpError(`could not start ${t.command}: ${err.message}`)); pending.clear(); });
  void exited.then(code => { for (const p of pending.values()) p.reject(new AcpError(`${t.command} exited (${code ?? "signal"})${stderr ? `: ${stderr.trim().split("\n").pop()?.slice(0, 200)}` : ""}`)); pending.clear(); });

  const stop = () => {
    if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    setTimeout(kill, 2_000).unref();
  };
  const timer = setTimeout(stop, t.timeoutMs ?? 30 * 60_000);
  t.signal?.addEventListener("abort", stop, { once: true });
  try {
    const init = await request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const offered: string[] = Array.isArray(init?.authMethods) ? init.authMethods.map((m: any) => String(m?.id ?? "")) : [];
    const open = () => request("session/new", { cwd: t.cwd, mcpServers: [] });
    let session: any;
    try { session = await open(); }
    catch (error) {
      // The agent wants sign-in first: use the CLI's own cached sign-in once, never a password.
      if (!t.authMethod || !offered.includes(t.authMethod)) throw new AcpError(`${(error as Error).message} — sign in with the CLI once (e.g. run \`${t.command}\`) or set authMethod in ~/.braavo/adapters.json`);
      await request("authenticate", { methodId: t.authMethod });
      session = await open();
    }
    sessionId = String(session?.sessionId ?? "");
    if (!sessionId) throw new AcpError("the agent did not open a session");
    const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: t.prompt }] });
    return { stopReason: clip(result?.stopReason, 40) || "end_turn", text: text.trim() };
  } catch (error) {
    return { stopReason: "error", text: text.trim(), error: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
  } finally {
    clearTimeout(timer);
    t.signal?.removeEventListener("abort", stop);
    try { child.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (child.exitCode === null) kill(); }, 1_000).unref();
  }
}

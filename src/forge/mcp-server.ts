/**
 * `braavo mcp serve` — the local company as an MCP server (plan 5.2), so Claude Code,
 * Codex, Cursor or any MCP client can read the panel, hand work to an agent, ask an
 * agent, and read or write company memory.
 *
 * Stdio transport: one JSON-RPC 2.0 message per line on stdin/stdout; stderr is for
 * humans. No SDK and no network listener: every tool is a call to the local daemon over
 * its loopback API with the daemon's token, so the MCP server can do exactly what
 * `braavo company …` can and nothing more. Spending stays under the daemon's budgets.
 *
 * Tool failures come back as `isError` results (the model can read and react to them);
 * protocol mistakes — unknown method or tool, bad JSON — are JSON-RPC errors.
 */
import type { ChatStreamEvent } from "./daemon-client";

export const MCP_SERVER_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOOL_TEXT = 60_000;

/** What the tools need from the daemon; DaemonClient fits. */
export interface McpDaemon {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  turn(conversationId: string, content: string, onEvent: (ev: ChatStreamEvent) => void, signal?: AbortSignal): Promise<void>;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: Record<string, unknown>, d: McpDaemon): Promise<unknown>;
}

class ToolError extends Error {}

const COMPANY = { type: "string", description: "Company id or name; optional when there is only one company." };
const s = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

function arg(args: Record<string, unknown>, key: string, max = 20_000): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${key} is required`);
  if (v.length > max) throw new ToolError(`${key} is limited to ${max} characters`);
  return v;
}
const opt = (args: Record<string, unknown>, key: string): string | undefined => (typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string) : undefined);
const enc = encodeURIComponent;

async function companyId(d: McpDaemon, args: Record<string, unknown>): Promise<string> {
  const { companies } = await d.json<{ companies: Array<{ id: string; name: string }> }>("GET", "/companies");
  const ref = opt(args, "company");
  if (ref) {
    const hit = companies.find(c => c.id === ref) ?? companies.find(c => c.name.toLowerCase() === ref.trim().toLowerCase());
    if (!hit) throw new ToolError(`no company "${ref}"; companies: ${companies.map(c => c.name).join(", ") || "none"}`);
    return hit.id;
  }
  if (!companies.length) throw new ToolError("no company yet; create one with: braavo company init <name>");
  if (companies.length > 1) throw new ToolError(`several companies; pass company (one of: ${companies.map(c => c.name).join(", ")})`);
  return companies[0].id;
}

async function agentOf(d: McpDaemon, company: string, ref: string): Promise<{ id: string; name: string }> {
  const p = await d.json<{ agents: Array<{ id: string; name: string; role: string }> }>("GET", `/companies/${enc(company)}/panel`);
  const key = ref.trim().toLowerCase();
  const hit = p.agents.find(a => a.id === ref) ?? p.agents.find(a => a.name.toLowerCase() === key) ?? p.agents.find(a => a.role === key);
  if (!hit) throw new ToolError(`no agent "${ref}"; agents: ${p.agents.map(a => a.name).join(", ") || "none"}`);
  return hit;
}

export const TOOLS: Tool[] = [
  {
    name: "list_companies", title: "List companies",
    description: "The companies on this computer's Braavolabs daemon.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_a, d) => d.json("GET", "/companies"),
  },
  {
    name: "company_panel", title: "Company panel",
    description: "Org chart, each agent's model, status and month spend against its budget, routines with their last outcome, task counts and recent activity.",
    inputSchema: { type: "object", properties: { company: COMPANY }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, d) => d.json("GET", `/companies/${enc(await companyId(d, a))}/panel`),
  },
  {
    name: "list_tasks", title: "List tasks",
    description: "The company's tasks, newest first, with status, assignee, note and result.",
    inputSchema: { type: "object", properties: { company: COMPANY, status: s("Only tasks in this state.", { enum: ["OPEN", "RUNNING", "DONE", "FAILED", "CANCELLED"] }) }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, d) => {
      const status = opt(a, "status");
      return d.json("GET", `/companies/${enc(await companyId(d, a))}/tasks${status ? `?status=${enc(status)}` : ""}`);
    },
  },
  {
    name: "create_task", title: "Give an agent a task",
    description: "Create a one-off task for an agent. The daemon runs open tasks one at a time; pass run=true to run it now and get the result (subject to the agent's and company's monthly budgets).",
    inputSchema: {
      type: "object",
      properties: { company: COMPANY, agent: s("Agent id, name or role."), title: s("What to do, in one line."), body: s("Details, context, acceptance criteria."), run: { type: "boolean", description: "Run now and wait for the result." } },
      required: ["agent", "title"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (a, d) => {
      const company = await companyId(d, a);
      const agent = await agentOf(d, company, arg(a, "agent", 200));
      const { task } = await d.json<{ task: { id: string } }>("POST", `/companies/${enc(company)}/tasks`, { title: arg(a, "title", 300), body: opt(a, "body"), assignee: agent.id });
      if (a.run !== true) return { task };
      return d.json("POST", `/tasks/${enc(task.id)}/run`);
    },
  },
  {
    name: "run_task", title: "Run a task now",
    description: "Run an open task now and return its result.",
    inputSchema: { type: "object", properties: { task_id: s("The task id (tk_…).") }, required: ["task_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (a, d) => d.json("POST", `/tasks/${enc(arg(a, "task_id", 100))}/run`),
  },
  {
    name: "get_task", title: "Get a task",
    description: "One task with its status, note and result.",
    inputSchema: { type: "object", properties: { task_id: s("The task id (tk_…).") }, required: ["task_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, d) => d.json("GET", `/tasks/${enc(arg(a, "task_id", 100))}`),
  },
  {
    name: "ask_agent", title: "Ask an agent",
    description: "Send a message to an agent and get its answer. The agent answers with its own model, system prompt and company memory. Pass conversation_id from an earlier answer to continue that conversation.",
    inputSchema: {
      type: "object",
      properties: { company: COMPANY, agent: s("Agent id, name or role."), message: s("Your message."), conversation_id: s("Continue this conversation (cv_…).") },
      required: ["agent", "message"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (a, d) => {
      let conversationId = opt(a, "conversation_id");
      const message = arg(a, "message", 100_000);
      let agentName: string | undefined;
      if (!conversationId) {
        const agent = await agentOf(d, await companyId(d, a), arg(a, "agent", 200));
        agentName = agent.name;
        conversationId = (await d.json<{ conversation: { id: string } }>("POST", "/conversations", { agentId: agent.id, title: message.slice(0, 60) })).conversation.id;
      }
      let text = ""; let failed: string | undefined; let stopReason: string | undefined;
      await d.turn(conversationId, message, ev => {
        if (ev.type === "delta") text += ev.text;
        else if (ev.type === "error") failed = ev.error;
        else if (ev.type === "done") stopReason = ev.stopReason;
      });
      if (failed && !text) throw new ToolError(failed);
      return { conversationId, ...(agentName ? { agent: agentName } : {}), answer: text, stopReason, ...(failed ? { error: failed } : {}) };
    },
  },
  {
    name: "list_skills", title: "List skills",
    description: "SKILL.md skills installed for Braavolabs agents (user folder and registered projects). The company panel shows which agent has which skill.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_a, d) => d.json("GET", "/skills"),
  },
  {
    name: "search_memory", title: "Search company memory",
    description: "Full-text search over the company's notes: company.md, department notes, agents' core notes and journals, watch findings. Words match by prefix; all words must match.",
    inputSchema: {
      type: "object",
      properties: { company: COMPANY, query: s("Words to find."), scope: s('Only this scope: "company", "department:<name>" or "agent:<role>".') },
      required: ["query"], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, d) => {
      const scope = opt(a, "scope");
      return d.json("GET", `/companies/${enc(await companyId(d, a))}/memory?${new URLSearchParams({ q: arg(a, "query", 500), ...(scope ? { scope } : {}) })}`);
    },
  },
  {
    name: "read_memory", title: "Read a memory note",
    description: "Read one note, or list every note when path is omitted (with each agent's core and journal paths).",
    inputSchema: { type: "object", properties: { company: COMPANY, path: s("e.g. company.md, departments/growth.md, agents/market-analyst/core.md, findings/market-analyst.md") }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, d) => {
      const path = opt(a, "path");
      return d.json("GET", `/companies/${enc(await companyId(d, a))}/memory${path ? `?${new URLSearchParams({ path })}` : ""}`);
    },
  },
  {
    name: "write_memory", title: "Write a memory note",
    description: "Replace one note (the whole file). Allowed: company.md, departments/<name>.md, agents/<agent>/core.md (≤2000 chars, read by the agent in every conversation), agents/<agent>/notes.md, notes/<name>.md. Every change is versioned with git under ~/.braavo/memory.",
    inputSchema: {
      type: "object",
      properties: { company: COMPANY, path: s("Note path."), content: s("The full new content (Markdown).") },
      required: ["path", "content"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (a, d) => {
      if (typeof a.content !== "string") throw new ToolError("content is required");
      return d.json("PUT", `/companies/${enc(await companyId(d, a))}/memory`, { path: arg(a, "path", 200), content: a.content });
    },
  },
];

type Id = string | number | null;
type Message = { jsonrpc: "2.0"; id?: Id; method?: string; params?: any };

const reply = (id: Id, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

function asText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n… (cut at ${MAX_TOOL_TEXT} characters)` : text;
}

export interface McpServerOptions {
  version: string;
  /** Resolves the daemon per call (it may start after the MCP server); throws when it is not running. */
  daemon: () => McpDaemon;
}

/** One JSON-RPC message in, at most one out (notifications get none). */
export async function handleMcpMessage(msg: Message, o: McpServerOptions): Promise<object | null> {
  const id = msg.id ?? null;
  const isRequest = msg.id !== undefined;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isRequest ? fail(id, -32600, "invalid request") : null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = (MCP_SERVER_PROTOCOLS as readonly string[]).includes(asked) ? asked : MCP_SERVER_PROTOCOLS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "braavo", title: "Braavolabs company", version: o.version },
        instructions: "Your local Braavolabs company: agents with their own models and budgets, tasks, and company memory. Read company_panel first; use create_task or ask_agent to hand work to an agent; search_memory before asking the user for company facts.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isRequest ? reply(id, {}) : null;
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
    case "tools/call": {
      const tool = TOOLS.find(t => t.name === msg.params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${String(msg.params?.name).slice(0, 80)}`);
      const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments as Record<string, unknown> : {};
      try {
        const value = await tool.run(args, o.daemon());
        return reply(id, { content: [{ type: "text", text: asText(value) }], ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}) });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return reply(id, { content: [{ type: "text", text: text.slice(0, 2000) }], isError: true });
      }
    }
    default:
      return isRequest ? fail(id, -32601, `method not found: ${msg.method.slice(0, 80)}`) : null;
  }
}

/** Line-delimited JSON-RPC over stdio until stdin ends. Requests run concurrently; replies keep their ids. */
export async function serveMcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, o: McpServerOptions): Promise<void> {
  const send = (m: object) => { output.write(`${JSON.stringify(m)}\n`); };
  const pending = new Set<Promise<void>>();
  let buffer = "";
  const onLine = (line: string) => {
    if (!line.trim()) return;
    let msg: Message;
    try { msg = JSON.parse(line); } catch { send(fail(null, -32700, "parse error")); return; }
    const batch = Array.isArray(msg) ? msg as Message[] : [msg];
    for (const m of batch) {
      const p = handleMcpMessage(m, o).then(r => { if (r) send(r); }, e => send(fail(m?.id ?? null, -32603, String(e instanceof Error ? e.message : e).slice(0, 300))));
      pending.add(p); void p.finally(() => pending.delete(p));
    }
  };
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { send(fail(null, -32700, "message too large")); buffer = ""; }
  }
  if (buffer.trim()) onLine(buffer);
  await Promise.all(pending);
}

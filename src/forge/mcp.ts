/**
 * forge mcp — a dependency-free Model Context Protocol stdio client.
 *
 * MCP stdio framing is line-delimited JSON-RPC 2.0: every message is a single
 * JSON object on one line terminated by "\n". This module implements just enough
 * of the client side to register servers, list their tools, and call a tool —
 * built on node:child_process + JSON.parse, with NO runtime dependency.
 *
 * Design notes:
 *   - Server config lives in ~/.forge/mcp.json as { name: {command, args[]} }.
 *     The command is stored as an ARG ARRAY, never a joined string — so there is
 *     no shell and no injection seam when the server is later spawned.
 *   - The handshake is: initialize (request) → notifications/initialized (notify)
 *     → tools/list | tools/call. clientInfo identifies us as { name:"forge" }.
 *   - stderr from the server is surfaced verbatim (debug, painted steel by the
 *     caller) but NEVER parsed — only stdout carries JSON-RPC.
 *   - Every request has a timeout (default 10s) so a wedged server can't hang us.
 *
 * child spawn is injectable so tests drive a mock stdio server end-to-end.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CONFIG_DIR } from "./config";

export const MCP_PATH = join(CONFIG_DIR, "mcp.json");
export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const FORGE_VERSION = "0.1.0";
export const DEFAULT_MCP_TIMEOUT_MS = 10_000;

const CLIENT_INFO = { name: "forge", version: FORGE_VERSION };

/** A registered MCP server: its launch command and discrete argument array. */
export interface McpServerDef {
  command: string;
  args: string[];
}
export type McpConfig = Record<string, McpServerDef>;

export function loadMcpConfig(path: string = MCP_PATH): McpConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as McpConfig) : {};
  } catch {
    return {};
  }
}

export function saveMcpConfig(cfg: McpConfig, path: string = MCP_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

export function addMcpServer(cfg: McpConfig, name: string, command: string, args: string[]): McpConfig {
  // Store args as a discrete array — string-joining here would reintroduce a
  // shell-injection seam at spawn time.
  return { ...cfg, [name]: { command, args: [...args] } };
}

export function removeMcpServer(cfg: McpConfig, name: string): McpConfig {
  const next = { ...cfg };
  delete next[name];
  return next;
}

export type ParsedMcpAdd = { name: string; command: string; args: string[] } | { error: string };

/**
 * Parse `forge mcp add <name> -- <command> [args...]` from the tokens that
 * follow "add" (i.e. [name, "--", command, ...args]). The "--" separator is
 * mandatory so the server command is never confused with forge's own flags.
 */
export function parseMcpAdd(afterAdd: string[]): ParsedMcpAdd {
  const name = afterAdd[0];
  if (!name || name === "--") return { error: "usage: forge mcp add <name> -- <command> [args...]" };
  const dashIdx = afterAdd.indexOf("--");
  if (dashIdx < 0) return { error: 'missing "--" separator before the server command' };
  const command = afterAdd[dashIdx + 1];
  if (!command) return { error: 'no command after "--"' };
  const args = afterAdd.slice(dashIdx + 2);
  return { name, command, args };
}

export class McpError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export class McpTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`MCP request "${method}" timed out after ${ms}ms`);
    this.name = "McpTimeoutError";
  }
}

/** Minimal child-process surface used by the client (so tests inject a fake). */
export interface McpChildLike {
  stdin: { write(s: string): void };
  stdout: { on(event: "data", cb: (data: unknown) => void): void };
  stderr: { on(event: "data", cb: (data: unknown) => void): void };
  on(event: "error", cb: (err: Error) => void): void;
  kill(): void;
}

export type McpSpawn = (command: string, args: string[]) => McpChildLike;

export interface McpClientOpts {
  timeoutMs: number;
  onStderr?: (chunk: string) => void;
}

interface Pending {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal JSON-RPC 2.0 client over one MCP stdio child. Buffers stdout,
 * splits on "\n", and matches responses to requests by numeric id.
 */
export class McpClient {
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private child: McpChildLike, private opts: McpClientOpts) {
    child.stdout.on("data", (d) => this.onData(String(d)));
    // stderr is DEBUG passthrough only — never parsed as JSON-RPC.
    child.stderr.on("data", (d) => this.opts.onStderr?.(String(d)));
    child.on("error", (e) => this.failAll(e));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON noise on stdout — ignore rather than crash. (stderr never reaches here.)
        continue;
      }
      if (typeof msg?.id !== "number") continue; // notifications / unmatched
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new McpError(String(msg.error?.message ?? "JSON-RPC error"), msg.error?.code));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Send a request and resolve with its `result` (or reject on error/timeout). */
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(method, this.opts.timeoutMs));
      }, this.opts.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Fire a notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new McpError("client closed"));
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

export interface WithMcpOpts {
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn a server, run the MCP handshake (initialize → notifications/initialized),
 * hand the ready client to `fn`, then always tear the child down.
 */
export async function withMcpServer<T>(
  def: McpServerDef,
  spawnImpl: McpSpawn,
  opts: WithMcpOpts,
  fn: (client: McpClient) => Promise<T>,
): Promise<T> {
  const child = spawnImpl(def.command, def.args);
  const client = new McpClient(child, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    onStderr: opts.onStderr,
  });
  try {
    await client.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    client.notify("notifications/initialized");
    return await fn(client);
  } finally {
    client.close();
  }
}

export interface McpTool {
  name: string;
  description?: string;
  [k: string]: unknown;
}

export interface McpContentBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
}

/** Full flow: handshake, tools/list, return the tool descriptors. */
export async function listServerTools(
  def: McpServerDef,
  spawnImpl: McpSpawn,
  opts: WithMcpOpts = {},
): Promise<McpTool[]> {
  return withMcpServer(def, spawnImpl, opts, async (client) => {
    const res = await client.request("tools/list");
    return Array.isArray(res?.tools) ? (res.tools as McpTool[]) : [];
  });
}

/** Full flow: handshake, tools/call, return the call result (content + isError). */
export async function callServerTool(
  def: McpServerDef,
  toolName: string,
  args: Record<string, unknown>,
  spawnImpl: McpSpawn,
  opts: WithMcpOpts = {},
): Promise<McpCallResult> {
  return withMcpServer(def, spawnImpl, opts, async (client) => {
    const res = await client.request("tools/call", {
      name: toolName,
      arguments: args ?? {},
    });
    return {
      content: Array.isArray(res?.content) ? (res.content as McpContentBlock[]) : [],
      isError: Boolean(res?.isError),
    };
  });
}

/** Default real spawn: node:child_process, pipes wired for line JSON-RPC. */
export function defaultMcpSpawn(command: string, args: string[]): McpChildLike {
  return spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as McpChildLike;
}

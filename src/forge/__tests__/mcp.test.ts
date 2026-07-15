import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  parseMcpAdd,
  addMcpServer,
  removeMcpServer,
  saveMcpConfig,
  loadMcpConfig,
  listServerTools,
  callServerTool,
  MCP_PROTOCOL_VERSION,
  McpTimeoutError,
  type McpChildLike,
  type McpTool,
} from "../mcp";
import { renderMcpList, renderMcpTools, renderMcpCallResult } from "../../forge";
import { makeUi } from "../ui";

const colorUi = makeUi({ tty: true });

// ── parseMcpAdd ────────────────────────────────────────────────────────────────
describe("parseMcpAdd", () => {
  it("splits name / command / args around the mandatory -- separator", () => {
    const r = parseMcpAdd(["fs", "--", "npx", "-y", "@mcp/server-filesystem", "/tmp"]);
    expect(r).toEqual({ name: "fs", command: "npx", args: ["-y", "@mcp/server-filesystem", "/tmp"] });
  });
  it("allows a command with zero args", () => {
    expect(parseMcpAdd(["tiny", "--", "my-server"])).toEqual({ name: "tiny", command: "my-server", args: [] });
  });
  it("errors when the -- separator is missing", () => {
    expect(parseMcpAdd(["fs", "npx", "server"])).toEqual({ error: expect.stringContaining('"--"') });
  });
  it("errors when there is no command after --", () => {
    expect(parseMcpAdd(["fs", "--"])).toEqual({ error: expect.stringContaining("no command") });
  });
  it("errors when the name is missing", () => {
    expect(parseMcpAdd([])).toEqual({ error: expect.stringContaining("usage") });
  });
});

// ── config round-trip (arg-array preservation) ─────────────────────────────────
describe("mcp config store", () => {
  const path = join(tmpdir(), `forge-mcp-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

  it("add → save → load round-trips and preserves args as a discrete ARRAY", () => {
    const cfg = addMcpServer({}, "fs", "npx", ["-y", "@mcp/server-filesystem", "/tmp"]);
    saveMcpConfig(cfg, path);
    const loaded = loadMcpConfig(path);
    expect(loaded.fs.command).toBe("npx");
    expect(Array.isArray(loaded.fs.args)).toBe(true);
    expect(loaded.fs.args).toEqual(["-y", "@mcp/server-filesystem", "/tmp"]);
    rmSync(path, { force: true });
  });

  it("rm removes a server without disturbing the others", () => {
    let cfg = addMcpServer({}, "a", "cmd-a", []);
    cfg = addMcpServer(cfg, "b", "cmd-b", ["x"]);
    cfg = removeMcpServer(cfg, "a");
    expect(cfg.a).toBeUndefined();
    expect(cfg.b).toEqual({ command: "cmd-b", args: ["x"] });
  });

  it("returns {} for a missing config file", () => {
    expect(loadMcpConfig(join(tmpdir(), "forge-mcp-nope.json"))).toEqual({});
  });
});

// ── mock stdio JSON-RPC server ─────────────────────────────────────────────────
interface FakeServerOpts {
  respond?: boolean;
  tools?: McpTool[];
  callResult?: { content: Array<{ type?: string; text?: string }>; isError?: boolean };
}

/**
 * A fake MCP stdio child that speaks line-delimited JSON-RPC 2.0. It records
 * every message the client sends (raw + parsed) and auto-answers initialize /
 * tools/list / tools/call. `respond:false` simulates a wedged server (timeout).
 */
function makeFakeServer(opts: FakeServerOpts = {}) {
  const respond = opts.respond ?? true;
  let stdoutCb: (d: unknown) => void = () => {};
  let stderrCb: (d: unknown) => void = () => {};
  const rawWrites: string[] = [];
  const sent: any[] = [];
  let killed = false;

  const child: McpChildLike = {
    stdin: {
      write(s: string) {
        rawWrites.push(s);
        for (const line of s.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          const msg = JSON.parse(t);
          sent.push(msg);
          if (msg.id === undefined || !respond) continue; // notification, or hung server
          let result: any;
          if (msg.method === "initialize") {
            result = { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "fake" } };
          } else if (msg.method === "tools/list") {
            result = { tools: opts.tools ?? [] };
          } else if (msg.method === "tools/call") {
            result = opts.callResult ?? { content: [] };
          }
          const response = `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`;
          queueMicrotask(() => stdoutCb(Buffer.from(response)));
        }
      },
    },
    stdout: { on: (_e, cb) => void (stdoutCb = cb) },
    stderr: { on: (_e, cb) => void (stderrCb = cb) },
    on: () => {},
    kill: () => void (killed = true),
  };

  return {
    child,
    rawWrites,
    sent,
    emitStderr: (s: string) => stderrCb(Buffer.from(s)),
    get killed() {
      return killed;
    },
  };
}

const DEF = { command: "my-mcp", args: ["--stdio"] };

describe("listServerTools — full JSON-RPC handshake", () => {
  it("runs initialize → notifications/initialized → tools/list and returns the tools", async () => {
    const server = makeFakeServer({ tools: [{ name: "read_file", description: "read a file" }, { name: "write_file" }] });
    let spawnedWith: { command: string; args: string[] } | undefined;
    const spawnImpl = (command: string, args: string[]) => {
      spawnedWith = { command, args };
      return server.child;
    };
    const tools = await listServerTools(DEF, spawnImpl, { timeoutMs: 1000 });
    expect(tools.map((t) => t.name)).toEqual(["read_file", "write_file"]);
    // spawn received the command + args as a discrete array (no shell)
    expect(spawnedWith).toEqual({ command: "my-mcp", args: ["--stdio"] });
    // handshake ordering + identity
    const methods = server.sent.map((m) => m.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    const init = server.sent[0];
    expect(init.jsonrpc).toBe("2.0");
    expect(init.params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(init.params.clientInfo.name).toBe("forge");
    // the initialized message is a NOTIFICATION (no id)
    expect(server.sent[1].id).toBeUndefined();
    // child was torn down
    expect(server.killed).toBe(true);
  });

  it("frames every message as a single-line JSON object terminated by \\n", () => {
    const server = makeFakeServer({ tools: [] });
    return listServerTools(DEF, () => server.child, { timeoutMs: 1000 }).then(() => {
      for (const w of server.rawWrites) {
        expect(w.endsWith("\n")).toBe(true);
        const inner = w.slice(0, -1);
        expect(inner).not.toContain("\n"); // exactly one line per write
        expect(() => JSON.parse(inner)).not.toThrow();
      }
    });
  });
});

describe("callServerTool", () => {
  it("sends tools/call with name+arguments and returns the content text", async () => {
    const server = makeFakeServer({
      callResult: { content: [{ type: "text", text: "hello world" }] },
    });
    const result = await callServerTool(DEF, "greet", { who: "world" }, () => server.child, { timeoutMs: 1000 });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe("hello world");
    const call = server.sent.find((m) => m.method === "tools/call");
    expect(call.params).toEqual({ name: "greet", arguments: { who: "world" } });
  });

  it("surfaces isError from the tool result", async () => {
    const server = makeFakeServer({
      callResult: { content: [{ type: "text", text: "bad input" }], isError: true },
    });
    const result = await callServerTool(DEF, "boom", {}, () => server.child, { timeoutMs: 1000 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("bad input");
  });
});

describe("timeout + stderr", () => {
  it("rejects with McpTimeoutError when the server never answers", async () => {
    const server = makeFakeServer({ respond: false });
    await expect(listServerTools(DEF, () => server.child, { timeoutMs: 25 })).rejects.toBeInstanceOf(McpTimeoutError);
  });

  it("passes server stderr to onStderr verbatim and NEVER parses it as JSON-RPC", async () => {
    const server = makeFakeServer({ tools: [{ name: "ok" }] });
    const stderrChunks: string[] = [];
    const p = listServerTools(DEF, () => server.child, {
      timeoutMs: 1000,
      onStderr: (c) => stderrChunks.push(c),
    });
    // Emit non-JSON debug noise on stderr — must not break the JSON-RPC stream.
    server.emitStderr("[debug] booting server\n");
    server.emitStderr("not json at all }{");
    const tools = await p;
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
    expect(stderrChunks.join("")).toContain("[debug] booting server");
  });
});

// ── renderers (terminal-noir, no green) ────────────────────────────────────────
function assertNoGreen(text: string) {
  expect(text).not.toMatch(/\x1b\[(?:\d+;)*(?:32|92)m/);
  expect(text).not.toContain("38;5;2m");
}

describe("mcp renderers", () => {
  it("list shows each server with its command + args, arc-blue never green", () => {
    const lines = renderMcpList(colorUi, { fs: { command: "npx", args: ["-y", "srv"] } });
    const joined = lines.join("\n");
    expect(joined).toContain("fs");
    expect(joined).toContain("npx -y srv");
    expect(joined).toContain("38;5;75");
    assertNoGreen(joined);
  });

  it("list on an empty config gives an honest hint", () => {
    const lines = renderMcpList(colorUi, {});
    expect(lines.join("\n")).toContain("No MCP servers");
  });

  it("tools table lists names + first-line descriptions", () => {
    const lines = renderMcpTools(colorUi, "fs", [{ name: "read", description: "read a file\nmore" }]);
    const joined = lines.join("\n");
    expect(joined).toContain("fs · tools (1)");
    expect(joined).toContain("read");
    expect(joined).toContain("read a file");
    expect(joined).not.toContain("more"); // only the first description line
    assertNoGreen(joined);
  });

  it("call result prints textual content; isError routes through the molten fail line", () => {
    const ok = renderMcpCallResult(colorUi, { content: [{ type: "text", text: "42" }], isError: false });
    expect(ok.join("\n")).toContain("42");
    const err = renderMcpCallResult(colorUi, { content: [{ type: "text", text: "nope" }], isError: true });
    const joined = err.join("\n");
    expect(joined).toContain("error");
    expect(joined).toContain("nope");
    expect(joined).toContain("38;5;203"); // molten
    assertNoGreen(joined);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStore } from "../../daemon/store";
import { Daemon } from "../../daemon/server";
import { ChatService } from "../../daemon/chat";
import { CompanyMemory } from "../../daemon/memory";
import { DaemonClient } from "../daemon-client";
import { handleMcpMessage, MCP_SERVER_PROTOCOLS, serveMcp, TOOLS, type McpDaemon } from "../mcp-server";

const KEY = "gsk_test_0123456789abcdef";
const TOKEN = "t".repeat(43);
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const sse = (text: string) => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`, "data: [DONE]\n\n",
].join(""), { status: 200 });

/** A real daemon (chat, memory, tasks) on loopback, and an MCP server talking to it over stdio streams. */
async function harness() {
  const store = new DaemonStore(":memory:");
  const memory = new CompanyMemory(mkdtempSync(join(tmpdir(), "braavo-mcp-")), store, { git: false });
  const fetchImpl = vi.fn(async () => sse("Ship on Monday."));
  const chat = new ChatService(store, { keys: { get: () => KEY }, keyProviders: () => ["groq"], fetchImpl: fetchImpl as never, memory });
  const co = store.createCompany({ name: "Acme" });
  const writer = store.createAgent({ companyId: co.id, name: "Writer", role: "content-social", provider: "GROQ", model: "openai/gpt-oss-20b" });
  const daemon = new Daemon({
    store, token: TOKEN, version: "test", chat, memory,
    runTask: async id => { store.updateTask(id, { status: "DONE", result: "Drafted." }); return { outcome: "done" }; },
  });
  const port = await daemon.listen(0);
  closers.push(async () => { await daemon.close(); store.close(); });

  const input = new PassThrough(); const output = new PassThrough();
  const served = serveMcp(input, output, { version: "1.1.0", daemon: () => new DaemonClient({ port, token: TOKEN }) });
  const waiting = new Map<number, (m: any) => void>();
  let buffer = "";
  output.on("data", (c: Buffer) => {
    buffer += c.toString();
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) { const m = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1); waiting.get(m.id)?.(m); }
  });
  let seq = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>(resolve => {
    const id = ++seq; waiting.set(id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  return { store, memory, co, writer, fetchImpl, rpc, tool, input, served };
}

describe("braavo mcp serve (5.2)", () => {
  it("negotiates the protocol and lists eleven tools with schemas and hints", async () => {
    const { rpc, input, served } = await harness();
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "braavo", version: "1.1.0" } });
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe(MCP_SERVER_PROTOCOLS[0]);
    const { tools } = (await rpc("tools/list")).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["list_companies", "company_panel", "list_tasks", "create_task", "run_task", "get_task", "ask_agent", "list_skills", "search_memory", "read_memory", "write_memory"]);
    for (const t of tools) { expect(t.inputSchema.type).toBe("object"); expect(t).not.toHaveProperty("run"); }
    expect(tools.find((t: { name: string }) => t.name === "write_memory").annotations).toMatchObject({ destructiveHint: true });
    expect((await rpc("ping")).result).toEqual({});
    expect((await rpc("resources/list")).error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "rm_rf" })).error.code).toBe(-32602);
    input.end();
    await served;
  });

  it("reads the panel, gives an agent a task and runs it, asks the agent, and uses memory", async () => {
    const { tool, store, writer, fetchImpl } = await harness();
    expect((await tool("company_panel")).structuredContent.company.name).toBe("Acme");

    const created = await tool("create_task", { agent: "writer", title: "Draft the launch post", run: true });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ outcome: "done", task: { status: "DONE", result: "Drafted.", assignee_agent_id: writer.id } });
    expect((await tool("list_tasks", { status: "DONE" })).structuredContent.tasks).toHaveLength(1);

    const written = await tool("write_memory", { path: "agents/content-social/core.md", content: "Sign every post as YULA Lab." });
    expect(written.structuredContent.doc).toMatchObject({ path: "agents/content-social/core.md" });
    expect((await tool("search_memory", { query: "sign post" })).structuredContent.hits[0].path).toBe("agents/content-social/core.md");
    expect((await tool("read_memory", { path: "agents/content-social/core.md" })).structuredContent.content).toContain("YULA Lab");

    const asked = await tool("ask_agent", { agent: "Writer", message: "When do we ship?" });
    expect(asked.structuredContent).toMatchObject({ agent: "Writer", answer: "Ship on Monday.", stopReason: "end_turn" });
    const system = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body).messages[0].content;
    expect(system).toContain("Sign every post as YULA Lab.");
    const again = await tool("ask_agent", { agent: "Writer", message: "And the time?", conversation_id: asked.structuredContent.conversationId });
    expect(again.structuredContent.conversationId).toBe(asked.structuredContent.conversationId);
    expect(store.messages(asked.structuredContent.conversationId)).toHaveLength(4);
  });

  it("returns tool failures as isError results the model can read", async () => {
    const { tool, store, co } = await harness();
    expect(await tool("create_task", { agent: "nobody", title: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('no agent "nobody"; agents: Writer') }] });
    expect((await tool("write_memory", { path: "../escape.md", content: "x" })).isError).toBe(true);
    expect((await tool("get_task", {})).content[0].text).toBe("task_id is required");
    store.createCompany({ name: "Beta" });
    expect((await tool("company_panel")).content[0].text).toMatch(/several companies; pass company \(one of: Acme, Beta\)/);
    expect((await tool("company_panel", { company: "beta" })).structuredContent.company.name).toBe("Beta");
    expect((await tool("company_panel", { company: co.id })).structuredContent.company.name).toBe("Acme");
  });

  it("answers bad JSON with a parse error, ignores notifications and reports a stopped daemon per call", async () => {
    const out: string[] = [];
    const input = new PassThrough(); const output = new PassThrough();
    output.on("data", (c: Buffer) => out.push(...c.toString().split("\n").filter(Boolean)));
    const served = serveMcp(input, output, { version: "x", daemon: () => { throw new Error("The Braavolabs daemon is not running. Start it: braavo daemon start"); } });
    input.write("{not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_companies", arguments: {} } })}\n`);
    input.end();
    await served;
    const msgs = out.map(l => JSON.parse(l));
    expect(msgs[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ id: 7, result: { isError: true, content: [{ text: expect.stringContaining("braavo daemon start") }] } });
  });

  it("keeps every tool's schema closed and its name MCP-safe", async () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(r);
    }
    const d = { json: vi.fn(), turn: vi.fn() } as unknown as McpDaemon;
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/cancelled" }, { version: "x", daemon: () => d })).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "1.0" as "2.0", id: 1, method: "ping" }, { version: "x", daemon: () => d })).toMatchObject({ error: { code: -32600 } });
  });
});

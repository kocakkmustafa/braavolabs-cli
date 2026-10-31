import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { DaemonStore } from "../store";
import { ChatError, ChatService, type ChatEvent } from "../chat";
import { Daemon } from "../server";

const KEY = "gsk_test_0123456789abcdef";
const TOKEN = "t".repeat(43);
const stores: DaemonStore[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.close();
  while (stores.length) stores.pop()!.close();
});

const sse = (...chunks: unknown[]) => new Response([...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200 });
const answer = (text: string, usage = { prompt_tokens: 10, completion_tokens: 3 }) => sse(
  { choices: [{ delta: { content: text.slice(0, 4) } }] },
  { choices: [{ delta: { content: text.slice(4) }, finish_reason: "stop" }] },
  { choices: [], usage },
);

function setup(fetchImpl: (...args: any[]) => Promise<Response>, keys: Record<string, string> = { groq: KEY }) {
  const store = new DaemonStore(":memory:"); stores.push(store);
  const changed: string[] = [];
  const chat = new ChatService(store, {
    keys: { get: p => keys[p] }, keyProviders: () => Object.keys(keys), fetchImpl: fetchImpl as never,
  }, id => changed.push(id));
  return { store, chat, changed };
}

async function turn(chat: ChatService, id: string, content: string, signal?: AbortSignal): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await chat.send(id, content, e => events.push(e), signal);
  return events;
}

describe("chat service", () => {
  it("streams a multi-turn conversation, sending the whole history and storing both sides", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(answer("Hello there."))
      .mockResolvedValueOnce(answer("Paris, again.", { prompt_tokens: 30, completion_tokens: 4 }));
    const { store, chat, changed } = setup(fetchImpl);
    const cv = chat.create({ provider: "GROQ", model: "openai/gpt-oss-20b", effort: "low" });

    const first = await turn(chat, cv.id, "Hi!");
    expect(first.map(e => e.type)).toEqual(["message", "delta", "delta", "usage", "done"]);
    expect(first.filter(e => e.type === "delta").map(e => (e as { text: string }).text).join("")).toBe("Hello there.");
    await turn(chat, cv.id, "Capital of France?");

    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body).toMatchObject({ model: "openai/gpt-oss-20b", stream: true, reasoning_effort: "low" });
    expect(body.messages).toEqual([
      { role: "user", content: "Hi!" }, { role: "assistant", content: "Hello there." }, { role: "user", content: "Capital of France?" },
    ]);
    const { conversation, messages } = chat.get(cv.id);
    expect(conversation.title).toBe("Hi!");
    expect(messages.map(m => [m.role, m.content, m.stopReason])).toEqual([
      ["user", "Hi!", null], ["assistant", "Hello there.", "end_turn"], ["user", "Capital of France?", null], ["assistant", "Paris, again.", "end_turn"],
    ]);
    expect(store.db.prepare("SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM cost_event").get()).toEqual({ i: 40, o: 7 });
    expect(chat.list()[0]).toMatchObject({ id: cv.id, messageCount: 4, lastMessage: "Paris, again." });
    expect(chat.search("Paris")[0]).toMatchObject({ conversationId: cv.id, role: "assistant" });
    expect(changed.length).toBeGreaterThan(3);
    for (const t of ["conversation", "message", "cost_event"]) expect(JSON.stringify(store.db.prepare(`SELECT * FROM ${t}`).all())).not.toContain(KEY);
  });

  it("refuses before streaming: missing key, no model, busy, oversize", async () => {
    let release!: () => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = () => resolve(answer("late reply")); }));
    const { chat } = setup(fetchImpl, {});
    const anthropic = chat.create({ provider: "ANTHROPIC", model: "claude-sonnet-5-5" });
    await expect(turn(chat, anthropic.id, "hi")).rejects.toMatchObject({ status: 400, code: "missing-key", message: "no anthropic key; run: braavo keys add anthropic" });
    expect(chat.get(anthropic.id).messages).toEqual([]);

    const local = chat.create({ provider: "OLLAMA", model: "qwen3:8b" });
    const pending = turn(chat, local.id, "first");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await expect(turn(chat, local.id, "second")).rejects.toMatchObject({ status: 409, code: "busy" });
    release();
    await pending;
    expect((fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers.Authorization).toBeUndefined();
    await expect(turn(chat, local.id, "x".repeat(100_001))).rejects.toMatchObject({ status: 413 });
    expect(() => chat.create({ provider: "NOPE", model: "m" })).toThrow(ChatError);
  });

  it("keeps the partial answer on abort and redacts provider errors", async () => {
    const { chat } = setup(async (_url: string, init: any) => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`));
        init.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 200 }));
    const cv = chat.create({ provider: "GROQ", model: "openai/gpt-oss-20b" });
    const events: ChatEvent[] = [];
    const sending = chat.send(cv.id, "go", e => { events.push(e); if (e.type === "delta") chat.abort(cv.id); });
    await sending;
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "aborted" });
    expect(chat.get(cv.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "Partial", stopReason: "aborted" });

    const failing = setup(async () => new Response(`invalid key ${KEY}`, { status: 401 }));
    const cv2 = failing.chat.create({ provider: "GROQ", model: "openai/gpt-oss-20b" });
    const errEvents = await turn(failing.chat, cv2.id, "go");
    const err = errEvents.find(e => e.type === "error") as { error: string };
    expect(err.error).toContain("[redacted]");
    expect(err.error).not.toContain(KEY);
  });

  it("imports idempotently and suggests models from the user's own keys and local models", async () => {
    const fetchImpl = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? Response.json({ models: [{ name: "qwen3:8b" }] }) : new Response("", { status: 404 })));
    const { chat } = setup(fetchImpl, { anthropic: "sk-ant-x" });
    const conversations = [{ externalId: "s1", title: "Old", createdAt: "2026-10-01T10:00:00Z", messages: [{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }] }];
    expect(chat.import("desktop-localstorage", conversations)).toMatchObject({ imported: 1, skipped: 0 });
    expect(chat.import("desktop-localstorage", conversations)).toMatchObject({ imported: 0, skipped: 1 });
    expect(chat.search("old answer")).toHaveLength(1);
    expect(() => chat.import("Desktop!", conversations)).toThrow(ChatError);

    const models = await chat.models();
    expect(models.local).toEqual({ OLLAMA: ["qwen3:8b"], LMSTUDIO: [] });
    expect(models.providers.find(p => p.id === "ANTHROPIC")).toEqual({ id: "ANTHROPIC", hasKey: true, local: false });
    expect(models.suggestions.strong).toEqual({ status: "ok", provider: "ANTHROPIC", model: "claude-opus-5-5" });
    expect(models.suggestions.light).toEqual({ status: "ok", provider: "OLLAMA", model: "qwen3:8b" });
    expect(JSON.stringify(models)).not.toContain("sk-ant-x");
  });
});

describe("chat over the daemon API", () => {
  async function boot(fetchImpl: (...args: any[]) => Promise<Response>) {
    const { store, chat } = setup(fetchImpl);
    const daemon = new Daemon({ store, token: TOKEN, version: "test", chat });
    daemons.push(daemon);
    const port = await daemon.listen(0);
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; headers: any; text: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { call, store };
  }

  it("creates, streams over SSE, lists, renames, imports, searches and deletes", async () => {
    const { call } = await boot(async () => answer("Hello there."));
    const created = await call("POST", "/v1/conversations", { provider: "GROQ", model: "openai/gpt-oss-20b" });
    expect(created.status).toBe(201);
    const id = JSON.parse(created.text).conversation.id;

    const streamed = await call("POST", `/v1/conversations/${id}/messages`, { content: "Hi" });
    expect(streamed.status).toBe(200);
    expect(streamed.headers["content-type"]).toBe("text/event-stream");
    const frames = streamed.text.trim().split("\n\n").map(f => f.split("\n")[0].replace("event: ", ""));
    expect(frames).toEqual(["message", "delta", "delta", "usage", "done"]);

    const missing = await call("POST", "/v1/conversations/cv_nope/messages", { content: "Hi" });
    expect([missing.status, JSON.parse(missing.text).code]).toEqual([404, "not-found"]);

    expect(JSON.parse((await call("PATCH", `/v1/conversations/${id}`, { title: "Greeting" })).text).conversation.title).toBe("Greeting");
    expect(JSON.parse((await call("POST", "/v1/conversations/import", { source: "desktop-localstorage", conversations: [{ externalId: "a", messages: [{ role: "user", content: "imported text" }] }] })).text).imported).toBe(1);
    const list = JSON.parse((await call("GET", "/v1/conversations?limit=10")).text).conversations;
    expect(list).toHaveLength(2);
    expect(JSON.parse((await call("GET", "/v1/search?q=imported")).text).results).toHaveLength(1);
    expect((await call("DELETE", `/v1/conversations/${id}`)).status).toBe(204);
    expect((await call("GET", `/v1/conversations/${id}`)).status).toBe(404);
    expect(JSON.parse((await call("GET", "/v1/search?q=Hello")).text).results).toEqual([]);
  });
});

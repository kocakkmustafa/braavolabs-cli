import { afterEach, describe, expect, it } from "vitest";
import { DaemonStore } from "../../daemon/store";
import { ChatService } from "../../daemon/chat";
import { Daemon } from "../../daemon/server";
import { DaemonClient, DaemonRequestError, parseFrame, parseModelFlag, type ChatStreamEvent } from "../daemon-client";

const TOKEN = "k".repeat(43);
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const sse = (...texts: string[]) => new Response([
  ...texts.map(t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n",
].join(""), { status: 200 });

async function boot() {
  const store = new DaemonStore(":memory:");
  const chat = new ChatService(store, { keys: { get: () => undefined }, keyProviders: () => [], fetchImpl: (async () => sse("Merhaba", " dünya")) as never });
  const daemon = new Daemon({ store, token: TOKEN, version: "test", chat });
  const port = await daemon.listen(0);
  cleanup.push(() => store.close(), () => daemon.close());
  return new DaemonClient({ port, token: TOKEN });
}

describe("daemon chat client", () => {
  it("creates a conversation and streams a turn from a real daemon", async () => {
    const client = await boot();
    const { conversation } = await client.json<{ conversation: { id: string } }>("POST", "/conversations", { provider: "OLLAMA", model: "qwen3:8b" });
    const events: ChatStreamEvent[] = [];
    await client.turn(conversation.id, "selam", e => events.push(e));
    expect(events.filter(e => e.type === "delta").map(e => (e as { text: string }).text).join("")).toBe("Merhaba dünya");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    const shown = await client.json<{ messages: Array<{ role: string }> }>("GET", `/conversations/${conversation.id}`);
    expect(shown.messages.map(m => m.role)).toEqual(["user", "assistant"]);
  });

  it("surfaces daemon errors with their code and rejects a wrong token", async () => {
    const client = await boot();
    const { conversation } = await client.json<{ conversation: { id: string } }>("POST", "/conversations", { provider: "ANTHROPIC", model: "claude-sonnet-5-5" });
    await expect(client.turn(conversation.id, "hi", () => {})).rejects.toMatchObject({ status: 400, code: "missing-key" });
    const wrong = new DaemonClient({ port: (client as any).endpoint.port, token: "x".repeat(43) });
    await expect(wrong.json("GET", "/conversations")).rejects.toBeInstanceOf(DaemonRequestError);
  });

  it("parses frames and PROVIDER/model flags with slashes in the model", () => {
    expect(parseFrame('event: delta\ndata: {"text":"a"}')).toEqual({ type: "delta", text: "a" });
    expect(parseFrame("event: delta")).toBeNull();
    expect(parseModelFlag("groq/openai/gpt-oss-20b")).toEqual({ provider: "GROQ", model: "openai/gpt-oss-20b" });
    expect(parseModelFlag("ollama")).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonStore } from "../store";
import { ChatService } from "../chat";
import { RelayChat, type RelayChatBridge } from "../relay-chat";
import { RelayBridge, type RelayTransport } from "../../forge/relay-bridge";

const stores: DaemonStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

const sse = (...texts: string[]) => new Response([
  ...texts.map((t, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: t }, ...(i === texts.length - 1 ? { finish_reason: "stop" } : {}) }] })}\n\n`),
  "data: [DONE]\n\n",
].join(""), { status: 200 });

function setup(fetchImpl: (...a: any[]) => Promise<Response>, defaultModel: { provider: string; model: string } | null = { provider: "OLLAMA", model: "qwen3:8b" }) {
  const store = new DaemonStore(":memory:"); stores.push(store);
  const chat = new ChatService(store, { keys: { get: () => undefined }, keyProviders: () => [], fetchImpl: fetchImpl as never });
  const frames: Array<[string, string?]> = [];
  const bridge: RelayChatBridge = {
    emitOutput: async t => { frames.push(["output", t]); },
    emitAgentTurn: async s => { frames.push(["agent-turn", s]); },
    setStatus: async s => { frames.push(["status", s]); },
  };
  const relay = new RelayChat(chat, store, { defaultModel: async () => defaultModel ?? undefined, flushMs: 5 });
  relay.attach(bridge);
  return { store, chat, relay, frames };
}

describe("relay chat (phone ↔ daemon)", () => {
  it("answers a steer as one turn: running, streamed output, final agent-turn, idle", async () => {
    const { chat, relay, frames } = setup(async () => sse("Hel", "lo ", "phone."));
    await relay.onSteer("Hi from my phone");
    expect(frames[0]).toEqual(["status", "running"]);
    expect(frames.filter(f => f[0] === "output").map(f => f[1]).join("")).toBe("Hello phone.");
    expect(frames.slice(-2)).toEqual([["agent-turn", "Hello phone."], ["status", "idle"]]);
    const [cv] = chat.list();
    expect(cv).toMatchObject({ source: "relay", provider: "OLLAMA", model: "qwen3:8b", messageCount: 2 });
  });

  it("continues the same conversation, starts a new one on /new and switches model on /model", async () => {
    const fetchImpl = vi.fn(async () => sse("ok"));
    const { chat, relay, store } = setup(fetchImpl);
    await relay.onSteer("one");
    await relay.onSteer("two");
    expect(chat.list()).toHaveLength(1);
    await relay.onSteer("/model GROQ/openai/gpt-oss-20b");
    expect(chat.list()[0]).toMatchObject({ provider: "GROQ", model: "openai/gpt-oss-20b" });
    await relay.onSteer("/new");
    await relay.onSteer("/model LMSTUDIO/google/gemma-3-4b-it");
    await relay.onSteer("three");
    expect(chat.list()).toHaveLength(2);
    expect(chat.list()[0]).toMatchObject({ provider: "LMSTUDIO", model: "google/gemma-3-4b-it" });
    // A restarted daemon picks the latest relay conversation back up.
    expect(new RelayChat(chat, store, { defaultModel: async () => undefined })["current"]).toBe(chat.list()[0].id);
  });

  it("reports setup-required and provider errors as agent-turn text starting with error:", async () => {
    const none = setup(async () => sse("x"), null);
    await none.relay.onSteer("hello");
    expect(none.frames.find(f => f[0] === "agent-turn")?.[1]).toMatch(/^error: setup required/);

    const missingKey = setup(async () => sse("x"), { provider: "ANTHROPIC", model: "claude-sonnet-5-5" });
    await missingKey.relay.onSteer("hello");
    expect(missingKey.frames.find(f => f[0] === "agent-turn")?.[1]).toBe("error: no anthropic key; run: braavo keys add anthropic");
  });

  it("works through the real RelayBridge with commands from the relay and keeps frames in order", async () => {
    const posted: any[] = [];
    let deliver!: (raw: unknown) => void;
    const transport: RelayTransport = {
      register: async () => ({ sessionId: "s1" }),
      // Slow, out-of-order-prone network: later posts would overtake earlier ones without the queue.
      postEvent: async (_id, ev) => { await new Promise(r => setTimeout(r, Math.random() * 5)); posted.push(ev); },
      subscribeCommands: (_id, onCmd) => { deliver = onCmd; return () => {}; },
    };
    const { relay } = setup(async () => sse("a", "b", "c", "d"));
    const bridge = new RelayBridge(transport, relay.handlers());
    relay.attach(bridge);
    await bridge.start({ surface: "cli", label: "Braavo chat · test" });
    deliver({ type: "steer", message: "go" });
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "status", state: "idle" }));
    const text = posted.filter(e => e.type === "output").map(e => Buffer.from(e.textB64, "base64").toString("utf8")).join("");
    expect(text).toBe("abcd");
    expect(posted[0]).toEqual({ type: "status", state: "running" });
    expect(posted.at(-2)).toEqual({ type: "agent-turn", summary: "abcd" });
  });
});

describe("company commands from the phone", () => {
  it("shows the panel, pauses an agent and runs a routine through the relay chat", async () => {
    const { hire, companyCommand } = await import("../company");
    const { store, relay, frames, chat } = setup(async () => sse("x"));
    const co = store.createCompany({ name: "YULA Lab" });
    hire(store, co.id, { templates: ["ceo", "market-analyst"], urls: { "market-analyst/watch-competitors": ["https://rival.example"] } }, { keys: new Set(), local: { OLLAMA: ["qwen3:8b"] } });
    const run = vi.fn(async () => ({ outcome: "no-change", note: "1 pages · /tmp/x.md" }));
    (relay as any).options.company = (c: string, a: string) => companyCommand(store, c, a, { run, canUse: p => chat.canUse(p), memoryRoot: "/nonexistent" });

    await relay.onSteer("/company");
    const panelText = frames.filter(f => f[0] === "agent-turn").at(-1)![1]!;
    expect(panelText).toContain("YULA Lab · 2 agents");
    expect(panelText).toContain("• General Manager — OLLAMA/qwen3:8b · medium · idle");
    expect(panelText).toContain("  • Market Analyst — OLLAMA/qwen3:8b · low · idle");
    await relay.onSteer("/pause market-analyst");
    expect(frames.filter(f => f[0] === "agent-turn").at(-1)![1]).toBe("Market Analyst: paused");
    await relay.onSteer("/run Watch competitors");
    expect(frames.filter(f => f[0] === "agent-turn").at(-1)![1]).toBe("Watch competitors: no-change · 1 pages");
    await relay.onSteer("/findings");
    expect(frames.filter(f => f[0] === "agent-turn").at(-1)![1]).toBe("No findings yet.");
    expect(chat.list()).toEqual([]); // commands never open a model conversation
  });
});

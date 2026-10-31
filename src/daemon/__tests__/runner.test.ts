import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonStore } from "../store";
import { runRoutine } from "../runner";
import { install, planInstall, renderPlist, stableNodePath, uninstall, LAUNCHD_LABEL } from "../launchd";

const KEY = "gsk_test_0123456789abcdef";
const stores: DaemonStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

function setup(agent: { provider: string; model: string; effort?: string; effortRounding?: string }, preflight?: unknown) {
  const store = new DaemonStore(":memory:"); stores.push(store);
  const co = store.createCompany({ name: "Acme" });
  const ag = store.createAgent({ companyId: co.id, name: "Analyst", role: "analyst", systemPrompt: "You watch the market.", ...agent });
  const rt = store.createRoutine({ companyId: co.id, agentId: ag.id, name: "Morning scan", prompt: "Summarize overnight changes.", rrule: "FREQ=DAILY", timezone: "UTC", createdBy: "user", nextFireAt: new Date().toISOString(), ...(preflight ? { preflight } : {}) });
  return { store, co, ag, rt };
}

const sse = (...chunks: unknown[]) => new Response([...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(""), { status: 200 });

/** Everything the daemon persisted, as one string, to prove the key never lands on disk. */
function dump(store: DaemonStore): string {
  const tables = ["company", "agent", "routine", "conversation", "message", "cost_event", "activity"];
  return tables.map(t => JSON.stringify(store.db.prepare(`SELECT * FROM ${t}`).all())).join("\n");
}

describe("routine runner", () => {
  it("calls an OpenAI-compatible provider with the stored key and effort, and records the run", async () => {
    const { store, co, ag, rt } = setup({ provider: "GROQ", model: "openai/gpt-oss-20b", effort: "low" });
    const fetchImpl = vi.fn(async (_url: string, _init: any) => sse(
      { choices: [{ delta: { content: "Two price " } }] },
      { choices: [{ delta: { content: "changes." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
    ));
    const result = await runRoutine(store, rt.id, { keys: { get: p => (p === "groq" ? KEY : undefined) }, fetchImpl: fetchImpl as never });

    expect(result.outcome).toBe("ran");
    expect(result.note).toMatch(/42\/7 tokens · effort low$/);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "openai/gpt-oss-20b", stream: true, reasoning_effort: "low" });
    expect(body.messages).toEqual([{ role: "system", content: "You watch the market." }, { role: "user", content: "Summarize overnight changes." }]);

    expect(store.searchMessages("price changes")).toHaveLength(1);
    expect(store.costEvents(co.id)).toEqual([{ agent_id: ag.id, provider: "GROQ", model: "openai/gpt-oss-20b", input_tokens: 42, output_tokens: 7, usd: 0 }]);
    expect(store.recentActivity(co.id)[0]).toMatchObject({ actor: ag.id, verb: "ran-routine" });
    expect(dump(store)).not.toContain(KEY);
  });

  it("fails without calling the provider when no key is stored", async () => {
    const { store, rt } = setup({ provider: "GROQ", model: "openai/gpt-oss-20b" });
    const fetchImpl = vi.fn();
    const result = await runRoutine(store, rt.id, { keys: { get: () => undefined }, fetchImpl: fetchImpl as never });
    expect(result).toEqual({ outcome: "failed", note: "no groq key; run: braavo keys add groq" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts a key echoed back in a provider error", async () => {
    const { store, rt } = setup({ provider: "GROQ", model: "openai/gpt-oss-20b" });
    const fetchImpl = async () => new Response(`{"error":{"message":"Invalid API Key ${KEY}"}}`, { status: 401 });
    const result = await runRoutine(store, rt.id, { keys: { get: () => KEY }, fetchImpl: fetchImpl as never });
    expect(result.outcome).toBe("failed");
    expect(result.note).toContain("[redacted]");
    expect(result.note).not.toContain(KEY);
    expect(dump(store)).not.toContain(KEY);
  });

  it("streams Anthropic through the SDK client with output_config effort", async () => {
    const { store, rt } = setup({ provider: "ANTHROPIC", model: "claude-opus-5-5", effort: "medium" });
    let params: any; let clientKey = "";
    const client = {
      messages: {
        async *stream(p: Record<string, unknown>) {
          params = p;
          yield { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 1 } } };
          yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All quiet." } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } };
        },
      },
    };
    const result = await runRoutine(store, rt.id, { keys: { get: () => "sk-ant-test" }, anthropicClient: async k => { clientKey = k; return client; } });
    expect(result.outcome).toBe("ran");
    expect(clientKey).toBe("sk-ant-test");
    expect(params).toMatchObject({ model: "claude-opus-5-5", system: "You watch the market.", output_config: { effort: "medium" } });
    expect(result.note).toMatch(/11\/4 tokens · effort medium$/);
  });

  it("needs no key for a local provider and sends no Authorization header", async () => {
    const { store, rt } = setup({ provider: "OLLAMA", model: "qwen3:8b", effort: "high" });
    const fetchImpl = vi.fn(async (_url: string, _init: any) => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    const result = await runRoutine(store, rt.id, { keys: { get: () => { throw new Error("must not read keys"); } }, fetchImpl: fetchImpl as never });
    expect(result.outcome).toBe("ran");
    expect(result.note).toContain("effort default (no-profile)");
    expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("does not run routines whose preflight is not implemented yet", async () => {
    const { store, rt } = setup({ provider: "GROQ", model: "openai/gpt-oss-20b" }, { type: "monitor", url: "https://example.com" });
    const fetchImpl = vi.fn();
    const result = await runRoutine(store, rt.id, { keys: { get: () => KEY }, fetchImpl: fetchImpl as never });
    expect(result.outcome).toBe("skipped-preflight-unsupported");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("launchd agent", () => {
  const o = { node: "/opt/node/bin/node", script: "/Users/a&b/braavo.js", log: "/Users/a&b/.braavo/daemon/daemon.log" };

  it("renders a per-user LaunchAgent that restarts only after a crash", () => {
    const plist = renderPlist(o);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/Users/a&amp;b/braavo.js</string>\n    <string>daemon</string>\n    <string>run</string>");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
    expect(plist).not.toMatch(/EnvironmentVariables|KEY|TOKEN/);
    expect(plist).not.toContain("--relay");
    expect(renderPlist({ ...o, relay: true })).toContain("<string>run</string>\n    <string>--relay</string>");
  });

  it("points at Homebrew's version-free node link so upgrades do not break the agent", () => {
    expect(stableNodePath("/opt/homebrew/Cellar/node/26.9.0/bin/node", p => p === "/opt/homebrew/bin/node")).toBe("/opt/homebrew/bin/node");
    expect(stableNodePath("/usr/local/Cellar/node@24/24.22.0/bin/node", p => p === "/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(stableNodePath("/opt/homebrew/Cellar/node/26.9.0/bin/node", () => false)).toBe("/opt/homebrew/Cellar/node/26.9.0/bin/node");
    expect(stableNodePath("/Users/a/.nvm/versions/node/v26.9.0/bin/node", () => true)).toBe("/Users/a/.nvm/versions/node/v26.9.0/bin/node");
  });

  it("installs into the GUI domain and replaces an existing install in place", () => {
    const calls: string[][] = []; const files = new Map<string, string>();
    const deps = {
      home: "/h", uid: 501, exec: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); },
      writeFile: (p: string, d: string) => { files.set(p, d); }, removeFile: (p: string) => { files.delete(p); },
      exists: (p: string) => files.has(p), mkdir: () => {},
    };
    const plan = install(o, deps);
    expect(plan).toEqual(planInstall(o, deps));
    expect(plan.path).toBe(`/h/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(calls).toEqual([["launchctl", "bootstrap", "gui/501", plan.path]]);

    install(o, deps);
    expect(calls.slice(1)).toEqual([["launchctl", "bootout", `gui/501/${LAUNCHD_LABEL}`], ["launchctl", "bootstrap", "gui/501", plan.path]]);

    expect(uninstall(deps)).toBe(true);
    expect(files.size).toBe(0);
    expect(uninstall(deps)).toBe(false);
  });
});

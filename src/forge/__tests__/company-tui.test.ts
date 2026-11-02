import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { initialTuiState, parseUsd, plain, reduceKey, renderTui, runCompanyTui, withData, type TuiAction, type TuiPanel, type TuiState, type TuiTask } from "../company-tui";
import { setLocale } from "../locale";

afterEach(() => setLocale("en"));

const PANEL: TuiPanel = {
  company: { id: "co_1", name: "Acme", monthlyBudgetUsd: 20 },
  agents: [
    { id: "ag_1", name: "Writer", role: "content-social", status: "idle", provider: "ANTHROPIC", model: "claude-sonnet-5-5", budgetUsdMonthly: 5, budgetRatio: 0.9, month: { usd: 4.5, runs: 3 } },
    { id: "ag_2", name: "Analyst", role: "market-analyst", status: "paused", provider: "OLLAMA", model: "qwen3:8b", budgetUsdMonthly: null, budgetRatio: null, month: { usd: 0, runs: 0 } },
    { id: "ag_3", name: "Broken", role: "ceo", status: "error", provider: "GROQ", model: "placeholder", budgetUsdMonthly: null, budgetRatio: null, month: { usd: 0, runs: 0 } },
  ],
  month: { usd: 4.5, unpricedCalls: 2, budgetRatio: 0.225 },
};
const TASKS: TuiTask[] = [
  { id: "tk_1", title: "Draft post", status: "OPEN", assignee_agent_id: "ag_1", note: null, result: null },
  { id: "tk_2", title: "Price check", status: "DONE", assignee_agent_id: "ag_2", note: null, result: "All good" },
];
const ready = (): TuiState => withData(initialTuiState(), PANEL, TASKS);
const press = (state: TuiState, ...keys: string[]) => {
  let s = state; let action: TuiAction | undefined; let quit = false;
  for (const k of keys) { const r = reduceKey(s, k); s = r.state; action = r.action ?? action; quit ||= Boolean(r.quit); }
  return { state: s, action, quit };
};

describe("company tui keys", () => {
  it("moves, switches lists and maps agent keys to daemon actions", () => {
    expect(press(ready(), "\u001b[B").state.agent).toBe(1);
    expect(press(ready(), "\u001b[B", "\u001b[B", "\u001b[B").state.agent).toBe(2);
    expect(press(ready(), "k").state.agent).toBe(0);
    expect(press(ready(), "p").action).toEqual({ type: "pause", agentId: "ag_1" });
    expect(press(ready(), "j", "p").action).toEqual({ type: "resume", agentId: "ag_2" });
    expect(press(ready(), "\t").state.focus).toBe("tasks");
    expect(press(ready(), "q").quit).toBe(true);
    expect(press(ready(), "\u0003").quit).toBe(true);
  });

  it("collects a task title and budgets through prompts", () => {
    expect(press(ready(), "t", "S", "h", "i", "p", "\u007f", "p", "\r").action).toEqual({ type: "task-add", agentId: "ag_1", title: "Ship" });
    expect(press(ready(), "t", "\u001b").state.prompt).toBeNull();
    expect(press(ready(), "t", "\r").action).toBeUndefined();
    const budget = press(ready(), "b");
    expect(budget.state.prompt).toEqual({ kind: "agent-budget", text: "5" });
    expect(press(budget.state, "\u007f", "1", "2", ".", "5", "\r").action).toEqual({ type: "agent-budget", agentId: "ag_1", usd: 12.5 });
    expect(press(budget.state, "\u007f", "\r").action).toEqual({ type: "agent-budget", agentId: "ag_1", usd: null });
    const bad = press(budget.state, "x", "\r");
    expect(bad.action).toBeUndefined();
    expect(bad.state.prompt).not.toBeNull();
    expect(bad.state.message).toBe("Enter an amount like 25 or 25.50.");
    expect(press(ready(), "B", "\u007f", "\u007f", "3", "0", "\r").action).toEqual({ type: "company-budget", usd: 30 });
    // Escape sequences typed into a prompt never reach the text.
    expect(press(ready(), "t", "\u001b[31m").state.prompt).toEqual({ kind: "task", text: "" });
    expect(press(ready(), "t", "a\u0007b").state.prompt?.text).toBe("");
  });

  it("offers only the task actions the task's state allows", () => {
    const tasks = press(ready(), "\t").state;
    expect(press(tasks, "r").action).toEqual({ type: "task-run", taskId: "tk_1" });
    expect(press(tasks, "c").action).toEqual({ type: "task-cancel", taskId: "tk_1" });
    expect(press(tasks, "o").action).toBeUndefined();
    expect(press(tasks, "j", "o").action).toEqual({ type: "task-reopen", taskId: "tk_2" });
    expect(press(tasks, "j", "r").action).toBeUndefined();
    expect(press(tasks, "p").action).toBeUndefined();
  });

  it("keeps the cursor inside a list that shrank", () => {
    const s = press(ready(), "j", "j").state;
    expect(withData(s, { ...PANEL, agents: PANEL.agents.slice(0, 1) }, []).agent).toBe(0);
  });
});

describe("company tui screen", () => {
  it("shows budgets, statuses, unpriced calls, tasks and the selected result", () => {
    const lines = renderTui(press(ready(), "\t", "j").state, 160, 40);
    const text = lines.join("\n");
    expect(text).toContain("Acme · Budget: $4.50 / $20.00 [##--------] 23%");
    expect(text).toContain("2 calls on unpriced models");
    expect(text).toContain("Writer · idle · ANTHROPIC/claude-sonnet-5-5 · $4.50 / $5.00 [#########-] 90%");
    expect(text).toContain("Analyst · paused · OLLAMA/qwen3:8b · $0.00 · no budget");
    expect(text).toContain("Broken · error · — (braavo setup)");
    expect(text).toContain("> DONE      Price check · Analyst");
    expect(text).toContain("  All good");
    expect(text).toContain("q quit");
  });

  it("strips control characters from daemon text and fits every line", () => {
    const evil = { ...PANEL, company: { ...PANEL.company, name: "Acme\u001b]0;pwned\u0007\u001b[2J" } };
    const lines = renderTui(withData(initialTuiState(), evil, [{ ...TASKS[0], note: "line1\nline2\u009b" }]), 40, 20);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect([...line].length).toBeLessThanOrEqual(40);
    }
    expect(plain("a\u001bb")).toBe("a b");
  });

  it("localizes its own text", () => {
    setLocale("tr");
    const text = renderTui(ready(), 200, 40).join("\n");
    expect(text).toContain("Bütçe: $4.50");
    expect(text).toContain("Ajanlar");
    expect(text).toContain("q çık");
  });

  it("parses amounts", () => {
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("$25")).toBe(25);
    expect(parseUsd("25,50")).toBe(25.5);
    for (const bad of ["-1", "1e3", "abc", "1.234", "100001"]) expect(parseUsd(bad), bad).toBe("invalid");
  });
});

class FakeIn extends EventEmitter {
  raw: boolean[] = [];
  setRawMode(on: boolean) { this.raw.push(on); return this; }
  resume() { return this; }
  pause() { return this; }
}
class FakeOut extends EventEmitter {
  columns = 120; rows = 30; written = "";
  write(s: string) { this.written += s; return true; }
}

describe("company tui driver", () => {
  it("loads, acts, reloads and restores the terminal on quit", async () => {
    const input = new FakeIn(); const output = new FakeOut();
    const actions: TuiAction[] = []; let loads = 0;
    const run = runCompanyTui({
      input: input as never, output: output as never, pollMs: 60_000,
      load: async () => { loads += 1; return { panel: PANEL, tasks: TASKS }; },
      act: async (a) => { actions.push(a); if (a.type === "resume") throw new Error("daemon said no\u001b[2J"); return "Agent updated: Writer"; },
    });
    await new Promise(r => setTimeout(r, 5));
    expect(output.written).toContain("\u001b[?1049h");
    expect(output.written).toContain("Writer");
    input.emit("data", Buffer.from("p"));
    await new Promise(r => setTimeout(r, 5));
    expect(actions).toEqual([{ type: "pause", agentId: "ag_1" }]);
    expect(output.written).toContain("Agent updated: Writer");
    input.emit("data", Buffer.from("j"));
    input.emit("data", Buffer.from("p"));
    await new Promise(r => setTimeout(r, 5));
    expect(output.written).toContain("daemon said no");
    expect(loads).toBe(3);
    input.emit("data", Buffer.from("q"));
    await run;
    expect(input.raw).toEqual([true, false]);
    expect(output.written.endsWith("\u001b[?25h\u001b[?1049l")).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
  });
});

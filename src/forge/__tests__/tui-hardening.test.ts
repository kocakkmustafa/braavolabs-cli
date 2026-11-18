import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { initialBoard, reduceBoard, renderBoard, selectedItem, withData, type BoardAction, type BoardData, type BoardState } from "../tui/board";
import { runBoard } from "../tui/run";
import { ENTER_SCREEN, LEAVE_SCREEN, openTerminal } from "../tui/term";
import { sanitizeText, wrapPlain } from "../tui/theme";
import { terminalWidth } from "../terminal-text";

const NONE = { color: false, light: false };
const agent = (id: string, name: string, status = "idle") => ({ id, name, role: "r", status, provider: "P", model: "m", budgetUsdMonthly: null, budgetRatio: null, month: { usd: 0, runs: 0 } });
const conv = (id: string, title: string) => ({ id, title, lastMessage: null, messageCount: 0, updatedAt: "x" });
const DATA: BoardData = {
  company: null,
  agents: [agent("a1", "Valar", "running"), agent("a2", "Kod"), agent("a3", "Destek", "paused")],
  tasks: [], conversations: [conv("c1", "Bir"), conv("c2", "Iki")],
  approvals: [{ id: "ap1", title: "Gonder", tool: "Mail", paths: [], created_at: "x" }],
};
const ready = (d = DATA): BoardState => reduceBoard(withData(initialBoard(false), d), "x").state;
const press = (s: BoardState, ...keys: string[]) => {
  let st = s; let action: BoardAction | undefined;
  for (const k of keys) { const r = reduceBoard(st, k); st = r.state; action = r.action ?? action; }
  return { state: st, action };
};
const screen = (s: BoardState, cols = 100, rows = 30) => renderBoard(s, { cols, rows }, NONE).join("\n");

describe("typed lines go to the id captured when writing started", () => {
  it("a list that shifts under the cursor does not redirect a chat message or a task", () => {
    const chat = press(ready(), "\u001b[Z", "j", "\r", "h", "i").state; // writing to c2
    expect(chat.target).toMatchObject({ kind: "conversation", id: "c2", name: "Iki" });
    expect(screen(chat)).toContain("To Iki › hi▌");
    const shifted = withData(chat, { ...DATA, conversations: [conv("c0", "Yeni"), ...DATA.conversations] });
    expect(selectedItem(shifted)).toMatchObject({ kind: "conversation", conversation: { id: "c2" } });
    expect(press(shifted, "\r").action).toEqual({ type: "send", conversationId: "c2", text: "hi" });
    const task = press(ready(), "j", "j", "\r", "g", "o").state; // company tab: approval, Valar, Kod → writing to Kod
    expect(task.target).toMatchObject({ kind: "agent", id: "a2" });
    const reordered = withData(task, { ...DATA, agents: [agent("a9", "Yeni"), ...DATA.agents] });
    expect(press(reordered, "\r").action).toEqual({ type: "task-add", agentId: "a2", title: "go" });
    expect(press(task, "\u001b").state.target).toBeNull();
  });

  it("keeps the same item selected across refreshes and falls back to the nearest position", () => {
    const s = press(ready(), "j", "j").state; // Kod
    const moved = withData(s, { ...DATA, agents: [agent("a0", "Zero"), ...DATA.agents] });
    expect(selectedItem(moved)).toMatchObject({ kind: "agent", agent: { id: "a2" } });
    const gone = withData(s, { ...DATA, agents: [DATA.agents[0]] });
    expect(selectedItem(gone)).toMatchObject({ kind: "agent", agent: { id: "a1" } });
  });
});

describe("one decision per confirm", () => {
  it("blocks a second decision while an action is in flight", () => {
    const first = press(ready(), "o", "\r");
    expect(first.action).toEqual({ type: "approval", id: "ap1", decision: "allow" });
    expect(first.state.pending).toBe(true);
    expect(first.state.confirm).toBeNull();
    expect(press(first.state, "o").state.confirm).toBeNull();
    expect(press(first.state, "r", "\r").action).toBeUndefined();
    expect(press(first.state, "!").state.confirm).toBeNull();
  });

  it("! shows the count and freezes the agents it will pause when the prompt opens", () => {
    const asked = press(ready(), "!").state;
    expect(screen(asked)).toContain("Pause 2 agents?");
    const refreshed = withData(asked, { ...DATA, agents: [...DATA.agents, agent("a4", "Late")] });
    expect(press(refreshed, "\r").action).toEqual({ type: "pause-all", agentIds: ["a1", "a2"] });
  });
});

class In extends EventEmitter { raw: boolean[] = []; setRawMode(on: boolean) { this.raw.push(on); return this; } resume() { return this; } pause() { return this; } }
class Out extends EventEmitter { columns = 100; rows = 30; isTTY = true; written = ""; write(s: string) { this.written += s; return true; } }
class Proc extends EventEmitter { pid = 4242; exited: number[] = []; killed: string[] = []; exit(c?: number) { this.exited.push(c ?? 0); } kill(_pid: number, sig: string) { this.killed.push(sig); } }
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

describe("a slow refresh never undoes what happened meanwhile", () => {
  it("confirm → Enter → refresh finishing late: no confirm comes back, one decision only", async () => {
    const input = new In(); const output = new Out(); const proc = new Proc();
    let slow = false; const acted: BoardAction[] = [];
    const release: Array<() => void> = [];
    const run = runBoard({
      input: input as never, output: output as never, proc: proc as never, env: { NO_COLOR: "1" }, loggedIn: true, pollMs: 5,
      load: () => slow ? new Promise<BoardData>(res => { release.push(() => res(DATA)); }) : Promise.resolve(DATA),
      loadMessages: async () => [], act: async a => { acted.push(a); return "done"; },
    });
    await tick(20);
    slow = true; await tick(15); // a poll is now stuck on a slow load
    input.emit("data", Buffer.from("o")); await tick();
    expect(output.written).toContain("Approve: Gonder?");
    input.emit("data", Buffer.from("\r")); await tick(15);
    expect(acted).toHaveLength(1);
    release.splice(0).forEach(f => f()); await tick(20); // the stale refresh finishes now
    output.written = "";
    input.emit("data", Buffer.from("\r")); await tick(20); // a second Enter must not decide again
    expect(acted).toHaveLength(1);
    slow = false; release.splice(0).forEach(f => f()); await tick(30);
    expect(output.written).not.toContain("Approve: Gonder?");
    input.emit("data", Buffer.from("q")); await run;
  });

  it("typed text and the cursor survive a refresh that finishes after the keys", async () => {
    const input = new In(); const output = new Out(); const proc = new Proc();
    let slow = false; const release: Array<() => void> = [];
    const run = runBoard({
      input: input as never, output: output as never, proc: proc as never, env: { NO_COLOR: "1" }, loggedIn: true, pollMs: 5,
      load: () => slow ? new Promise<BoardData>(res => { release.push(() => res(DATA)); }) : Promise.resolve(DATA),
      loadMessages: async () => [], act: async () => "",
    });
    await tick(20); slow = true; await tick(15);
    for (const k of ["j", "\r", "a", "b"]) input.emit("data", Buffer.from(k));
    await tick();
    release.splice(0).forEach(f => f()); await tick(20);
    output.written = ""; slow = false; release.splice(0).forEach(f => f()); await tick(30);
    expect(output.written).toContain("To Valar › ab▌");
    input.emit("data", Buffer.from("\u001b")); input.emit("data", Buffer.from("q")); await run;
  });
});

describe("terminal hardening", () => {
  const make = () => { const input = new In(); const output = new Out(); const proc = new Proc(); const errors: string[] = []; const term = openTerminal({ input: input as never, output: output as never, proc: proc as never, stderr: s => errors.push(s) }); return { input, output, proc, errors, term }; };

  it("SIGINT restores and exits 130", () => {
    const { output, proc } = make(); proc.emit("SIGINT");
    expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true); expect(proc.exited).toEqual([130]);
  });

  it("Ctrl-Z and SIGTSTP leave the screen and stop; SIGCONT re-enters raw mode and redraws", () => {
    for (const stop of ["byte", "signal"]) {
      const { input, output, proc, term } = make(); let redraws = 0; term.onResize(() => { redraws += 1; });
      if (stop === "byte") input.emit("data", Buffer.from("\u001a")); else proc.emit("SIGTSTP");
      expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
      expect(proc.killed).toEqual(["SIGSTOP"]); expect(input.raw).toEqual([true, false]);
      output.written = ""; term.draw(["x"]); expect(output.written).toBe("");
      proc.emit("SIGCONT");
      expect(output.written).toBe(ENTER_SCREEN); expect(input.raw).toEqual([true, false, true]); expect(redraws).toBe(1);
      term.close();
    }
  });

  it("a closed stdin or a broken stdout pipe gives the terminal back and reports it", () => {
    for (const how of ["end", "close", "epipe"]) {
      const { input, output, term } = make(); let closed = 0; term.onClose(() => { closed += 1; });
      if (how === "epipe") output.emit("error", new Error("EPIPE")); else input.emit(how);
      expect(term.closed).toBe(true); expect(closed).toBe(1); expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
    }
  });

  it("an uncaught exception restores the screen first and only then prints the error", () => {
    const { output, proc, errors } = make();
    const order: string[] = [];
    const write = output.write.bind(output); output.write = (s: string) => { if (s === LEAVE_SCREEN) order.push("restore"); return write(s); };
    const stderrIndex = () => order.push("stderr");
    proc.emit("uncaughtException", new Error("boom"));
    stderrIndex();
    expect(order).toEqual(["restore", "stderr"]);
    expect(errors.join("")).toContain("boom"); expect(proc.exited).toEqual([1]);
  });

  it("draws at most `rows` lines", () => {
    const { output, term } = make(); output.rows = 3; output.written = "";
    term.draw(["a", "b", "c", "d", "e"]);
    expect(output.written).toBe("\u001b[Ha\u001b[K\r\nb\u001b[K\r\nc\u001b[K\u001b[J");
  });

  it("the driver ends when the terminal goes away", async () => {
    const input = new In(); const output = new Out(); const proc = new Proc();
    const run = runBoard({ input: input as never, output: output as never, proc: proc as never, env: {}, loggedIn: true, pollMs: 60_000, load: async () => DATA, loadMessages: async () => [], act: async () => "" });
    await tick(); input.emit("end"); await run;
    expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
  });
});

describe("text handling", () => {
  it("keeps line breaks and tabs in chat text but removes escape sequences, CR and format characters", () => {
    expect(sanitizeText("a\r\nb\tc\u001b[2J‮d\u0007\re")).toBe("a\nb  c[2Jd\ne");
    expect(wrapPlain("line1\n\n  code()\nxxxxxxxxxxxx", 6)).toEqual(["line1", "", "  code", "()", "xxxxxx", "xxxxxx"]);
    const s = reduceBoard(withData(initialBoard(false), DATA), "x").state;
    const withMsg = { ...press(s, "\u001b[Z").state, messagesFor: "c1", messages: [{ role: "assistant" as const, content: "```\nif (x) {\n  run();\n}\n```" }] };
    const text = screen(withMsg);
    expect(text).toContain("if (x) {\n");
    expect(text).toMatch(/\n {2}.*  run\(\);/);
  });

  it("counts a flag emoji (regional indicator pair) as two cells", () => {
    expect(terminalWidth("🇹🇷")).toBe(2);
    expect(terminalWidth("a🇹🇷b")).toBe(4);
  });

  it("shows a small-terminal message instead of a broken layout", () => {
    expect(screen(ready(), 19, 30)).toBe("Terminal too small");
    expect(screen(ready(), 100, 7)).toBe("Terminal too small");
    expect(renderBoard(ready(), { cols: 20, rows: 8 }, NONE)).toHaveLength(8);
  });
});

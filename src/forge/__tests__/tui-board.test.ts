import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { setLocale } from "../locale";
import { counts, initialBoard, itemsFor, listRows, reduceBoard, renderBoard, selectedItem, wantedConversation, withData, withMessages, withOffline, type BoardAction, type BoardData, type BoardState } from "../tui/board";
import { terminalWidth } from "../terminal-text";
import { runBoard } from "../tui/run";
import { ENTER_SCREEN, LEAVE_SCREEN } from "../tui/term";

afterEach(() => setLocale("en"));
const NONE = { color: false, light: false };
const COLOR = { color: true, light: false };
const agent = (id: string, name: string, status: string) => ({ id, name, role: "role", status, provider: "ANTHROPIC", model: "claude-sonnet-5-5", budgetUsdMonthly: 5, budgetRatio: 0.5, month: { usd: 2.5, runs: 2 } });
const DATA: BoardData = {
  company: { id: "co_1", name: "Acme", monthlyBudgetUsd: 120, monthUsd: 38 },
  agents: [agent("a1", "Valar", "running"), agent("a2", "Pazarlama", "idle"), agent("a3", "Kod", "running"), agent("a4", "Muhasebe", "error"), agent("a5", "Destek", "paused")],
  tasks: [
    { id: "t1", title: "Haftalık bülten", status: "RUNNING", assignee_agent_id: "a2", note: null, result: null },
    { id: "t2", title: "Fatura", status: "DONE", assignee_agent_id: "a1", note: null, result: "Hazır\u001b[2J" },
  ],
  approvals: [{ id: "ap1", title: "Bülteni 2.418 aboneye gönder", tool: "Mailchimp", paths: ["ui/lib/para.ts", "ui/lib/para.test.ts"], created_at: "2026-11-18T10:00:00Z" }],
  conversations: [
    { id: "c1", title: "Valar", lastMessage: "Düzelttim", messageCount: 2, updatedAt: "2026-11-18T10:00:00Z" },
    { id: "c2", title: "Rakip analizi", lastMessage: null, messageCount: 0, updatedAt: "2026-11-17T10:00:00Z" },
  ],
};
const press = (state: BoardState, ...keys: string[]) => {
  let s = state; let action: BoardAction | undefined; let quit = false;
  for (const k of keys) { const r = reduceBoard(s, k); s = r.state; action = r.action ?? action; quit ||= Boolean(r.quit); }
  return { state: s, action, quit };
};
// Data loaded and the splash dismissed with a key: the Company tab on its first row (the approval).
const ready = (): BoardState => press(withData(initialBoard(false), DATA), "x").state;
const text = (s: BoardState, cols: number, rows: number) => renderBoard(s, { cols, rows }, NONE);

describe("board render", () => {
  it("draws the C2 board at 80x24 and 120x36 with symbol + word status and no escape codes without colour", () => {
    for (const [cols, rows] of [[80, 24], [120, 36]] as const) {
      const lines = text(ready(), cols, rows);
      expect(lines).toHaveLength(rows);
      for (const l of lines) { expect(terminalWidth(l)).toBeLessThanOrEqual(cols); expect(l).not.toContain("\u001b"); }
      const all = lines.join("\n");
      expect(all).toContain("Braavolabs");
      expect(all).toContain("[Company]");
      expect(all).toContain("◆ 1 needs approval");
      expect(all).toContain("● 2 working");
      expect(all).toContain("■ 1 failed");
      expect(all).toContain("› ◆ Bülteni");
      expect(all).toContain("◆ Approval needed");
      expect(all).toContain("[o] Approve");
    }
  });

  it("marks every agent state with symbol and word", () => {
    const all = text(ready(), 100, 30).join("\n");
    expect(all).toContain("● Valar  working");
    expect(all).toContain("✓ Pazarlama  idle");
    expect(all).toContain("■ Muhasebe  failed");
    expect(all).toContain("○ Destek  paused");
  });

  it("uses tones (ANSI 256) and status colours with colour on, and a marker only without", () => {
    const all = renderBoard(ready(), { cols: 100, rows: 30 }, COLOR).join("\n");
    expect(all).toContain("48;5;235");
    expect(all).toContain("48;5;233");
    expect(all).toContain("38;5;146");
    expect(all).toContain("38;5;179");
    expect(all).not.toContain("› ◆");
    expect(renderBoard(ready(), { cols: 100, rows: 30 }, { color: true, light: true }).join("\n")).toContain("48;5;254");
  });

  it("has no divider line: the list pane is separated by tone and space", () => {
    expect(text(ready(), 100, 30).join("\n")).not.toMatch(/[│┃|─━]/);
  });

  it("shows agent, error, task and chat details and the offline banner", () => {
    const agentView = text(press(ready(), "j").state, 100, 30).join("\n");
    expect(agentView).toContain("Valar · role");
    expect(agentView).toContain("ANTHROPIC/claude-sonnet-5-5");
    expect(agentView).toContain("$2.50 / $5.00 · 50%");
    expect(text(press(ready(), "j", "j", "j", "j").state, 100, 30).join("\n")).toContain("Not set up yet. Run: braavo setup");
    const code = text(press(ready(), "\t", "j").state, 100, 30).join("\n");
    expect(code).toContain("TASKS · 2");
    expect(code).toContain("Hazır");
    expect(code).not.toContain("\u001b");
    let chat = press(ready(), "\u001b[Z").state;
    expect(wantedConversation(chat)).toBe("c1");
    chat = withMessages(chat, "c1", [{ role: "user", content: "hata var" }, { role: "assistant", content: "Düzelttim." }]);
    expect(wantedConversation(chat)).toBeNull();
    const chatText = text(chat, 100, 30).join("\n");
    expect(chatText).toContain("› hata var");
    expect(chatText).toContain("Düzelttim.");
    const off = text(withOffline(ready(), "daemon down"), 100, 30).join("\n");
    expect(off).toContain("○ No connection");
    expect(off).toContain("daemon down");
  });

  it("falls back to numbers when the header is too narrow, and to one pane below 60 columns", () => {
    const narrow = text(ready(), 50, 20);
    expect(narrow[0]).toContain("● 2");
    expect(narrow[0]).not.toContain("working");
    expect(narrow.join("\n")).toContain("APPROVALS · 1");
    expect(narrow.join("\n")).not.toContain("Approval needed");
    const detail = text(press(ready(), "\r").state, 50, 20).join("\n");
    expect(detail).toContain("Approval needed");
    expect(detail).not.toContain("APPROVALS");
    for (const l of narrow) expect(terminalWidth(l)).toBeLessThanOrEqual(50);
  });

  it("cleans control characters from daemon text", () => {
    const evil = { ...DATA, agents: [agent("a1", "Evil\u001b]0;x\u0007\u001b[2J", "idle")], approvals: [] };
    const all = renderBoard(withData(ready(), evil), { cols: 80, rows: 24 }, NONE).join("\n");
    expect(all).not.toContain("\u001b");
    expect(all).not.toContain("\u0007");
  });

  it("localizes (Turkish) and keeps the layout", () => {
    setLocale("tr");
    const all = text(ready(), 120, 30).join("\n");
    expect(all).toContain("[Şirket]");
    expect(all).toContain("◆ 1 onay bekliyor");
    expect(all).toContain("ONAYLAR · 1");
    expect(all).toContain("o onayla");
  });

  it("shows the splash first (helmet only wide enough, plain without colour) and the login hint", () => {
    const first = withData(initialBoard(false), DATA);
    const wide = renderBoard(first, { cols: 100, rows: 30 }, NONE).join("\n");
    expect(wide).toMatch(/[▀▄█]/);
    expect(wide).toContain("Braavolabs  ·  Valar and your AI company, in the terminal");
    expect(wide).toContain("Not logged in. Run: braavo login");
    expect(wide).not.toContain("\u001b");
    expect(renderBoard(first, { cols: 50, rows: 30 }, NONE).join("\n")).not.toMatch(/[▀▄█]/);
    const off = renderBoard(withOffline(initialBoard(true), "x"), { cols: 100, rows: 30 }, NONE).join("\n");
    expect(off).toContain("braavo daemon start");
    const hidden = { ...first, settings: { ...first.settings, logo: "hide" as const } };
    expect(renderBoard(hidden, { cols: 100, rows: 30 }, NONE).join("\n")).not.toMatch(/[▀▄█]/);
  });

  it("logged-in sessions leave the splash on their own after the first load", () => {
    expect(withData(initialBoard(true), DATA).splash).toBe(false);
    expect(withData(initialBoard(false), DATA).splash).toBe(true);
  });
});

describe("board keys", () => {
  it("never decides on the first press: o and r ask one line, Enter acts, anything else cancels", () => {
    const o = press(ready(), "o");
    expect(o.action).toBeUndefined();
    expect(o.state.confirm).toMatchObject({ kind: "approve", id: "ap1" });
    expect(text(o.state, 100, 30).join("\n")).toContain("◆ Approve: Bülteni 2.418 aboneye gönder?  [⏎] yes  [esc] cancel");
    expect(press(o.state, "\r").action).toEqual({ type: "approval", id: "ap1", decision: "allow" });
    expect(press(o.state, "\u001b").action).toBeUndefined();
    expect(press(o.state, "o").action).toBeUndefined();
    expect(press(o.state, "o").state.confirm).toBeNull();
    expect(press(ready(), "r", "\r").action).toEqual({ type: "approval", id: "ap1", decision: "reject" });
    expect(press(ready(), "r", "j", "\r").action).toBeUndefined();
  });

  it("o and r only work on an approval", () => {
    const onAgent = press(ready(), "j", "o");
    expect(onAgent.state.confirm).toBeNull();
    expect(onAgent.state.notice).toBe("Select an approval first.");
  });

  it("! asks first, then pauses every agent that is not paused", () => {
    const r = press(ready(), "!");
    expect(r.action).toBeUndefined();
    expect(text(r.state, 100, 30).join("\n")).toContain("Pause all agents?");
    expect(press(r.state, "\r").action).toEqual({ type: "pause-all", agentIds: ["a1", "a2", "a3", "a4"] });
    expect(press(r.state, "x").action).toBeUndefined();
  });

  it("does not invent commands: e and y say so, d needs files", () => {
    expect(press(ready(), "e")).toMatchObject({ action: undefined, state: { notice: "Not available in the CLI yet." } });
    expect(press(ready(), "y").action).toBeUndefined();
    expect(press(ready(), "j", "d").state.notice).toBe("No changes to show.");
    const changes = press(ready(), "d").state;
    expect(changes.overlay).toBe("changes");
    expect(text(changes, 80, 24).join("\n")).toContain("ui/lib/para.test.ts");
    expect(text(changes, 80, 24).join("\n")).toContain("does not send the line-by-line difference");
    expect(press(changes, "\u001b").state.overlay).toBeNull();
  });

  it("b reconnects, tab cycles tabs, ? opens the shortcuts, q and Ctrl-C quit", () => {
    expect(press(ready(), "b").action).toEqual({ type: "reconnect" });
    expect(press(ready(), "\t").state.tab).toBe("code");
    expect(press(ready(), "\t", "\t").state.tab).toBe("chat");
    expect(press(ready(), "\u001b[Z").state.tab).toBe("chat");
    const help = press(ready(), "?");
    expect(help.state.overlay).toBe("help");
    const h = text(help.state, 100, 30).join("\n");
    expect(h).toContain("Shortcuts");
    expect(h).toContain("[o] Approve");
    expect(h).toContain("NOT IN THE CLI YET");
    expect(press(help.state, "?").state.overlay).toBeNull();
    expect(press(ready(), "q").quit).toBe(true);
    expect(press(ready(), "\u0003").quit).toBe(true);
    expect(press(initialBoard(true), "q").quit).toBe(true);
    for (const l of text(help.state, 60, 30)) expect(terminalWidth(l)).toBeLessThanOrEqual(60);
  });

  it("writes to a chat (send) and to an agent (task), and keeps typing separate from shortcuts", () => {
    const chat = press(ready(), "\u001b[Z", "\r", "o", "k", "!");
    expect(chat.state.mode).toBe("write");
    expect(chat.state.input).toBe("ok!");
    expect(chat.state.confirm).toBeNull();
    expect(text(chat.state, 100, 30).join("\n")).toContain("› ok!▌");
    expect(press(chat.state, "\r").action).toEqual({ type: "send", conversationId: "c1", text: "ok!" });
    expect(press(chat.state, "\u007f", "\u001b").state.mode).toBe("keys");
    expect(press(ready(), "j", "\r", "g", "o", "\r").action).toEqual({ type: "task-add", agentId: "a1", title: "go" });
    expect(press(ready(), "j", "\r", "\r").action).toBeUndefined();
    expect(press(ready(), "j", "\r", "\u001b[31m").state.input).toBe("");
  });

  it("settings change the theme/colour/helmet for the session only", () => {
    const s = press(ready(), ",").state;
    expect(text(s, 80, 24).join("\n")).toContain("‹ System ›");
    const dark = press(s, "\u001b[C").state;
    expect(dark.settings.theme).toBe("dark");
    const light = press(dark, "\u001b[C").state;
    expect(light.settings.theme).toBe("light");
    expect(renderBoard(press(light, ",").state, { cols: 100, rows: 30 }, COLOR).join("\n")).toContain("48;5;254");
    const off = press(light, "j", "\u001b[C").state;
    expect(off.settings.color).toBe("off");
    expect(renderBoard(press(off, ",").state, { cols: 100, rows: 30 }, COLOR).join("\n")).not.toContain("\u001b");
    expect(press(s, "\u001b").state.overlay).toBeNull();
  });

  it("keeps the cursor inside a list that shrank and exposes the list model", () => {
    const s = press(ready(), "j", "j", "j", "j", "j").state;
    expect(s.cursor.company).toBe(5);
    const small = withData(s, { ...DATA, agents: DATA.agents.slice(0, 1) });
    expect(small.cursor.company).toBe(1);
    expect(selectedItem(small)?.kind).toBe("agent");
    expect(itemsFor(DATA, "chat")).toHaveLength(2);
    expect(listRows(DATA, "company").filter(r => "header" in r)).toEqual([{ header: "APPROVALS · 1" }, { header: "AGENTS · 5" }]);
    expect(counts(DATA)).toEqual({ working: 2, approval: 1, error: 1 });
  });
});

class In extends EventEmitter { raw: boolean[] = []; setRawMode(on: boolean) { this.raw.push(on); return this; } resume() { return this; } pause() { return this; } }
class Out extends EventEmitter { columns = 100; rows = 30; isTTY = true; written = ""; write(s: string) { this.written += s; return true; } }
class Proc extends EventEmitter { exit() {} }
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

describe("board driver", () => {
  it("loads, acts only on a confirmed approval, reloads, and restores the terminal on quit", async () => {
    const input = new In(); const output = new Out(); const proc = new Proc();
    const acted: BoardAction[] = []; let loads = 0;
    const run = runBoard({
      input: input as never, output: output as never, proc: proc as never, env: { TERM: "xterm-256color" }, loggedIn: true, pollMs: 60_000,
      load: async () => { loads += 1; return DATA; },
      loadMessages: async () => [{ role: "assistant", content: "hi" }],
      act: async a => { acted.push(a); return "Approved"; },
    });
    await tick();
    expect(output.written).toContain(ENTER_SCREEN);
    expect(output.written).toContain("Bülteni 2.418 aboneye gönder");
    input.emit("data", Buffer.from("o")); await tick();
    expect(acted).toEqual([]);
    input.emit("data", Buffer.from("\r")); await tick(30);
    expect(acted).toEqual([{ type: "approval", id: "ap1", decision: "allow" }]);
    expect(loads).toBeGreaterThanOrEqual(2);
    expect(output.written).toContain("Approved");
    input.emit("data", Buffer.from("q"));
    await run;
    expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
    expect(input.raw).toEqual([true, false]);
  });

  it("goes offline on a failed load without echoing escape codes, and still restores", async () => {
    const input = new In(); const output = new Out(); const proc = new Proc();
    const run = runBoard({
      input: input as never, output: output as never, proc: proc as never, env: { NO_COLOR: "1" }, loggedIn: false, pollMs: 60_000,
      load: async () => { throw new Error("The daemon is not running.\u001b[2J"); },
      loadMessages: async () => [], act: async () => "",
    });
    await tick();
    expect(output.written).toContain("braavo daemon start");
    expect(output.written).not.toContain("[2J");
    input.emit("data", Buffer.from("q")); await run;
    expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
  });

  it("loads the messages of the selected chat, and a crash (exit event) restores the terminal", async () => {
    const input = new In(); const output = new Out(); const proc = new Proc();
    const asked: string[] = [];
    const run = runBoard({
      input: input as never, output: output as never, proc: proc as never, env: {}, loggedIn: true, pollMs: 60_000,
      load: async () => DATA, loadMessages: async id => { asked.push(id); return [{ role: "assistant", content: "Merhaba" }]; }, act: async () => "",
    });
    await tick();
    input.emit("data", Buffer.from("\u001b[Z")); await tick(30);
    expect(asked).toEqual(["c1"]);
    expect(output.written).toContain("Merhaba");
    proc.emit("exit");
    expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
    const before = output.written;
    input.emit("data", Buffer.from("o")); output.emit("resize");
    expect(output.written).toBe(before);
    void run;
  });
});

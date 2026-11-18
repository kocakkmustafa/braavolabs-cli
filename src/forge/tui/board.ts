/**
 * C2 Pano: the full-screen board (tabs Chat / Company / Code, list left, detail right).
 *
 * `reduceBoard` turns one key into the next state plus at most one action; `renderBoard` turns a state and a
 * size into lines. Both are pure. Everything the daemon or a model wrote is cleaned of control characters
 * before it is drawn. Irreversible keys (approve, reject, stop all) never act on the first press: they ask
 * one line first and act only on Enter.
 */
import { getLocale, statusText, t } from "../locale";
import { wrapTerminalText } from "../terminal-text";
import type { TuiAgent, TuiTask } from "../company-tui";
import { SYMBOL, fitLine, kindWord, lineWidth, logoLines, paint, statusSpans, type Kind, type Line, type Span, type Theme } from "./theme";

export interface BoardApproval { id: string; title: string; tool: string; paths: string[]; created_at: string }
export interface BoardConversation { id: string; title: string; lastMessage: string | null; messageCount: number; updatedAt: string }
export interface BoardMessage { role: "user" | "assistant"; content: string }
export interface BoardData {
  company: { id: string; name: string; monthlyBudgetUsd: number | null; monthUsd: number } | null;
  agents: TuiAgent[]; tasks: TuiTask[]; approvals: BoardApproval[]; conversations: BoardConversation[];
}

export type Tab = "chat" | "company" | "code";
export const TABS: Tab[] = ["chat", "company", "code"];
export type Overlay = null | "help" | "settings" | "changes";
export interface Settings { theme: "auto" | "dark" | "light"; color: "auto" | "off"; logo: "show" | "hide" }
export type Confirm = { kind: "approve" | "reject"; id: string; label: string } | { kind: "stop-all"; label: string };

export type BoardAction =
  | { type: "approval"; id: string; decision: "allow" | "reject" }
  | { type: "pause-all"; agentIds: string[] }
  | { type: "send"; conversationId: string; text: string }
  | { type: "task-add"; agentId: string; title: string }
  | { type: "reconnect" };

export interface BoardState {
  data: BoardData | null;
  messages: BoardMessage[]; messagesFor: string | null;
  tab: Tab; cursor: Record<Tab, number>; detail: boolean;
  overlay: Overlay; settings: Settings; settingsRow: number; changesCursor: number;
  mode: "keys" | "write"; input: string; confirm: Confirm | null;
  online: boolean; notice: string;
  splash: boolean; loaded: boolean; loggedIn: boolean;
}

export const initialBoard = (loggedIn: boolean): BoardState => ({
  data: null, messages: [], messagesFor: null, tab: "company", cursor: { chat: 0, company: 0, code: 0 }, detail: false,
  overlay: null, settings: { theme: "auto", color: "auto", logo: "show" }, settingsRow: 0, changesCursor: 0,
  mode: "keys", input: "", confirm: null, online: true, notice: "", splash: true, loaded: false, loggedIn,
});

const KEY = { up: "\u001b[A", down: "\u001b[B", left: "\u001b[D", right: "\u001b[C", enter: "\r", esc: "\u001b", tab: "\t", shiftTab: "\u001b[Z", backspace: "\u007f", ctrlC: "\u0003" } as const;
const clean = (text: unknown): string => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const clamp = (i: number, n: number) => (n <= 0 ? 0 : Math.min(Math.max(i, 0), n - 1));

// ---- items -----------------------------------------------------------------------------------------------

export type Item =
  | { kind: "conversation"; conversation: BoardConversation }
  | { kind: "approval"; approval: BoardApproval }
  | { kind: "agent"; agent: TuiAgent }
  | { kind: "task"; task: TuiTask };
export type ListRow = { header: string } | { item: Item; index: number };

export function itemsFor(data: BoardData | null, tab: Tab): Item[] {
  if (!data) return [];
  if (tab === "chat") return data.conversations.map(conversation => ({ kind: "conversation" as const, conversation }));
  if (tab === "code") return data.tasks.map(task => ({ kind: "task" as const, task }));
  return [...data.approvals.map(approval => ({ kind: "approval" as const, approval })), ...data.agents.map(agent => ({ kind: "agent" as const, agent }))];
}
export const selectedItem = (s: BoardState): Item | undefined => itemsFor(s.data, s.tab)[s.cursor[s.tab]];
const upper = (text: string) => text.toLocaleUpperCase(getLocale());

export function listRows(data: BoardData | null, tab: Tab): ListRow[] {
  const items = itemsFor(data, tab);
  const rows: ListRow[] = [];
  const section = (title: string, predicate: (i: Item) => boolean) => {
    const own = items.map((item, index) => ({ item, index })).filter(({ item }) => predicate(item));
    if (own.length) rows.push({ header: `${upper(title)} · ${own.length}` }, ...own);
  };
  if (tab === "chat") section(t("Chats"), () => true);
  else if (tab === "code") section(t("Tasks"), () => true);
  else { section(t("Approvals"), i => i.kind === "approval"); section(t("Agents"), i => i.kind === "agent"); }
  return rows;
}

/** The conversation whose messages the detail pane needs next (null when none, or already loaded). */
export function wantedConversation(s: BoardState): string | null {
  const item = s.tab === "chat" ? selectedItem(s) : undefined;
  return item?.kind === "conversation" && item.conversation.id !== s.messagesFor ? item.conversation.id : null;
}

// ---- status mapping ---------------------------------------------------------------------------------------

export function agentKind(status: string): Kind {
  return status === "running" ? "working" : status === "error" ? "error" : status === "paused" ? "queued" : "done";
}
export function taskKind(status: string): Kind {
  return status === "RUNNING" ? "working" : status === "FAILED" ? "error" : status === "DONE" ? "done" : "queued";
}
const wordFor = (kind: Kind, raw: string) => (raw === "paused" || raw === "idle" || raw === "CANCELLED" || raw === "OPEN" || raw === "DONE" || raw === "RUNNING" || raw === "FAILED" ? statusText(raw) : kindWord(kind));
export function itemStatus(item: Item): { kind: Kind; word: string } | null {
  if (item.kind === "approval") return { kind: "approval", word: kindWord("approval") };
  if (item.kind === "agent") { const kind = agentKind(item.agent.status); return { kind, word: kind === "error" ? kindWord("error") : wordFor(kind, item.agent.status) }; }
  if (item.kind === "task") { const kind = taskKind(item.task.status); return { kind, word: wordFor(kind, item.task.status) }; }
  return null;
}
export function counts(data: BoardData | null): Record<"working" | "approval" | "error", number> {
  const agents = data?.agents ?? [];
  return { working: agents.filter(a => a.status === "running").length, approval: data?.approvals.length ?? 0, error: agents.filter(a => a.status === "error").length };
}

// ---- data in ----------------------------------------------------------------------------------------------

export function withData(state: BoardState, data: BoardData): BoardState {
  const cursor = {
    chat: clamp(state.cursor.chat, data.conversations.length),
    company: clamp(state.cursor.company, data.approvals.length + data.agents.length),
    code: clamp(state.cursor.code, data.tasks.length),
  };
  return { ...state, data, cursor, online: true, loaded: true, splash: state.splash && !(state.loggedIn) ? state.splash : false };
}
export const withMessages = (state: BoardState, id: string, messages: BoardMessage[]): BoardState => ({ ...state, messages, messagesFor: id });
export const withOffline = (state: BoardState, reason: string): BoardState => ({ ...state, online: false, loaded: true, notice: clean(reason).slice(0, 200) });

// ---- keys -------------------------------------------------------------------------------------------------

export function effectiveTheme(base: Theme, s: Settings): Theme {
  return { color: base.color && s.color !== "off", light: s.theme === "auto" ? base.light : s.theme === "light" };
}
const SETTING_ROWS = ["theme", "color", "logo"] as const;
const CYCLE = { theme: ["auto", "dark", "light"], color: ["auto", "off"], logo: ["show", "hide"] } as const;
function cycle(settings: Settings, row: (typeof SETTING_ROWS)[number], step: number): Settings {
  const values = CYCLE[row] as readonly string[];
  const next = values[(values.indexOf(settings[row]) + step + values.length) % values.length];
  return { ...settings, [row]: next } as Settings;
}

type Result = { state: BoardState; action?: BoardAction; quit?: boolean };
const notice = (state: BoardState, text: string): Result => ({ state: { ...state, notice: text } });

export function reduceBoard(state: BoardState, key: string): Result {
  if (key === KEY.ctrlC) return { state, quit: true };
  if (state.splash) return key === "q" ? { state, quit: true } : { state: { ...state, splash: false } };

  if (state.confirm) {
    const confirm = state.confirm;
    const next = { ...state, confirm: null, notice: "" };
    if (key !== KEY.enter) return { state: next };
    if (confirm.kind === "stop-all") return { state: { ...next, notice: t("Working…") }, action: { type: "pause-all", agentIds: (state.data?.agents ?? []).filter(a => a.status !== "paused").map(a => a.id) } };
    return { state: { ...next, notice: t("Working…") }, action: { type: "approval", id: confirm.id, decision: confirm.kind === "approve" ? "allow" : "reject" } };
  }

  if (state.mode === "write") {
    if (key === KEY.esc) return { state: { ...state, mode: "keys", input: "" } };
    if (key === KEY.backspace) return { state: { ...state, input: [...state.input].slice(0, -1).join("") } };
    if (key === KEY.enter) {
      const text = state.input.trim();
      const item = selectedItem(state);
      const base = { ...state, mode: "keys" as const, input: "" };
      if (!text) return { state: base };
      if (item?.kind === "conversation") return { state: { ...base, notice: t("Working…") }, action: { type: "send", conversationId: item.conversation.id, text: text.slice(0, 4000) } };
      if (item?.kind === "agent") return { state: { ...base, notice: t("Working…") }, action: { type: "task-add", agentId: item.agent.id, title: text.slice(0, 300) } };
      return { state: base };
    }
    if (/^[^\u0000-\u001f\u007f-\u009f]+$/.test(key)) return { state: { ...state, input: (state.input + key).slice(0, 4000) } };
    return { state };
  }

  if (state.overlay === "settings") {
    const row = SETTING_ROWS[state.settingsRow];
    if (key === KEY.esc || key === ",") return { state: { ...state, overlay: null } };
    if (key === KEY.up || key === "k") return { state: { ...state, settingsRow: clamp(state.settingsRow - 1, SETTING_ROWS.length) } };
    if (key === KEY.down || key === "j") return { state: { ...state, settingsRow: clamp(state.settingsRow + 1, SETTING_ROWS.length) } };
    if (key === KEY.left) return { state: { ...state, settings: cycle(state.settings, row, -1) } };
    if (key === KEY.right || key === KEY.enter) return { state: { ...state, settings: cycle(state.settings, row, 1) } };
    return { state };
  }
  if (state.overlay === "changes") {
    const item = selectedItem(state);
    const files = item?.kind === "approval" ? item.approval.paths : [];
    if (key === KEY.esc) return { state: { ...state, overlay: null } };
    if (key === KEY.up || key === "k") return { state: { ...state, changesCursor: clamp(state.changesCursor - 1, files.length) } };
    if (key === KEY.down || key === "j") return { state: { ...state, changesCursor: clamp(state.changesCursor + 1, files.length) } };
    return { state };
  }
  if (state.overlay === "help") return key === KEY.esc || key === "?" || key === "q" ? { state: { ...state, overlay: null } } : { state };

  const items = itemsFor(state.data, state.tab);
  const item = items[state.cursor[state.tab]];
  const move = (d: number): Result => ({ state: { ...state, cursor: { ...state.cursor, [state.tab]: clamp(state.cursor[state.tab] + d, items.length) }, notice: "" } });
  const switchTab = (d: number): Result => ({ state: { ...state, tab: TABS[(TABS.indexOf(state.tab) + d + TABS.length) % TABS.length], detail: false, notice: "" } });

  switch (key) {
    case "q": return { state, quit: true };
    case "?": return { state: { ...state, overlay: "help", notice: "" } };
    case ",": return { state: { ...state, overlay: "settings", notice: "" } };
    case KEY.tab: return switchTab(1);
    case KEY.shiftTab: return switchTab(-1);
    case KEY.esc: return { state: { ...state, detail: false, notice: "" } };
    case KEY.up: case "k": return move(-1);
    case KEY.down: case "j": return move(1);
    case KEY.enter:
      if (item?.kind === "conversation" || item?.kind === "agent") return { state: { ...state, mode: "write", input: "", notice: "", detail: state.detail } };
      return { state: { ...state, detail: !state.detail } };
    case "b": return { state: { ...state, notice: t("Reconnecting…") }, action: { type: "reconnect" } };
    case "o": case "r":
      if (item?.kind !== "approval") return notice(state, t("Select an approval first."));
      return { state: { ...state, notice: "", confirm: { kind: key === "o" ? "approve" : "reject", id: item.approval.id, label: clean(item.approval.title).slice(0, 80) } } };
    case "d":
      if (item?.kind === "approval" && item.approval.paths.length) return { state: { ...state, overlay: "changes", changesCursor: 0, notice: "" } };
      return notice(state, t("No changes to show."));
    case "e": case "y": return notice(state, t("Not available in the CLI yet."));
    case "!":
      if (!(state.data?.agents.length)) return notice(state, t("No agents yet."));
      return { state: { ...state, notice: "", confirm: { kind: "stop-all", label: "" } } };
  }
  return { state };
}

// ---- drawing ----------------------------------------------------------------------------------------------

export const tabTitle = (tab: Tab): string => (tab === "chat" ? t("Chat") : tab === "company" ? t("Company") : t("Code"));
const usd = (n: number) => `$${n.toFixed(2)}`;
export const keyCap = (k: string, theme: Theme, primary = false): Span => theme.color ? [` ${k} `, primary ? "key1" : "key"] : [`[${k}]`, "plain"];
const wrap = (text: string, width: number): string[] => (text ? wrapTerminalText(clean(text), Math.max(width, 8)).split("\n") : []);

function tabsLine(state: BoardState, cols: number, theme: Theme): Line {
  const tabs: Line = [];
  for (const tab of TABS) {
    const active = tab === state.tab;
    tabs.push(theme.color ? [` ${tabTitle(tab)} `, active ? "key1" : "t3"] : [active ? `[${tabTitle(tab)}]` : ` ${tabTitle(tab)} `, active ? "bold" : "t3"]);
  }
  const c = counts(state.data);
  const words = (kind: "working" | "approval" | "error"): Line => [[`${SYMBOL[kind]} ${c[kind]} `, kind], [kindWord(kind), kind], ["  "]];
  const nums = (kind: "working" | "approval" | "error"): Line => [[`${SYMBOL[kind]} ${c[kind]}  `, kind]];
  const head: Line = [["Braavolabs", "bold"], ["  "], ...tabs, ["  "]];
  const full: Line = [...head, ...words("working"), ...words("approval"), ...words("error")];
  if (lineWidth(full) <= cols) return full;
  return [...head, ...nums("working"), ...nums("approval"), ...nums("error")];
}

function spendLine(agent: TuiAgent): string {
  const meter = agent.budgetRatio === null ? "" : ` · ${Math.round(agent.budgetRatio * 100)}%`;
  return agent.budgetUsdMonthly === null ? `${usd(agent.month.usd)} · ${t("no budget")}` : `${usd(agent.month.usd)} / ${usd(agent.budgetUsdMonthly)}${meter}`;
}

function detailLines(state: BoardState, item: Item | undefined, width: number, height: number, theme: Theme): Line[] {
  const out: Line[] = [];
  if (!item) {
    out.push([[state.data ? (state.tab === "chat" ? t("No conversations yet.") : state.tab === "code" ? t("No tasks yet.") : t("No agents yet.")) : t("Working…"), "t3"]]);
    return out;
  }
  const keys = (...pairs: Array<[string, string, boolean?]>): Line => pairs.flatMap(([k, label, primary]) => [keyCap(k, theme, primary), [` ${label}  `, "t2"] as Span]);
  if (item.kind === "conversation") {
    const c = item.conversation;
    out.push([[clean(c.title) || "—", "bold"], [` · ${t("{0} messages", c.messageCount)}`, "t3"]], []);
    if (state.messagesFor !== c.id) out.push([[t("Working…"), "t3"]]);
    else if (!state.messages.length) out.push([[t("No messages yet."), "t3"]]);
    else {
      const body: Line[] = [];
      for (const m of state.messages) {
        const lines = wrap(m.content, width - 2);
        lines.forEach((text, i) => body.push(m.role === "user" ? [[i === 0 ? "› " : "  ", "t3"], [text, "t2"]] : [[text, "t1"]]));
        body.push([]);
      }
      out.push(...body.slice(-Math.max(height - 3, 1)));
    }
    return out;
  }
  if (item.kind === "approval") {
    const a = item.approval;
    out.push(statusSpans("approval", t("Approval needed")).map(([text, style]) => [text, style === "approval" ? "approval" : style] as Span), []);
    out.push(...wrap(a.title, width).map(text => [[text, "t1"]] as Line), []);
    out.push([[`${t("Tool")} `, "t4"], [clean(a.tool), "t2"]]);
    for (const p of a.paths.slice(0, Math.max(height - 9, 1))) out.push([[`${t("File")} `, "t4"], [clean(p), "t2"]]);
    out.push([], keys(["o", t("Approve"), true], ["r", t("Reject")], ...(a.paths.length ? [["d", t("Changes")] as [string, string]] : [])));
    return out;
  }
  if (item.kind === "agent") {
    const a = item.agent; const st = itemStatus(item)!;
    out.push([[clean(a.name), "bold"], [` · ${clean(a.role)}`, "t3"]], [], statusSpans(st.kind, st.word), []);
    out.push([[a.status === "error" ? t("Not set up yet. Run: braavo setup") : `${clean(a.provider)}/${clean(a.model)}`, "t2"]], [[spendLine(a), "t3"]]);
    const own = (state.data?.tasks ?? []).filter(tk => tk.assignee_agent_id === a.id).slice(0, Math.max(height - 9, 1));
    if (own.length) out.push([], [[upper(t("Tasks")), "t4"]]);
    for (const tk of own) { const k = taskKind(tk.status); out.push([[`${SYMBOL[k]} `, k], [clean(tk.title), "t2"]]); }
    return out;
  }
  const tk = item.task; const kind = taskKind(tk.status);
  const who = (state.data?.agents ?? []).find(a => a.id === tk.assignee_agent_id)?.name;
  out.push([[clean(tk.title), "bold"]], [], statusSpans(kind, wordFor(kind, tk.status)), [[who ? clean(who) : t("Unassigned"), "t3"]]);
  if (tk.note) out.push([[clean(tk.note), "t3"]]);
  if (tk.result) out.push([], ...wrap(tk.result, width).slice(0, Math.max(height - 6, 1)).map(text => [[text, "t2"]] as Line));
  return out;
}

function listLine(row: ListRow, selected: boolean, theme: Theme, width: number): { line: Line; tone: "listbg" | "selbg" } {
  if ("header" in row) return { line: fitLine([[` ${row.header}`, "t4"]], width, true), tone: "listbg" };
  const item = row.item; const st = itemStatus(item);
  const mark = selected && !theme.color ? "›" : " ";
  let line: Line;
  if (item.kind === "conversation") line = [[`${mark}`, "plain"], [` ${clean(item.conversation.title) || "—"}`, selected ? "t1" : "t2"]];
  else if (item.kind === "approval") line = [[mark], [` ${SYMBOL.approval} `, "approval"], [clean(item.approval.title), selected ? "t1" : "t2"]];
  else {
    const name = item.kind === "agent" ? item.agent.name : item.task.title;
    line = [[mark], [` ${SYMBOL[st!.kind]} `, st!.kind], [clean(name), selected ? "t1" : "t2"], [`  ${st!.word}`, "t3"]];
  }
  return { line: fitLine(line, width, true), tone: selected ? "selbg" : "listbg" };
}

function hintText(state: BoardState): string {
  const item = selectedItem(state);
  if (state.tab === "chat") return t("↑↓ chat · ⏎ write · tab switch · b reconnect · ? help · q quit");
  if (state.tab === "code") return t("↑↓ task · tab switch · b reconnect · ? help · q quit");
  if (item?.kind === "approval") return item.approval.paths.length
    ? t("o approve · r reject · d changes · ! stop all · tab switch · ? help")
    : t("o approve · r reject · ! stop all · tab switch · ? help");
  return t("↑↓ agent · ⏎ write a task · ! stop all · b reconnect · tab switch · ? help");
}

function placeholder(state: BoardState): string {
  const item = selectedItem(state);
  if (item?.kind === "conversation") return t("Write to {0}…", clean(item.conversation.title) || "—");
  if (item?.kind === "agent") return t("Task for {0}…", clean(item.agent.name));
  return "";
}

function bodyFrame(state: BoardState, size: { cols: number; rows: number }, theme: Theme, body: number): string[] {
  const { cols } = size;
  const rows = listRows(state.data, state.tab);
  const selIndex = state.cursor[state.tab];
  const narrow = cols < 60;
  const leftW = narrow ? cols : Math.min(Math.max(Math.floor(cols * 0.32), 24), 40);
  const rightW = narrow ? cols : cols - leftW - 2;
  const at = rows.findIndex(r => "item" in r && r.index === selIndex);
  const start = Math.min(Math.max(at - body + 2, 0), Math.max(rows.length - body, 0));
  const visible = rows.slice(start, start + body);
  const lines: string[] = [];
  const detail = detailLines(state, selectedItem(state), rightW, body, theme);
  for (let i = 0; i < body; i++) {
    if (narrow) {
      if (state.detail) lines.push(paint(fitLine(detail[i] ?? [], rightW, false), theme));
      else { const r = visible[i]; if (!r) lines.push(""); else { const { line, tone } = listLine(r, "item" in r && r.index === selIndex, theme, leftW); lines.push(paint(line, theme, tone)); } }
      continue;
    }
    const r = visible[i];
    const left = r ? listLine(r, "item" in r && r.index === selIndex, theme, leftW) : { line: fitLine([], leftW, true), tone: "listbg" as const };
    lines.push(`${paint(left.line, theme, left.tone)}  ${paint(fitLine(detail[i] ?? [], rightW, false), theme)}`);
  }
  return lines;
}

export function renderBoard(state: BoardState, size: { cols: number; rows: number }, base: Theme): string[] {
  const theme = effectiveTheme(base, state.settings);
  const { cols, rows } = size;
  if (state.splash) return renderSplash(state, size, theme);
  if (state.overlay === "help") return renderHelp(size, theme);
  if (state.overlay === "settings") return renderSettings(state, size, theme);
  if (state.overlay === "changes") return renderChanges(state, size, theme);

  const body = Math.max(rows - 5, 3);
  const out: string[] = [];
  out.push(paint(fitLine(tabsLine(state, cols, theme), cols, false), theme));
  out.push(state.online ? "" : paint(fitLine([[`${SYMBOL.queued} ${t("No connection · agents keep working in the cloud · b to reconnect")}`, "t2"]], cols, true, "card"), theme, "card"));
  out.push(...bodyFrame(state, size, theme, body));
  out.push(paint(fitLine([[state.notice, "t2"]], cols, false), theme));
  if (state.confirm) {
    const question = state.confirm.kind === "stop-all" ? t("Pause all agents?") : state.confirm.kind === "approve" ? t("Approve: {0}?", state.confirm.label) : t("Reject: {0}?", state.confirm.label);
    out.push(paint(fitLine([[`${SYMBOL.approval} `, "approval"], [question, "t1"], ["  "], keyCap("⏎", theme, true), [` ${t("yes")}  `, "t2"], keyCap("esc", theme), [` ${t("cancel")}`, "t2"]], cols, false), theme));
  } else if (state.mode === "write") out.push(paint(fitLine([["› ", "t3"], [state.input, "t1"], ["▌", "t3"]], cols, false), theme));
  else out.push(paint(fitLine([["› ", "t3"], [placeholder(state), "t4"]], cols, false), theme));
  out.push(paint(fitLine([[hintText(state), "t4"]], cols, false), theme));
  return out;
}

// ---- screens: CL1 splash, CL7 help, CL6 settings, CL4 changes ---------------------------------------------

export function renderSplash(state: BoardState, size: { cols: number; rows: number }, theme: Theme): string[] {
  const { cols } = size;
  const out: Line[] = [[]];
  if (cols >= 60 && state.settings.logo === "show") for (const row of logoLines()) out.push([["  "], ...row]);
  out.push([], [["  "], ["Braavolabs", "bold"], [`  ·  ${t("Valar and your AI company, in the terminal")}`, "t3"]], [], []);
  if (!state.loaded) out.push([["  "], [`${SYMBOL.queued} `, "queued"], [t("Connecting…"), "t3"]]);
  else if (!state.online) out.push([["  "], [`${SYMBOL.error} `, "error"], [t("The daemon is not running. Start it: braavo daemon start"), "t2"]]);
  if (state.loaded && !state.loggedIn) out.push([["  "], [`${SYMBOL.queued} `, "queued"], [t("Not logged in. Run: braavo login"), "t2"]]);
  out.push([], [["  "], keyCap("⏎", theme, true), [` ${t("Continue")}   `, "t2"], keyCap("q", theme), [` ${t("Quit")}`, "t2"]]);
  return out.map(l => paint(fitLine(l, cols, false), theme));
}

export function renderHelp(size: { cols: number; rows: number }, theme: Theme): string[] {
  const entry = (k: string, label: string): Line => [keyCap(k, theme), [` ${label}`, "t2"]];
  const nav: Line[] = [[[upper(t("Navigation")), "t4"]], entry("tab", t("Switch tab")), entry("↑↓", t("Move in the list")), entry("⏎", t("Open or write")), entry("esc", t("Back")), entry("b", t("Reconnect")), entry(",", t("Settings")), entry("q", t("Quit"))];
  const act: Line[] = [[[upper(t("Decisions")), "t4"]], entry("o", t("Approve")), entry("r", t("Reject")), entry("d", t("Changes")), entry("!", t("Stop all")), [], [[upper(t("Not in the CLI yet")), "t4"]], entry("e", t("Request changes")), entry("y", t("Get ready to publish"))];
  const wide = size.cols >= 76;
  const rows: Line[] = [[["Braavolabs", "bold"], [`  · ${t("Shortcuts")}`, "t3"]], []];
  if (wide) for (let i = 0; i < Math.max(nav.length, act.length); i++) rows.push([...fitLine(nav[i] ?? [], 38), ...(act[i] ?? [])]);
  else rows.push(...nav, [], ...act);
  rows.push([], [[`${t("From the command line")}: `, "t3"], ["braavo company show · braavo company approvals · braavo chat", "t2"]], [[t("Irreversible keys ask once more: ⏎ confirms, anything else cancels."), "t4"]]);
  return rows.map(l => paint(fitLine(l, size.cols, false), theme));
}

export function settingLabels(s: Settings): Record<(typeof SETTING_ROWS)[number], [string, string]> {
  return {
    theme: [t("Theme"), s.theme === "auto" ? t("System") : s.theme === "dark" ? t("Dark") : t("Light")],
    color: [t("Colour"), s.color === "auto" ? t("Automatic (follows NO_COLOR)") : t("Off: symbols and words only")],
    logo: [t("Helmet"), s.logo === "show" ? t("Show") : t("Hide")],
  };
}

export function renderSettings(state: BoardState, size: { cols: number; rows: number }, theme: Theme): string[] {
  const labels = settingLabels(state.settings);
  const rows: Line[] = [[[t("Settings"), "bold"], [`  · ${t("This session only")}`, "t3"]], [], [[upper(t("Appearance")), "t4"]]];
  SETTING_ROWS.forEach((row, i) => {
    const [name, value] = labels[row];
    const sel = i === state.settingsRow;
    rows.push([[sel ? (theme.color ? " " : "›") : " ", "plain"], [` ${name.padEnd(8)} `, sel ? "t1" : "t3"], [`‹ ${value} ›`, sel ? "t1" : "t2"]]);
  });
  rows.push([], [[upper(t("Account")), "t4"]], [["  "], [state.loggedIn ? t("Signed in") : t("Not logged in. Run: braavo login"), "t2"]], [["  "], [state.online ? t("Connected to the daemon") : t("No connection"), "t2"]]);
  rows.push([], [[t("↑↓ select · ←→ change · esc back"), "t4"]]);
  return rows.map(l => paint(fitLine(l, size.cols, false), theme));
}

export function renderChanges(state: BoardState, size: { cols: number; rows: number }, theme: Theme): string[] {
  const item = selectedItem(state);
  const a = item?.kind === "approval" ? item.approval : undefined;
  const rows: Line[] = [[[t("Changes"), "bold"], [`  · ${clean(a?.title ?? "")}`, "t3"]], [], [[upper(t("Files")), "t4"], [` · ${a?.paths.length ?? 0}`, "t4"]]];
  (a?.paths ?? []).forEach((p, i) => rows.push([[i === state.changesCursor ? (theme.color ? " " : "›") : " "], [` ${clean(p)}`, i === state.changesCursor ? "t1" : "t2"]]));
  rows.push([], [[t("The daemon does not send the line-by-line difference yet."), "t3"]], [], [keyCap("esc", theme), [` ${t("Back")}`, "t2"]]);
  return rows.map(l => paint(fitLine(l, size.cols, false), theme));
}

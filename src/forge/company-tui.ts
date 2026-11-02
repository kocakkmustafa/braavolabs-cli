/**
 * `braavo company tui` — the company panel in the terminal (plan 2.5, CLI side).
 *
 * Pure core + thin driver: `reduceKey` turns a key into the next state and at most
 * one daemon action, `renderTui` draws a state into lines, and `runCompanyTui`
 * owns raw mode, the alternate screen, polling and the daemon calls. Everything
 * the daemon or a model wrote is shown as plain text: control characters are
 * replaced before drawing, so a task result cannot move the cursor or retitle
 * the terminal.
 */
import { statusText, t } from "./locale";
import { fitTerminalLine } from "./terminal-text";

export interface TuiAgent {
  id: string; name: string; role: string; status: string; provider: string; model: string;
  budgetUsdMonthly: number | null; budgetRatio: number | null; month: { usd: number; runs: number };
}
export interface TuiTask { id: string; title: string; status: string; assignee_agent_id: string | null; note: string | null; result: string | null }
export interface TuiPanel {
  company: { id: string; name: string; monthlyBudgetUsd: number | null };
  agents: TuiAgent[];
  month: { usd: number; unpricedCalls?: number; budgetRatio: number | null };
}

export type TuiAction =
  | { type: "pause" | "resume"; agentId: string }
  | { type: "agent-budget"; agentId: string; usd: number | null }
  | { type: "company-budget"; usd: number | null }
  | { type: "task-add"; agentId: string; title: string }
  | { type: "task-run" | "task-cancel" | "task-reopen"; taskId: string }
  | { type: "refresh" };

type PromptKind = "task" | "agent-budget" | "company-budget";
export interface TuiState {
  panel: TuiPanel | null;
  tasks: TuiTask[];
  focus: "agents" | "tasks";
  agent: number;
  task: number;
  prompt: { kind: PromptKind; text: string } | null;
  message: string;
}

export const initialTuiState = (): TuiState => ({ panel: null, tasks: [], focus: "agents", agent: 0, task: 0, prompt: null, message: "" });

const KEY = { up: "\u001b[A", down: "\u001b[B", enter: "\r", esc: "\u001b", tab: "\t", backspace: "\u007f", ctrlC: "\u0003" } as const;

/** Daemon/model text → one safe line (no escape sequences, no line breaks). */
export function plain(text: unknown): string {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** "25", "$25.50", "25,5" → USD; empty → null (no budget); anything else → "invalid". */
export function parseUsd(text: string): number | null | "invalid" {
  const s = text.trim().replace(/^\$/, "").replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "invalid";
  const v = Number(s);
  return v <= 100_000 ? v : "invalid";
}

const clamp = (i: number, n: number) => (n <= 0 ? 0 : Math.min(Math.max(i, 0), n - 1));

/** Keep the cursor on the same list position after a reload shrinks a list. */
export function withData(state: TuiState, panel: TuiPanel, tasks: TuiTask[]): TuiState {
  return { ...state, panel, tasks, agent: clamp(state.agent, panel.agents.length), task: clamp(state.task, tasks.length) };
}

export function reduceKey(state: TuiState, key: string): { state: TuiState; action?: TuiAction; quit?: boolean } {
  if (key === KEY.ctrlC) return { state, quit: true };
  const agent = state.panel?.agents[state.agent];
  const task = state.tasks[state.task];

  if (state.prompt) {
    const prompt = state.prompt;
    if (key === KEY.esc) return { state: { ...state, prompt: null, message: "" } };
    if (key === KEY.backspace) return { state: { ...state, prompt: { ...prompt, text: [...prompt.text].slice(0, -1).join("") } } };
    if (key === KEY.enter) {
      if (prompt.kind === "task") {
        const title = prompt.text.trim();
        if (!title || !agent) return { state: { ...state, prompt: null } };
        return { state: { ...state, prompt: null, message: t("Working…") }, action: { type: "task-add", agentId: agent.id, title: title.slice(0, 300) } };
      }
      const usd = parseUsd(prompt.text);
      if (usd === "invalid") return { state: { ...state, message: t("Enter an amount like 25 or 25.50.") } };
      const next = { ...state, prompt: null, message: t("Working…") };
      if (prompt.kind === "company-budget") return { state: next, action: { type: "company-budget", usd } };
      return agent ? { state: next, action: { type: "agent-budget", agentId: agent.id, usd } } : { state: next };
    }
    // Printable input only (a pasted chunk is fine); control keys are ignored while typing.
    if (/^[^\u0000-\u001f\u007f-\u009f]+$/.test(key)) return { state: { ...state, prompt: { ...prompt, text: (prompt.text + key).slice(0, 300) } } };
    return { state };
  }

  const list = state.focus === "agents" ? state.panel?.agents.length ?? 0 : state.tasks.length;
  const move = (d: number) => state.focus === "agents" ? { ...state, agent: clamp(state.agent + d, list) } : { ...state, task: clamp(state.task + d, list) };
  switch (key) {
    case "q": return { state, quit: true };
    case KEY.up: case "k": return { state: move(-1) };
    case KEY.down: case "j": return { state: move(1) };
    case KEY.tab: return { state: { ...state, focus: state.focus === "agents" ? "tasks" : "agents" } };
    case "R": return { state: { ...state, message: "" }, action: { type: "refresh" } };
    case "B": return { state: { ...state, prompt: { kind: "company-budget", text: state.panel?.company.monthlyBudgetUsd?.toString() ?? "" }, message: "" } };
  }
  if (state.focus === "agents" && agent) {
    switch (key) {
      case "p":
        if (agent.status === "running") return { state };
        return { state: { ...state, message: t("Working…") }, action: { type: agent.status === "paused" ? "resume" : "pause", agentId: agent.id } };
      case "b": return { state: { ...state, prompt: { kind: "agent-budget", text: agent.budgetUsdMonthly?.toString() ?? "" }, message: "" } };
      case "t": return { state: { ...state, prompt: { kind: "task", text: "" }, message: "" } };
    }
  }
  if (state.focus === "tasks" && task) {
    switch (key) {
      case "r": if (task.status === "OPEN") return { state: { ...state, message: t("Working…") }, action: { type: "task-run", taskId: task.id } }; break;
      case "c": if (task.status === "OPEN") return { state: { ...state, message: t("Working…") }, action: { type: "task-cancel", taskId: task.id } }; break;
      case "o": if (["DONE", "FAILED", "CANCELLED"].includes(task.status)) return { state: { ...state, message: t("Working…") }, action: { type: "task-reopen", taskId: task.id } }; break;
    }
  }
  return { state };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
function meter(ratio: number | null, width = 10): string {
  if (ratio === null) return "";
  const filled = Math.round(Math.min(Math.max(ratio, 0), 1) * width);
  return ` [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}
const spend = (spent: number, budget: number | null, ratio: number | null) =>
  budget === null ? `${usd(spent)} · ${t("no budget")}` : `${usd(spent)} / ${usd(budget)}${meter(ratio)}`;

/** The whole screen as lines, each fitted to `cols`; the list under focus scrolls to keep its cursor visible. */
export function renderTui(state: TuiState, cols: number, rows: number): string[] {
  const fit = (s: string) => fitTerminalLine(s, Math.max(cols, 20));
  const p = state.panel;
  if (!p) return [fit(t("Working…"))];
  const head = [
    fit(`${plain(p.company.name)} · ${t("Budget: {0}", spend(p.month.usd, p.company.monthlyBudgetUsd, p.month.budgetRatio))}`),
    ...(p.month.unpricedCalls ? [fit(t("{0} calls on unpriced models (set prices in ~/.braavo/prices.json)", p.month.unpricedCalls))] : []),
    "",
  ];
  const names = new Map(p.agents.map(a => [a.id, a.name]));
  const agentLines = p.agents.map((a, i) => {
    const mark = state.focus === "agents" && i === state.agent ? ">" : " ";
    const model = a.status === "error" ? "— (braavo setup)" : `${a.provider}/${a.model}`;
    return fit(`${mark} ${plain(a.name)} · ${statusText(a.status)} · ${plain(model)} · ${spend(a.month.usd, a.budgetUsdMonthly, a.budgetRatio)}`);
  });
  const taskLines = state.tasks.map((tk, i) => {
    const mark = state.focus === "tasks" && i === state.task ? ">" : " ";
    const who = tk.assignee_agent_id ? plain(names.get(tk.assignee_agent_id) ?? "?") : t("Unassigned");
    return fit(`${mark} ${statusText(tk.status).padEnd(9)} ${plain(tk.title)} · ${who}${tk.note ? ` · ${plain(tk.note)}` : ""}`);
  });
  const selected = state.focus === "tasks" ? state.tasks[state.task] : undefined;
  const detail = selected?.result ? [fit(`  ${plain(selected.result)}`)] : [];

  const footer: string[] = [""];
  if (state.prompt) {
    const agent = p.agents[state.agent];
    const label = state.prompt.kind === "task" ? t("Task title for {0}:", plain(agent?.name ?? "?"))
      : state.prompt.kind === "agent-budget" ? t("Monthly budget for {0} in USD (empty = none):", plain(agent?.name ?? "?"))
        : t("Monthly budget for {0} in USD (empty = none):", plain(p.company.name));
    footer.push(fit(`${label} ${plain(state.prompt.text)}▌`), fit(t("Enter saves · Esc cancels")));
  } else {
    footer.push(fit(t("↑↓ move · Tab agents/tasks · p pause · b budget · B company budget · t task · r run · c cancel · o reopen · R refresh · q quit")));
  }
  if (state.message) footer.push(fit(plain(state.message)));

  // Split what is left between the two lists; the focused one keeps its cursor in view.
  const room = Math.max(rows - head.length - footer.length - 4 - detail.length, 4);
  const agentRoom = Math.max(Math.min(agentLines.length, Math.ceil(room / 2)), 1);
  const taskRoom = Math.max(room - agentRoom, 1);
  const windowed = (lines: string[], cursor: number, size: number) => {
    const start = Math.min(Math.max(cursor - size + 1, 0), Math.max(lines.length - size, 0));
    return lines.slice(start, start + size);
  };
  return [
    ...head,
    fit(t("Agents")),
    ...(agentLines.length ? windowed(agentLines, state.agent, agentRoom) : [fit(`  ${t("No agents yet.")}`)]),
    "",
    fit(t("Tasks")),
    ...(taskLines.length ? windowed(taskLines, state.task, taskRoom) : [fit(`  ${t("No tasks yet.")}`)]),
    ...detail,
    ...footer,
  ];
}

export interface TuiIo {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  load(): Promise<{ panel: TuiPanel; tasks: TuiTask[] }>;
  /** Performs one action; resolves to a short line to show, or throws with the daemon's message. */
  act(action: TuiAction): Promise<string>;
  pollMs?: number;
}

/** Raw mode + alternate screen until q / Ctrl-C; the terminal is restored on every exit path. */
export async function runCompanyTui(io: TuiIo): Promise<void> {
  const { input, output } = io;
  let state = initialTuiState();
  let closed = false;
  const draw = () => {
    if (closed) return;
    const lines = renderTui(state, output.columns ?? 80, output.rows ?? 24);
    output.write(`\u001b[H\u001b[2J${lines.join("\r\n")}`);
  };
  const reload = async () => {
    try { const { panel, tasks } = await io.load(); state = withData(state, panel, tasks); }
    catch (error) { state = { ...state, message: plain(error instanceof Error ? error.message : error).slice(0, 300) }; }
    draw();
  };

  output.write("\u001b[?1049h\u001b[?25l");
  input.setRawMode?.(true);
  input.resume();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const timer = setInterval(() => { if (!state.prompt) void reload(); }, io.pollMs ?? 3000);
  const restore = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    input.off("data", onData);
    output.off("resize", draw);
    input.setRawMode?.(false);
    input.pause();
    output.write("\u001b[?25h\u001b[?1049l");
    finish();
  };
  const onData = (chunk: Buffer) => {
    const r = reduceKey(state, chunk.toString("utf8"));
    state = r.state;
    if (r.quit) { restore(); return; }
    draw();
    if (!r.action) return;
    const action = r.action;
    void (async () => {
      if (action.type !== "refresh") {
        try { state = { ...state, message: plain(await io.act(action)) }; }
        catch (error) { state = { ...state, message: plain(error instanceof Error ? error.message : error).slice(0, 300) }; }
      }
      await reload();
    })();
  };
  input.on("data", onData);
  output.on("resize", draw);
  try {
    await reload();
    await done;
  } finally {
    restore();
  }
}

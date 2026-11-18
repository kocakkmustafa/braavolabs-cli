/**
 * Driver of the board: owns the terminal, polls the daemon and turns keys into the injected actions.
 * Daemon access (`load`, `loadMessages`, `act`) is injected, so tests need neither a TTY nor a daemon.
 */
import { t } from "../locale";
import { initialBoard, reduceBoard, renderBoard, withData, withMessages, withOffline, wantedConversation, type BoardAction, type BoardData, type BoardMessage, type BoardState } from "./board";
import { detectTheme, sanitize } from "./theme";
import { openTerminal, type TermInput, type TermOutput, type TermProcess } from "./term";

export interface BoardIo {
  input: TermInput;
  output: TermOutput & { isTTY?: boolean };
  proc?: TermProcess;
  env?: NodeJS.ProcessEnv;
  loggedIn: boolean;
  load(): Promise<BoardData>;
  loadMessages(conversationId: string): Promise<BoardMessage[]>;
  /** Performs one action; resolves to a short line to show, or throws with the daemon's message. */
  act(action: BoardAction): Promise<string>;
  pollMs?: number;
}

const oneLine = (e: unknown) => sanitize(e instanceof Error ? e.message : e).slice(0, 300);

export async function runBoard(io: BoardIo): Promise<void> {
  const base = detectTheme(io.env ?? process.env, io.output);
  const term = openTerminal({ input: io.input, output: io.output, proc: io.proc });
  let state: BoardState = initialBoard(io.loggedIn);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let loadingMessages: string | null = null;
  const draw = () => { if (!term.closed) term.draw(renderBoard(state, term.size(), base)); };
  const close = () => { clearInterval(timer); term.close(); finish(); };

  const pullMessages = async () => {
    const id = wantedConversation(state);
    if (!id || loadingMessages === id) return;
    loadingMessages = id;
    try { const messages = await io.loadMessages(id); state = withMessages(state, id, messages); }
    catch (error) { state = { ...state, notice: oneLine(error), messagesFor: id, messages: [] }; }
    loadingMessages = null;
    draw();
    void pullMessages();
  };
  const reload = async () => {
    try { state = withData(state, await io.load()); }
    catch (error) { state = withOffline(state, oneLine(error)); }
    draw();
    void pullMessages();
  };
  const timer = setInterval(() => { if (!term.closed) void reload(); }, io.pollMs ?? 3000);

  term.onResize(draw);
  term.onKey(key => {
    const r = reduceBoard(state, key);
    state = r.state;
    if (r.quit) { close(); return; }
    draw();
    void pullMessages();
    const action = r.action;
    if (!action) return;
    void (async () => {
      if (action.type !== "reconnect") {
        try { state = { ...state, notice: oneLine(await io.act(action)) }; }
        catch (error) { state = { ...state, notice: oneLine(error) }; }
      } else state = { ...state, notice: t("Reconnecting…") };
      await reload();
      if (action.type === "send" && state.messagesFor === action.conversationId) state = { ...state, messagesFor: null };
      draw();
      void pullMessages();
    })();
  });
  try {
    draw();
    await reload();
    await done;
  } finally {
    close();
  }
}

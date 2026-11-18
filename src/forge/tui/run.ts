/**
 * Driver of the board: owns the terminal, polls the daemon and turns keys into the injected actions.
 * Daemon access (`load`, `loadMessages`, `act`) is injected, so tests need neither a TTY nor a daemon.
 *
 * Every async result is merged into the CURRENT state after the await (`update`), never into a copy read before it:
 * a refresh that finishes late must not undo a key pressed while it was running (an open confirm line, typed text,
 * an overlay, the cursor).
 */
import { t } from "../locale";
import { initialBoard, reduceBoard, renderBoard, withData, withMessages, withOffline, wantedConversation, type BoardAction, type BoardData, type BoardMessage, type BoardState } from "./board";
import { detectTheme, sanitize } from "./theme";
import { openTerminal, type TermInput, type TermOutput, type TermProcess } from "./term";

export interface BoardIo {
  input: TermInput;
  output: TermOutput & { isTTY?: boolean };
  proc?: TermProcess;
  stderr?: (text: string) => void;
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
  const term = openTerminal({ input: io.input, output: io.output, proc: io.proc, stderr: io.stderr });
  let state: BoardState = initialBoard(io.loggedIn);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let loadingMessages: string | null = null;
  let reloading = false;
  const draw = () => { if (!term.closed) term.draw(renderBoard(state, term.size(), base)); };
  const update = (change: (current: BoardState) => BoardState) => { state = change(state); draw(); };
  const close = () => { clearInterval(timer); term.close(); finish(); };
  term.onClose(close);

  const pullMessages = async () => {
    const id = wantedConversation(state);
    if (!id || loadingMessages === id) return;
    loadingMessages = id;
    try { const messages = await io.loadMessages(id); update(s => withMessages(s, id, messages)); }
    catch (error) { const notice = oneLine(error); update(s => ({ ...s, notice, messagesFor: id, messages: [] })); }
    loadingMessages = null;
    void pullMessages();
  };
  const reload = async () => {
    if (reloading) return;
    reloading = true;
    try { const data = await io.load(); update(s => withData(s, data)); }
    catch (error) { const reason = oneLine(error); update(s => withOffline(s, reason)); }
    reloading = false;
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
      let line = t("Reconnecting…");
      if (action.type !== "reconnect") {
        try { line = oneLine(await io.act(action)); } catch (error) { line = oneLine(error); }
      }
      // `pending` stays set until the action has finished AND the data was reloaded; the confirm line is already gone.
      update(s => ({ ...s, notice: line, confirm: null }));
      reloading = false;
      await reload();
      update(s => ({ ...s, pending: false, messagesFor: action.type === "send" && s.messagesFor === action.conversationId ? null : s.messagesFor }));
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

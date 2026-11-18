/**
 * Thin terminal layer for the full-screen view: alternate screen, hidden cursor, raw keys, resize.
 *
 * No dependencies. The terminal is given back on every way out: `close()`, the process `exit` event, SIGINT /
 * SIGTERM / SIGHUP, an uncaught exception (restored first, THEN the error is printed, so it is not lost in the
 * alternate screen), a closed stdin and a broken stdout pipe. Ctrl-Z / SIGTSTP leaves the screen, stops the
 * process, and SIGCONT re-enters and asks for a redraw. Streams and the process are injected so tests run
 * without a TTY.
 */
export interface TermInput {
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: string, cb: (...args: any[]) => void): unknown;
  off(event: string, cb: (...args: any[]) => void): unknown;
}
export interface TermOutput {
  columns?: number;
  rows?: number;
  write(text: string): unknown;
  on(event: string, cb: (...args: any[]) => void): unknown;
  off(event: string, cb: (...args: any[]) => void): unknown;
}
export interface TermProcess {
  pid?: number;
  on(event: string, cb: (...args: any[]) => void): unknown;
  off(event: string, cb: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
  kill?(pid: number, signal: string): unknown;
}

export const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
export const LEAVE_SCREEN = "\u001b[0m\u001b[?25h\u001b[?1049l";

export interface Term {
  /** Real terminal size (a missing size reads as 80x24). */
  size(): { cols: number; rows: number };
  /** Draws one full screen: at most `rows` lines, a line per row, no trailing newline. */
  draw(lines: string[]): void;
  onKey(cb: (key: string) => void): void;
  /** Resize, or the screen came back after a suspend: draw again. */
  onResize(cb: () => void): void;
  /** The terminal was given back for a reason other than `close()` (signal, closed stdin, broken pipe). */
  onClose(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export function openTerminal(io: { input: TermInput; output: TermOutput; proc?: TermProcess; stderr?: (text: string) => void }): Term {
  const { input, output } = io;
  const proc = io.proc ?? (process as unknown as TermProcess);
  const stderr = io.stderr ?? ((text: string) => { process.stderr.write(text); });
  let closed = false;
  let suspended = false;
  let keyCb: ((key: string) => void) | undefined;
  let resizeCb: (() => void) | undefined;
  let closeCb: (() => void) | undefined;

  const enter = () => { output.write(ENTER_SCREEN); input.setRawMode?.(true); input.resume(); };
  const leave = () => {
    try { input.setRawMode?.(false); } catch { /* stream already gone */ }
    input.pause();
    try { output.write(LEAVE_SCREEN); } catch { /* broken pipe: nothing left to restore on */ }
  };
  const detach = () => {
    input.off("data", onData); input.off("end", onGone); input.off("close", onGone);
    output.off("resize", onResize); output.off("error", onGone);
    proc.off("exit", onExit); proc.off("SIGTERM", onTerm); proc.off("SIGHUP", onHup); proc.off("SIGINT", onInt);
    proc.off("SIGTSTP", onStop); proc.off("SIGCONT", onCont); proc.off("uncaughtException", onCrash);
  };
  const restore = () => { if (closed) return; closed = true; detach(); leave(); };
  const gone = () => { if (closed) return; restore(); closeCb?.(); };
  const suspend = () => {
    if (closed || suspended) return;
    suspended = true;
    leave();
    // The shell gets the terminal back while we are stopped; SIGCONT brings us back.
    proc.kill?.(proc.pid ?? process.pid, "SIGSTOP");
  };

  const onData = (chunk: Buffer) => {
    if (closed || suspended) return;
    const key = chunk.toString("utf8");
    if (key === "\u001a") { suspend(); return; } // Ctrl-Z arrives as a byte in raw mode
    keyCb?.(key);
  };
  const onResize = () => { if (!closed && !suspended) resizeCb?.(); };
  const onExit = () => restore();
  const onTerm = () => { gone(); proc.exit(143); };
  const onHup = () => { gone(); proc.exit(129); };
  const onInt = () => { gone(); proc.exit(130); };
  const onStop = () => suspend();
  const onCont = () => {
    if (closed || !suspended) return;
    suspended = false;
    enter();
    resizeCb?.();
  };
  const onGone = () => gone();
  const onCrash = (error: unknown) => {
    restore();
    stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    closeCb?.();
    proc.exit(1);
  };

  enter();
  input.on("data", onData);
  input.on("end", onGone);
  input.on("close", onGone);
  output.on("resize", onResize);
  output.on("error", onGone);
  proc.on("exit", onExit);
  proc.on("SIGTERM", onTerm);
  proc.on("SIGHUP", onHup);
  proc.on("SIGINT", onInt);
  proc.on("SIGTSTP", onStop);
  proc.on("SIGCONT", onCont);
  proc.on("uncaughtException", onCrash);

  return {
    size: () => ({ cols: output.columns || 80, rows: output.rows || 24 }),
    draw(lines) {
      if (closed || suspended) return;
      const rows = output.rows || 24;
      try { output.write(`\u001b[H${lines.slice(0, rows).map(l => `${l}\u001b[K`).join("\r\n")}\u001b[J`); } catch { gone(); }
    },
    onKey: cb => { keyCb = cb; },
    onResize: cb => { resizeCb = cb; },
    onClose: cb => { closeCb = cb; },
    close: restore,
    get closed() { return closed; },
  };
}

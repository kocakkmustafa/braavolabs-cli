/**
 * Thin terminal layer for the full-screen view: alternate screen, hidden cursor, raw keys, resize.
 *
 * No dependencies. The terminal is given back on every way out: `close()`, the process `exit` event
 * (a crash or process.exit), and SIGTERM / SIGHUP. Streams and the process are injected so tests run
 * without a TTY.
 */
export interface TermInput {
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  off(event: "data", cb: (chunk: Buffer) => void): unknown;
}
export interface TermOutput {
  columns?: number;
  rows?: number;
  write(text: string): unknown;
  on(event: "resize", cb: () => void): unknown;
  off(event: "resize", cb: () => void): unknown;
}
export interface TermProcess {
  on(event: string, cb: (...args: never[]) => void): unknown;
  off(event: string, cb: (...args: never[]) => void): unknown;
  exit(code?: number): unknown;
}

export const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l";
export const LEAVE_SCREEN = "\u001b[0m\u001b[?25h\u001b[?1049l";

export interface Term {
  size(): { cols: number; rows: number };
  /** Draws one full screen (a line per row, no trailing newline). */
  draw(lines: string[]): void;
  onKey(cb: (key: string) => void): void;
  onResize(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export function openTerminal(io: { input: TermInput; output: TermOutput; proc?: TermProcess }): Term {
  const { input, output } = io;
  const proc = io.proc ?? (process as unknown as TermProcess);
  let closed = false;
  let keyCb: ((key: string) => void) | undefined;
  let resizeCb: (() => void) | undefined;
  const onData = (chunk: Buffer) => { if (!closed) keyCb?.(chunk.toString("utf8")); };
  const onResize = () => { if (!closed) resizeCb?.(); };
  const restore = () => {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    output.off("resize", onResize);
    proc.off("exit", onExit);
    proc.off("SIGTERM", onTerm);
    proc.off("SIGHUP", onHup);
    try { input.setRawMode?.(false); } catch { /* stream already gone */ }
    input.pause();
    output.write(LEAVE_SCREEN);
  };
  // The `exit` event runs on a crash too; on a signal the terminal is restored before the process leaves.
  const onExit = () => restore();
  const onTerm = () => { restore(); proc.exit(143); };
  const onHup = () => { restore(); proc.exit(129); };

  output.write(ENTER_SCREEN);
  input.setRawMode?.(true);
  input.resume();
  input.on("data", onData);
  output.on("resize", onResize);
  proc.on("exit", onExit);
  proc.on("SIGTERM", onTerm);
  proc.on("SIGHUP", onHup);

  return {
    size: () => ({ cols: Math.max(output.columns ?? 80, 20), rows: Math.max(output.rows ?? 24, 6) }),
    draw(lines) {
      if (closed) return;
      output.write(`\u001b[H${lines.map(l => `${l}\u001b[K`).join("\r\n")}\u001b[J`);
    },
    onKey: cb => { keyCb = cb; },
    onResize: cb => { resizeCb = cb; },
    close: restore,
    get closed() { return closed; },
  };
}

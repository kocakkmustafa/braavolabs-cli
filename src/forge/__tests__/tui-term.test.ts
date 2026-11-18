import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { ENTER_SCREEN, LEAVE_SCREEN, openTerminal } from "../tui/term";

class In extends EventEmitter { raw: boolean[] = []; paused = false; setRawMode(on: boolean) { this.raw.push(on); return this; } resume() { this.paused = false; return this; } pause() { this.paused = true; return this; } }
class Out extends EventEmitter { columns = 100; rows = 30; written = ""; write(s: string) { this.written += s; return true; } }
class Proc extends EventEmitter { exited: number[] = []; exit(code?: number) { this.exited.push(code ?? 0); } }
const make = () => { const input = new In(); const output = new Out(); const proc = new Proc(); const term = openTerminal({ input: input as never, output: output as never, proc: proc as never }); return { input, output, proc, term }; };

describe("tui terminal layer", () => {
  it("enters the alternate screen with a hidden cursor and raw keys, and gives everything back on close", () => {
    const { input, output, proc, term } = make();
    expect(output.written).toBe(ENTER_SCREEN);
    expect(ENTER_SCREEN).toContain("\u001b[?1049h");
    expect(ENTER_SCREEN).toContain("\u001b[?25l");
    expect(input.raw).toEqual([true]);
    term.close();
    expect(output.written.endsWith(LEAVE_SCREEN)).toBe(true);
    expect(LEAVE_SCREEN).toContain("\u001b[?25h");
    expect(LEAVE_SCREEN).toContain("\u001b[?1049l");
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("resize")).toBe(0);
    expect(proc.listenerCount("exit")).toBe(0);
    const before = output.written;
    term.close(); term.draw(["x"]);
    expect(output.written).toBe(before);
  });

  it("restores on a process exit (crash) and on SIGTERM / SIGHUP", () => {
    const a = make(); a.proc.emit("exit");
    expect(a.output.written.endsWith(LEAVE_SCREEN)).toBe(true);
    const b = make(); b.proc.emit("SIGTERM");
    expect(b.output.written.endsWith(LEAVE_SCREEN)).toBe(true); expect(b.proc.exited).toEqual([143]);
    const c = make(); c.proc.emit("SIGHUP");
    expect(c.output.written.endsWith(LEAVE_SCREEN)).toBe(true); expect(c.proc.exited).toEqual([129]);
  });

  it("delivers keys and resizes, reports the size and draws whole screens", () => {
    const { input, output, term } = make();
    const keys: string[] = []; let resized = 0;
    term.onKey(k => keys.push(k)); term.onResize(() => { resized += 1; });
    input.emit("data", Buffer.from("o")); input.emit("data", Buffer.from("\u001b[A"));
    output.emit("resize");
    expect(keys).toEqual(["o", "\u001b[A"]); expect(resized).toBe(1);
    expect(term.size()).toEqual({ cols: 100, rows: 30 });
    output.columns = 5; output.rows = 2;
    expect(term.size()).toEqual({ cols: 5, rows: 2 });
    output.written = "";
    term.draw(["one", "two"]);
    expect(output.written).toBe("\u001b[Hone\u001b[K\r\ntwo\u001b[K\u001b[J");
    term.close();
    input.emit("data", Buffer.from("x")); output.emit("resize");
    expect(keys).toHaveLength(2); expect(resized).toBe(1);
  });
});

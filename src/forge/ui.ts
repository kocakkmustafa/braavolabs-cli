/**
 * forge terminal-noir UI — ANSI palette + braille spinner.
 *
 * Palette (256-color): arc-blue is primary AND success (there is deliberately
 * NO GREEN anywhere — a success ✓ is arc-blue, not green). ember drives
 * running/highlight state and the spinner; molten is error; steel is secondary.
 *
 * Colors auto-disable when stdout is not a TTY (piped output stays clean) or
 * when NO_COLOR / FORGE_NO_COLOR is set. `makeUi({ tty })` lets tests force
 * either mode. No font assumptions — braille spinner degrades to nothing off-TTY.
 */

// 256-color foreground codes. None of these are in the green band (2/10/22-48).
const ARC = 75; // arc-blue — primary + success
const EMBER = 208; // running / highlight / spinner
const MOLTEN = 203; // error
const STEEL = 245; // secondary / muted labels

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  update(label: string): void;
  stop(finalLine?: string): void;
}

export interface Ui {
  readonly enabled: boolean;
  primary(s: string): string;
  ember(s: string): string;
  molten(s: string): string;
  steel(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
  ok(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  /** Formatted failure line (does not exit — caller decides). */
  fail(msg: string): string;
  spinner(label: string): Spinner;
}

export interface UiOpts {
  /** Force color on/off; defaults to process.stdout.isTTY. */
  tty?: boolean;
}

export function makeUi(opts: UiOpts = {}): Ui {
  const tty = opts.tty ?? Boolean(process.stdout.isTTY);
  const enabled = tty && !process.env.NO_COLOR && !process.env.FORGE_NO_COLOR;

  const paint = (code: number, s: string): string => (enabled ? `\x1b[38;5;${code}m${s}\x1b[0m` : s);
  const attr = (code: number, s: string): string => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

  const primary = (s: string) => paint(ARC, s);
  const ember = (s: string) => paint(EMBER, s);
  const molten = (s: string) => paint(MOLTEN, s);
  const steel = (s: string) => paint(STEEL, s);
  const bold = (s: string) => attr(1, s);
  const dim = (s: string) => attr(2, s);

  return {
    enabled,
    primary,
    ember,
    molten,
    steel,
    bold,
    dim,
    ok: (msg) => console.log(`${primary("✓")} ${msg}`),
    info: (msg) => console.log(`${steel("·")} ${msg}`),
    warn: (msg) => console.error(`${ember("!")} ${msg}`),
    fail: (msg) => `${molten("✗")} ${msg}`,
    spinner: (label) => {
      if (!enabled) {
        // Off-TTY: no animation. Emit the final line (if any) once, plainly.
        return { update() {}, stop(final) { if (final) console.error(final); } };
      }
      let text = label;
      let i = 0;
      const timer = setInterval(() => {
        process.stderr.write(`\r${ember(BRAILLE[i++ % BRAILLE.length])} ${text}`);
      }, 80);
      // Don't wedge the event loop open if a caller forgets to stop().
      timer.unref?.();
      return {
        update(l: string) {
          text = l;
        },
        stop(final?: string) {
          clearInterval(timer);
          process.stderr.write("\r\x1b[K"); // clear the spinner line
          if (final) console.error(final);
        },
      };
    },
  };
}

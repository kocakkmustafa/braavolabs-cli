/**
 * braavo quiet workbench UI — restrained ANSI palette + face/edge coin.
 *
 * Palette (256-color): arc-blue is primary AND success (there is deliberately
 * NO GREEN anywhere — a success ✓ is arc-blue, not green). ember drives
 * running/highlight state and the spinner; molten is error; steel is secondary.
 *
 * Colors auto-disable off stdout TTY, in dumb terminals, or when either
 * NO_COLOR / BRAAVO_NO_COLOR exists. Motion additionally needs stderr TTY and
 * respects BRAAVO_REDUCED_MOTION. No frames or control codes enter pipes.
 */

// 256-color foreground codes. None of these are in the green band (2/10/22-48).
const ARC = 146; // muted blue — primary + success
const EMBER = 180; // warm bronze — running / highlight / coin
const MOLTEN = 210; // muted red — error
const STEEL = 246; // neutral gray — secondary / muted labels

const COIN = ["◉", "◐", "│", "◑", "◉"];

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
  /** Spinner stream capability, independent of stdout color support. */
  stderrTty?: boolean;
  /** Disable visual motion without removing semantic colors. */
  reducedMotion?: boolean;
}

export function makeUi(opts: UiOpts = {}): Ui {
  const tty = opts.tty ?? Boolean(process.stdout.isTTY);
  const enabled = tty && process.env.NO_COLOR === undefined
    && process.env.BRAAVO_NO_COLOR === undefined && process.env.TERM !== "dumb";
  const animate = enabled && (opts.stderrTty ?? Boolean(process.stderr.isTTY))
    && !opts.reducedMotion && !process.env.BRAAVO_REDUCED_MOTION;

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
      let stopped = false;
      if (!animate) {
        // No timer/control codes. Only the caller's explicit final line, once.
        return { update() {}, stop(final) {
          if (stopped) return;
          stopped = true;
          if (final) console.error(final);
        } };
      }
      let text = label;
      let i = 0;
      const timer = setInterval(() => {
        process.stderr.write(`\r\x1b[K${ember(COIN[i++ % COIN.length])} ${text}`);
      }, 180);
      // Don't wedge the event loop open if a caller forgets to stop().
      timer.unref?.();
      return {
        update(l: string) {
          if (stopped) return;
          text = l;
        },
        stop(final?: string) {
          if (stopped) return;
          stopped = true;
          clearInterval(timer);
          process.stderr.write("\r\x1b[K"); // clear the spinner line
          if (final) console.error(final);
        },
      };
    },
  };
}

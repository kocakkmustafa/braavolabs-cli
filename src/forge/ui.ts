/**
 * braavo quiet workbench UI — restrained ANSI palette + face/edge coin.
 *
 * Explicit light/dark palettes use blue for primary/success, bronze for
 * highlight, red for errors and gray for secondary text. Unknown system
 * backgrounds preserve the user's default foreground.
 *
 * Generated colors disable on redirected streams, in dumb terminals, or when
 * NO_COLOR / BRAAVO_NO_COLOR exists. Motion additionally needs stderr TTY and
 * respects BRAAVO_REDUCED_MOTION. Raw provider passthrough stays untouched.
 */

import { fitTerminalLine } from "./terminal-text";
export type TerminalTheme = "light" | "dark" | "system";
// Foregrounds only. The terminal background and user configuration are never changed.
const PALETTES = {
  dark: { primary: 146, highlight: 180, error: 210, secondary: 246 },
  light: { primary: 24, highlight: 94, error: 124, secondary: 239 },
};
function paletteFor(theme: string | undefined, background: string | undefined) {
  const explicit = theme?.trim().toLowerCase();
  if (explicit === "light" || explicit === "dark") return PALETTES[explicit];
  // COLORFGBG is an optional hint, not a probe or a claim about customized ANSI colors.
  if (background && background.trim() === background && /^(?:\d{1,2};){1,2}\d{1,2}$/.test(background)
      && background.split(";").every(value => Number(value) <= 15)) {
    const last = Number(background.split(";").at(-1));
    if (last === 0) return PALETTES.dark;
    if (last === 7 || last === 15) return PALETTES.light;
  }
  // Unknown system background: use the user's default foreground, not a guessed palette.
  return undefined;
}

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
  /** Width of the spinner stream; defaults to stderr.columns, then 80. */
  columns?: number;
  /** Session-only palette choice; defaults to BRAAVO_THEME, then system. */
  theme?: TerminalTheme;
}

export function makeUi(opts: UiOpts = {}): Ui {
  const palette = paletteFor(opts.theme ?? process.env.BRAAVO_THEME, process.env.COLORFGBG);
  const tty = opts.tty ?? Boolean(process.stdout.isTTY);
  const enabled = tty && process.env.NO_COLOR === undefined
    && process.env.BRAAVO_NO_COLOR === undefined && process.env.TERM !== "dumb";
  const stderrTty = opts.stderrTty ?? Boolean(process.stderr.isTTY);
  const stderrEnabled = stderrTty && process.env.NO_COLOR === undefined
    && process.env.BRAAVO_NO_COLOR === undefined && process.env.TERM !== "dumb";
  const animate = enabled && stderrEnabled
    && !opts.reducedMotion && !process.env.BRAAVO_REDUCED_MOTION;
  const colorCode = (code: number | undefined) => code === undefined ? "39" : `38;5;${code}`;
  const stderrPaint = (code: number | undefined, s: string): string => stderrEnabled ? `\x1b[${colorCode(code)}m${s}\x1b[0m` : s;

  const paint = (code: number | undefined, s: string): string => (enabled ? `\x1b[${colorCode(code)}m${s}\x1b[0m` : s);
  const attr = (code: number, s: string): string => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

  const primary = (s: string) => paint(palette?.primary, s);
  const ember = (s: string) => paint(palette?.highlight, s);
  const molten = (s: string) => paint(palette?.error, s);
  const steel = (s: string) => paint(palette?.secondary, s);
  const bold = (s: string) => attr(1, s);
  // Faint SGR has terminal-dependent contrast; use the readable secondary foreground instead.
  const dim = steel;

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
    warn: (msg) => console.error(`${stderrPaint(palette?.highlight, "!")} ${msg}`),
    // Failure strings are also used in stdout renderers: keep them plain if either stream is redirected.
    fail: (msg) => `${enabled && stderrEnabled ? stderrPaint(palette?.error, "✗") : "✗"} ${msg}`,
    spinner: (label) => {
      let stopped = false;
      if (!animate) {
        // A single plain status preserves loading information without animation.
        console.error(label);
        return { update() {}, stop(final) {
          if (stopped) return;
          stopped = true;
          if (final) console.error(final);
        } };
      }
      let text = label;
      let i = 0;
      const timer = setInterval(() => {
        const width = Math.max(1, (opts.columns ?? process.stderr.columns ?? 80) - 3);
        process.stderr.write(`\r\x1b[K${stderrPaint(palette?.highlight, COIN[i++ % COIN.length])} ${fitTerminalLine(text, width)}`);
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

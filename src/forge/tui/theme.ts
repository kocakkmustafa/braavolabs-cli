/**
 * Ilık Grafit for the terminal: ANSI 256 colours, status symbols and the S2 half-block helmet.
 *
 * Pure functions only. A screen is a list of lines; a line is a list of spans (text + style name).
 * Width is measured and cut on the plain text first and painted afterwards, so escape sequences
 * never count as cells and never get cut in half. Without colour (NO_COLOR, TERM=dumb, no TTY)
 * every state is still carried by symbol + word, and the selected row by a marker instead of a tone.
 */
import { t } from "../locale";
import { fitTerminalLine, terminalWidth } from "../terminal-text";

export type Kind = "working" | "approval" | "error" | "done" | "queued";
export type Style = "plain" | "bold" | "t1" | "t2" | "t3" | "t4" | Kind | "listbg" | "selbg" | "key" | "key1" | "card";
export type Span = readonly [text: string, style?: Style];
export type Line = Span[];

export interface Theme { color: boolean; light: boolean }

export const SYMBOL: Record<Kind, string> = { working: "●", approval: "◆", error: "■", done: "✓", queued: "○" };
/** Dark / light terminal: working 179/136 · approval 146/61 · error 174/131 · done 247/242 · queued 243/245. */
const KIND_CODE: Record<Kind, [number, number]> = { working: [179, 136], approval: [146, 61], error: [174, 131], done: [247, 242], queued: [243, 245] };
const TEXT_CODE: Record<"t1" | "t2" | "t3" | "t4", [number, number]> = { t1: [252, 235], t2: [250, 239], t3: [247, 242], t4: [244, 245] };
/** List tone #171615 → 233 and selected #24221F → 235 (dark); #EFECE7 → 255 and #E2DED8 → 254 (light). */
const LIST_BG: [number, number] = [233, 255];
const SEL_BG: [number, number] = [235, 254];
const CARD_BG: [number, number] = [234, 254];
const KEY_BG: [number, number] = [236, 253];

export const kindWord = (kind: Kind): string =>
  kind === "working" ? t("working") : kind === "approval" ? t("needs approval") : kind === "error" ? t("failed") : kind === "done" ? t("done") : t("queued");

/** Colour is off for NO_COLOR / BRAAVO_NO_COLOR / TERM=dumb / non-TTY; the terminal is light only on a clear hint. */
export function detectTheme(env: NodeJS.ProcessEnv, stream: { isTTY?: boolean }): Theme {
  const color = Boolean(stream.isTTY) && env.NO_COLOR === undefined && env.BRAAVO_NO_COLOR === undefined && env.TERM !== "dumb";
  const wanted = env.BRAAVO_THEME?.trim().toLowerCase();
  if (wanted === "light" || wanted === "dark") return { color, light: wanted === "light" };
  // COLORFGBG ("fg;bg") is an optional hint; an unreadable value means dark.
  const hint = env.COLORFGBG;
  if (hint && /^(?:\d{1,2};){1,2}\d{1,2}$/.test(hint)) {
    const bg = Number(hint.split(";").at(-1));
    if (bg === 7 || bg === 15) return { color, light: true };
  }
  return { color, light: false };
}

const sgr = (code: string, text: string) => `\u001b[${code}m${text}\u001b[0m`;
/** SGR parameters of one style ("" for none). */
function codesFor(style: Style | undefined, theme: Theme): string {
  if (!style || style === "plain") return "";
  const i = theme.light ? 1 : 0;
  switch (style) {
    case "bold": return "1";
    case "t1": case "t2": case "t3": case "t4": return `38;5;${TEXT_CODE[style][i]}`;
    case "working": case "approval": case "error": case "done": case "queued": return `38;5;${KIND_CODE[style][i]}`;
    case "listbg": return `48;5;${LIST_BG[i]}`;
    case "selbg": return `48;5;${SEL_BG[i]}`;
    case "card": return `48;5;${CARD_BG[i]}`;
    case "key": return `48;5;${KEY_BG[i]};38;5;${TEXT_CODE.t1[i]}`;
    case "key1": return `1;48;5;${TEXT_CODE.t1[i]};38;5;${theme.light ? 255 : 233}`;
  }
  return "";
}
/** One span → text with its escape codes; `tone` puts a background behind it without being reset by the text style. */
export function paintSpan(text: string, style: Style | undefined, theme: Theme, tone?: "listbg" | "selbg" | "card"): string {
  if (!theme.color || !text) return text;
  const codes = [tone ? codesFor(tone, theme) : "", codesFor(style, theme)].filter(Boolean).join(";");
  return codes ? sgr(codes, text) : text;
}

export function paint(line: Line, theme: Theme, tone?: "listbg" | "selbg" | "card"): string {
  return line.map(([text, style]) => paintSpan(text, style, theme, tone)).join("");
}

export const plainText = (line: Line): string => line.map(([text]) => text).join("");
export const lineWidth = (line: Line): number => line.reduce((n, [text]) => n + terminalWidth(text), 0);

/**
 * Outside text (daemon, models, tools) → one safe line: C0/C1 controls and Unicode format characters
 * (bidi overrides/isolates, zero-width, BOM, Arabic letter mark, Mongolian vowel separator) become spaces or vanish,
 * so a title cannot be reordered or hidden on screen.
 */
export const sanitize = (text: unknown): string =>
  String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/[\p{Cf}\u180e\u2028\u2029]/gu, "");
/**
 * Like `sanitize` but for multi-line text (chat, task results): line breaks and tabs stay (tab = two spaces),
 * ESC/CSI/OSC introducers, \r, other controls and format characters are removed.
 */
export const sanitizeText = (text: unknown): string =>
  String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "").replace(/[\p{Cf}\u180e\u2028\u2029]/gu, "");
/** Hard-wrap multi-line text to `width` cells, keeping blank lines and indentation (code blocks stay readable). */
export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(width, 4);
  const out: string[] = [];
  for (const raw of sanitizeText(text).split("\n")) {
    let line = "";
    for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(raw)) {
      if (line && terminalWidth(line + segment) > w) { out.push(line); line = ""; }
      line += segment;
    }
    out.push(line);
  }
  return out;
}
/** `sanitize`, then cut to `max` characters with a visible "…" when something was dropped. */
export function shorten(text: unknown, max: number): string {
  const clean = sanitize(text);
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/** Cut a line to `width` cells (ellipsis on the cut) and pad it with spaces to exactly `width`; control characters are removed. */
export function fitLine(line: Line, width: number, pad = true, padStyle?: Style): Line {
  const clean = line.map(([text, style]) => [sanitize(text), style] as Span);
  const total = lineWidth(clean);
  let out: Line;
  if (total <= width) out = clean;
  else {
    out = []; let used = 0;
    for (const [text, style] of clean) {
      const room = width - used;
      if (room <= 0) break;
      const w = terminalWidth(text);
      if (w <= room) { out.push([text, style]); used += w; continue; }
      // The last piece that does not fit is cut with an ellipsis (cells to spare: 1 for the ellipsis).
      const cut = fitTerminalLine(text, room);
      out.push([cut, style]); used += terminalWidth(cut);
      break;
    }
  }
  const missing = width - lineWidth(out);
  return pad && missing > 0 ? [...out, [" ".repeat(missing), padStyle]] : out;
}

export function statusSpans(kind: Kind, word: string): Line {
  return [[`${SYMBOL[kind]} `, kind], [word, kind]];
}

// S2: half-block helmet (▀▄█), one colour. Each cell of the grid is a "pixel"; two rows share one character row.
const GRID = [
  ".....#####.....", "...#########...", "..###########..", ".#############.", ".#############.", ".#...........#.",
  ".#############.", ".##.###.###.##.", ".##.###.###.##.", ".##.###.###.##.", ".#############.", "...............",
  "..ccccccccccc..", "...............",
];

/** The helmet as lines: full body in t1, the collar (soft) in t4. Plain characters only when colour is off. */
export function logoLines(): Line[] {
  const out: Line[] = [];
  for (let r = 0; r < GRID.length; r += 2) {
    const line: Span[] = [];
    for (let x = 0; x < GRID[0].length; x++) {
      const top = GRID[r][x], bottom = GRID[r + 1][x];
      const ch = top !== "." && bottom !== "." ? "█" : top !== "." ? "▀" : bottom !== "." ? "▄" : " ";
      line.push([ch, ch === " " ? "plain" : top === "c" || bottom === "c" ? "t4" : "t1"]);
    }
    out.push(line);
  }
  return out;
}
export const LOGO_WIDTH = GRID[0].length;

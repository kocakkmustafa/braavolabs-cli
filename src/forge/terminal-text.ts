/** Approximate terminal cells, not a font/render acceptance test. Never split graphemes. */
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function cells(cluster: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(cluster)) return 0;
  return /[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u2329-\u232a\u2e80-\ua4cf\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(cluster) ? 2 : 1;
}
export function terminalWidth(text: string): number {
  return [...segmenter.segment(text)].reduce((total, part) => total + cells(part.segment), 0);
}
export function fitTerminalLine(text: string, width: number): string {
  const plain = text.replace(/[\r\n\t]/g, " ");
  if (terminalWidth(plain) <= width) return plain;
  let result = "", used = 0;
  for (const { segment } of segmenter.segment(plain)) {
    const size = cells(segment); if (used + size > Math.max(0, width - 1)) break;
    result += segment; used += size;
  }
  return width > 0 ? `${result}…` : "";
}
/** Help prose only: command syntax and provider text never pass through this wrapper. */
export function wrapTerminalText(text: string, width: number): string {
  if (!Number.isFinite(width) || width < 4) return text;
  const lines: string[] = []; let line = "";
  for (const word of text.split(/\s+/u)) {
    if (line && terminalWidth(`${line} ${word}`) > width) { lines.push(line); line = ""; }
    if (terminalWidth(word) <= width) { line += `${line ? " " : ""}${word}`; continue; }
    for (const { segment } of segmenter.segment(word)) {
      if (terminalWidth(line + segment) > width && line) { lines.push(line); line = ""; }
      line += segment;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

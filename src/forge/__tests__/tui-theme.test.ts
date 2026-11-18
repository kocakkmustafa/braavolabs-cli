import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { catalogue, setLocale } from "../locale";
import { LOGO_WIDTH, SYMBOL, detectTheme, fitLine, kindWord, lineWidth, logoLines, paint, paintSpan, plainText, statusSpans, type Kind } from "../tui/theme";

afterEach(() => setLocale("en"));
const tty = { isTTY: true };
const COLOR = { color: true, light: false };
const LIGHT = { color: true, light: true };
const NONE = { color: false, light: false };
const kinds: Kind[] = ["working", "approval", "error", "done", "queued"];

describe("tui theme detection", () => {
  it("turns colour off for NO_COLOR, BRAAVO_NO_COLOR, TERM=dumb and non-TTY streams", () => {
    expect(detectTheme({}, tty).color).toBe(true);
    expect(detectTheme({ NO_COLOR: "1" }, tty).color).toBe(false);
    expect(detectTheme({ NO_COLOR: "" }, tty).color).toBe(false);
    expect(detectTheme({ BRAAVO_NO_COLOR: "1" }, tty).color).toBe(false);
    expect(detectTheme({ TERM: "dumb" }, tty).color).toBe(false);
    expect(detectTheme({}, { isTTY: false }).color).toBe(false);
    expect(detectTheme({}, {}).color).toBe(false);
  });

  it("picks the light palette only on a clear hint and falls back to dark", () => {
    expect(detectTheme({ COLORFGBG: "0;15" }, tty).light).toBe(true);
    expect(detectTheme({ COLORFGBG: "0;7" }, tty).light).toBe(true);
    expect(detectTheme({ COLORFGBG: "15;0" }, tty).light).toBe(false);
    expect(detectTheme({ COLORFGBG: "garbage" }, tty).light).toBe(false);
    expect(detectTheme({}, tty).light).toBe(false);
    expect(detectTheme({ BRAAVO_THEME: "light" }, tty).light).toBe(true);
    expect(detectTheme({ BRAAVO_THEME: "dark", COLORFGBG: "0;15" }, tty).light).toBe(false);
  });
});

describe("tui status colours", () => {
  it("uses the approved ANSI 256 codes on dark and light terminals", () => {
    const dark = { working: 179, approval: 146, error: 174, done: 247, queued: 243 };
    const light = { working: 136, approval: 61, error: 131, done: 242, queued: 245 };
    for (const k of kinds) {
      expect(paintSpan("x", k, COLOR)).toBe(`\u001b[38;5;${dark[k]}mx\u001b[0m`);
      expect(paintSpan("x", k, LIGHT)).toBe(`\u001b[38;5;${light[k]}mx\u001b[0m`);
    }
  });

  it("paints list and selected tones as ANSI 256 backgrounds without losing them under text styles", () => {
    expect(paintSpan("row", "t1", COLOR, "listbg")).toBe("\u001b[48;5;233;38;5;252mrow\u001b[0m");
    expect(paintSpan("row", "t1", COLOR, "selbg")).toContain("48;5;235");
    expect(paintSpan("row", "t1", LIGHT, "listbg")).toContain("48;5;255");
  });

  it("is plain text with symbol and word when colour is off", () => {
    for (const k of kinds) {
      const text = plainText(statusSpans(k, kindWord(k)));
      expect(text).toBe(`${SYMBOL[k]} ${kindWord(k)}`);
      expect(paint(statusSpans(k, kindWord(k)), NONE)).toBe(text);
      expect(text).not.toContain("\u001b");
    }
    expect(SYMBOL).toEqual({ working: "●", approval: "◆", error: "■", done: "✓", queued: "○" });
  });

  it("localizes the status words", () => {
    setLocale("tr");
    expect(kinds.map(kindWord)).toEqual(["çalışıyor", "onay bekliyor", "hata", "bitti", "sırada"]);
  });
});

describe("tui line fitting", () => {
  it("measures the plain text, cuts with an ellipsis and pads to the exact width", () => {
    const line = [["Braavolabs", "bold"], ["  hello world", "t3"]] as const;
    expect(lineWidth([...line])).toBe(23);
    const cut = fitLine([...line], 14);
    expect(lineWidth(cut)).toBe(14);
    expect(plainText(cut)).toBe("Braavolabs  h…");
    expect(plainText(fitLine([["ab"]], 6))).toBe("ab    ");
    expect(plainText(fitLine([["ab"]], 6, false))).toBe("ab");
    expect(plainText(fitLine([["abc"], ["def"]], 0))).toBe("");
  });

  it("strips control characters so model text cannot move the cursor", () => {
    const out = plainText(fitLine([["a\u001b[2Jb\u0007c"]], 10));
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("tui helmet (S2)", () => {
  it("draws seven rows of half blocks, one colour plus a soft collar", () => {
    const rows = logoLines();
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(lineWidth(row)).toBe(LOGO_WIDTH);
      expect(plainText(row)).toMatch(/^[▀▄█ ]+$/);
    }
    expect(plainText(rows[0])).toBe("   ▄▄█████▄▄   ");
    const styles = new Set(rows.flat().map(([, s]) => s));
    expect(styles.has("t1")).toBe(true);
    expect(styles.has("t4")).toBe(true);
    expect(paint(rows[0], NONE)).toBe(plainText(rows[0]));
  });
});

describe("tui locale keys", () => {
  it("every authored t(...) in src/forge/tui is in the catalogue of all locales", () => {
    const missing: string[] = [];
    for (const file of readdirSync("src/forge/tui").filter(f => f.endsWith(".ts"))) {
      const src = readFileSync(`src/forge/tui/${file}`, "utf8");
      for (const m of src.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*")/g)) {
        const key = JSON.parse(m[1]) as string;
        for (const locale of Object.keys(catalogue)) if (!(key in (catalogue as Record<string, Record<string, string>>)[locale])) missing.push(`${file}:${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

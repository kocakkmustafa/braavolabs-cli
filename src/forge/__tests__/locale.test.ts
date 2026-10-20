import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogue, LOCALES, setLocale, resolveLocale, localeArgs, t, numberText, moneyText, dateText, statusText, dayText, imageCountText } from "../locale";
import { fitTerminalLine, terminalWidth, wrapTerminalText } from "../terminal-text";
import { COMMAND_HELP, renderHelp } from "../help";
import { makeUi } from "../ui";
import { emit, requireConfirmation } from "../output";
import { renderCompareLines } from "../../braavo";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { makeChildRef, makeSpawnBridgeHandlers } from "../spawn";

afterEach(() => { setLocale("en"); vi.restoreAllMocks(); });
const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort();

describe("fourteen explicit CLI locales", () => {
  it("has complete keys and interpolation slots in every locale", () => {
    const english = Object.keys(catalogue.en).sort();
    expect(LOCALES).toEqual(["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"]);
    for (const locale of LOCALES) {
      expect(Object.keys(catalogue[locale]).sort()).toEqual(english);
      for (const key of english) {
        expect(catalogue[locale][key].trim(), `${locale}:${key}`).not.toBe("");
        expect(placeholders(catalogue[locale][key]), `${locale}:${key}`).toEqual(placeholders(key));
      }
    }
  });

  it("documents all 37 actual commands without translating their syntax", () => {
    expect(COMMAND_HELP).toHaveLength(37);
    for (const locale of LOCALES) {
      setLocale(locale); const help = renderHelp(makeUi({ tty: false }));
      for (const [_command, syntax, description] of COMMAND_HELP) {
        expect(help).toContain(syntax); expect(help).toContain(catalogue[locale][description]);
      }
      expect(help).toContain("es-419|pt-BR|de|fr|ja|ar"); expect(help).not.toContain("�");
    }
  });

  it("binds authored static translation calls to catalogue keys", () => {
    const files = ["src/braavo.ts", ...readdirSync("src/forge").filter(file => file.endsWith(".ts")).map(file => `src/forge/${file}`)];
    const missing: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(source) === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          if (!(node.arguments[0].text in catalogue.en)) missing.push(`${file}: ${node.arguments[0].text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(missing).toEqual([]);
  });

  it("uses explicit flags before environment with a deterministic English fallback", () => {
    expect(localeArgs(["help", "--lang", "ja"], "tr")).toMatchObject({ argv: ["help"], locale: "ja", missing: false });
    expect(localeArgs(["--lang=es-419", "help"], "ar").locale).toBe("es-419");
    expect(localeArgs(["help"], "pt_BR").locale).toBe("pt-BR");
    expect(resolveLocale("unknown")).toBe("en");
    expect(localeArgs(["help", "--lang"], "tr").missing).toBe(true);
    expect(localeArgs(["help"], "bad\n\x1b[31m").unsupported).toBe("bad??[31m");
  });

  it("does not consume vendor or MCP child arguments", () => {
    expect(localeArgs(["--lang", "ja", "spawn", "codex", "--lang", "vendor-language"]).argv)
      .toEqual(["spawn", "codex", "--lang", "vendor-language"]);
    expect(localeArgs(["mcp", "add", "server", "--", "program", "--lang", "child-language"], "tr").argv)
      .toEqual(["mcp", "add", "server", "--", "program", "--lang", "child-language"]);
  });

  it("accepts platform aliases and extensions without conflating Traditional Chinese", () => {
    for (const [alias, expected] of [["IT_it", "it"], ["id-ID", "id"], ["in-ID", "id"], ["ko_KR", "ko"], ["pl-PL", "pl"], ["hi-Deva-IN", "hi"], ["zh", "zh-Hans"], ["zh-CN", "zh-Hans"], ["zh-SG", "zh-Hans"], ["zh-Hans-CN-u-nu-latn", "zh-Hans"], ["ar-EG-u-nu-latn", "ar"], ["en-GB", "en"], ["es-MX", "es-419"]]) {
      expect(localeArgs(["help"], alias), alias).toMatchObject({ locale: expected, unsupported: undefined });
    }
    for (const alias of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-CN", "pt-PT", "es-ES", "not-a-locale", "hi--IN"]) {
      expect(localeArgs(["help"], alias), alias).toMatchObject({ locale: "en", unsupported: alias });
    }
  });

  it("isolates Arabic interpolated commands without changing their content", () => {
    setLocale("ar"); const command = "braavo stop run-123 --yes";
    expect(t("Usage: {0}", command)).toContain(`\u2068${command}\u2069`);
    setLocale("hi"); expect(t("Usage: {0}", command)).not.toContain("\u2068");
  });

  it("localizes ignored companion decisions while retaining the no-op and action identity", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const key = "Companion command {0} ignored: braavo spawn has no local approval gate (actionId {1}).";
    for (const locale of LOCALES) {
      setLocale(locale); const ref = makeChildRef(); const handlers = makeSpawnBridgeHandlers(ref);
      await handlers.onApprove?.("synthetic-action");
      expect(write.mock.calls.at(-1)?.[0]).toBe(`· ${t(key, "approve", "synthetic-action")}\n`);
      expect(ref.current).toBeNull();
    }
  });

  it("substitutes values once and preserves provider answers verbatim", () => {
    const answer = "No keys stored. {0} 日本語 العربية --yes";
    setLocale("ja");
    expect(t("Stored {0} key {1}", "{1}", "value")).toContain("{1}");
    expect(renderCompareLines(makeUi({ tty: false }), { findings: { multiModel: { perModel: { "provider/model": answer }, finalAnswer: answer } } }).join("\n"))
      .toContain(answer);
  });

  it("does not localize JSON fields, protocol statuses, numbers or provider content", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const data = { status: "COMPLETED", costUsd: 1234.5, providerText: "No keys stored.", flag: "--yes" };
    for (const locale of LOCALES) {
      setLocale(locale); emit({ json: true }, data, () => { throw new Error("must stay lazy"); });
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(data);
    }
  });

  it("formats human values with the selected Intl locale, USD and UTC", () => {
    setLocale("de"); expect(numberText(1234.5)).toBe("1.234,5"); expect(moneyText(0.0012)).toContain("0,0012");
    setLocale("ja"); expect(dateText("2026-10-20T08:00:00Z")).toContain("2026");
    expect(dateText("2026-10-20T08:00:00Z")).toContain("UTC");
    setLocale("ar"); expect(statusText("COMPLETED")).toBe("مكتمل"); expect(statusText("NEW_PROTOCOL_TOKEN")).toBe("NEW_PROTOCOL_TOKEN");
    expect(statusText("Commands")).toBe("Commands");
    expect(numberText(1234)).toMatch(/[١٢٣٤]/); expect(moneyText(2)).not.toContain("NaN");
  });

  it("distinguishes missing human values from measured zero in all locales", () => {
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const value of [undefined, null, "", "  ", false, "bad", NaN, Infinity]) {
        expect(numberText(value)).toBe(t("unknown")); expect(moneyText(value)).toBe(t("unknown"));
      }
      expect(numberText(0)).not.toBe(t("unknown")); expect(moneyText(0)).not.toBe(t("unknown"));
      expect(numberText(-1.5)).not.toBe(t("unknown")); expect(numberText(10_000_000)).not.toBe(t("unknown"));
      expect(moneyText(-12.5)).not.toBe(t("unknown"));
    }
  });

  it("uses actual Polish and Arabic plural forms at unit boundaries", () => {
    setLocale("en"); expect(imageCountText(1)).toBe("1 image");
    setLocale("pl");
    expect([1, 2, 5, 1.5].map(imageCountText)).toEqual(["1 obraz", "2 obrazy", "5 obrazów", "1,5 obrazu"]);
    expect([1, 2, 5, 1.5].map(dayText)).toEqual(["1 dzień", "2 dni", "5 dni", "1,5 dnia"]);
    setLocale("ar");
    expect([0, 1, 2, 3, 11, 100].map(imageCountText)).toEqual(["صور: ٠", "صورة واحدة (١)", "صورتان (٢)", "٣ صور", "١١ صورة", "١٠٠ صورة"]);
    expect(dayText(1)).toContain("يوم"); expect(dayText(2)).toContain("يومان"); expect(dayText(3)).toContain("أيام");
    for (const value of [-1, -2, -3, -1.5]) expect(dayText(value)).toBe(`الأيام: ${numberText(value)}`);
  });

  it("wraps authored CJK help and preserves Hindi clusters and command syntax", () => {
    const hindi = "क्षिक्षिक्षि";
    expect(fitTerminalLine(hindi, 2)).toBe("क्षि…");
    for (const text of ["这是一个很长的中文说明没有空格", "긴한국어설명문장입니다", hindi]) {
      const wrapped = wrapTerminalText(text, 6);
      expect(wrapped.replaceAll("\n", "")).toBe(text);
      expect(wrapped.split("\n").every(line => terminalWidth(line) <= 6)).toBe(true);
    }
    for (const locale of LOCALES) {
      setLocale(locale); const help = renderHelp(makeUi({ tty: false }), "ask", 24);
      expect(help).toContain(COMMAND_HELP.find(([name]) => name === "ask")![1]);
      expect(help).not.toContain("�");
    }
  });

  it("retains refusal and bare --yes semantics across languages", () => {
    for (const locale of LOCALES) {
      setLocale(locale); expect(() => requireConfirmation({ yes: true }, "target-id")).not.toThrow();
      expect(() => requireConfirmation({ yes: "true" }, "target-id")).toThrow();
      expect(() => requireConfirmation({ approval: "unverified", yes: true }, "target-id")).toThrow();
    }
  });
});

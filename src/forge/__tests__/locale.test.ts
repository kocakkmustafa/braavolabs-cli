import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogue, LOCALES, setLocale, resolveLocale, localeArgs, t, numberText, moneyText, dateText, statusText } from "../locale";
import { COMMAND_HELP, renderHelp } from "../help";
import { makeUi } from "../ui";
import { emit, requireConfirmation } from "../output";
import { renderCompareLines } from "../../braavo";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

afterEach(() => { setLocale("en"); vi.restoreAllMocks(); });
const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort();

describe("eight explicit CLI locales", () => {
  it("has complete keys and interpolation slots in every locale", () => {
    const english = Object.keys(catalogue.en).sort();
    expect(LOCALES).toEqual(["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar"]);
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
    setLocale("ar"); expect(statusText("COMPLETED")).toBe("مكتمل"); expect(statusText("NEW_PROTOCOL_TOKEN")).toBe("NEW_PROTOCOL_TOKEN");
    expect(statusText("Commands")).toBe("Commands");
    expect(numberText(1234)).toMatch(/[١٢٣٤]/); expect(moneyText(2)).not.toContain("NaN");
  });

  it("retains refusal and bare --yes semantics across languages", () => {
    for (const locale of LOCALES) {
      setLocale(locale); expect(() => requireConfirmation({ yes: true }, "target-id")).not.toThrow();
      expect(() => requireConfirmation({ yes: "true" }, "target-id")).toThrow();
      expect(() => requireConfirmation({ approval: "unverified", yes: true }, "target-id")).toThrow();
    }
  });
});

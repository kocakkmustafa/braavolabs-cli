import { describe, it, expect, vi } from "vitest";
import { lastLines, buildFixPrompt, runFix, defaultRunCmd, SUGGESTION_NOTE } from "../fix";
// renderFixLines is the entrypoint-owned renderer (ui in, string[] out).
import { renderFixLines } from "../../forge";
import { makeUi } from "../ui";

const colorUi = makeUi({ tty: true });

/** Any green ANSI escape — banned by terminal-noir. */
function assertNoGreen(text: string) {
  expect(text).not.toMatch(/\x1b\[(?:\d+;)*(?:32|92)m/);
  expect(text).not.toContain("38;5;2m");
  expect(text).not.toContain("38;5;10m");
}

describe("lastLines", () => {
  it("keeps only the last n lines and trims trailing whitespace", () => {
    const text = ["1", "2", "3", "4", "5"].join("\n") + "\n\n";
    expect(lastLines(text, 2)).toBe("4\n5");
  });
  it("returns everything when there are fewer than n lines", () => {
    expect(lastLines("only\ntwo", 80)).toBe("only\ntwo");
  });
});

describe("buildFixPrompt", () => {
  it("includes the output tail", () => {
    const p = buildFixPrompt("AssertionError: expected 1 to be 2");
    expect(p).toContain("AssertionError: expected 1 to be 2");
    expect(p).toContain("command output (tail)");
  });
  it("puts the repo context block FIRST when provided", () => {
    const p = buildFixPrompt("boom", "=== repo context ===\nbranch: main");
    expect(p.indexOf("repo context")).toBeLessThan(p.indexOf("boom"));
  });
});

describe("runFix — cost honesty", () => {
  it("short-circuits to green on exit 0 and NEVER calls the model", async () => {
    const run = vi.fn(() => ({ code: 0, output: "All tests passed" }));
    const ask = vi.fn(async () => "should not be called");
    const outcome = await runFix("npm test", { run, ask });
    expect(outcome).toEqual({ green: true, code: 0 });
    expect(ask).not.toHaveBeenCalled();
  });

  it("on failure sends the output tail (+ repo block) and returns a suggestion", async () => {
    const run = vi.fn(() => ({ code: 1, output: "line1\nline2\nFAIL: boom" }));
    let seen = "";
    const ask = vi.fn(async (prompt: string) => {
      seen = prompt;
      return "change x to y";
    });
    const outcome = await runFix("vitest run", { run, ask, repoBlock: "=== repo context ===" });
    expect(outcome.green).toBe(false);
    if (outcome.green) return;
    expect(outcome.code).toBe(1);
    expect(outcome.suggestion).toBe("change x to y");
    // payload carries the failing tail and the repo context
    expect(seen).toContain("FAIL: boom");
    expect(seen).toContain("=== repo context ===");
    expect(outcome.prompt).toBe(seen);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("respects a custom tail size", async () => {
    const output = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
    const run = () => ({ code: 2, output });
    let seen = "";
    const ask = async (p: string) => ((seen = p), "fix");
    await runFix("cmd", { run, ask, tailLines: 3 });
    expect(seen).toContain("L199");
    expect(seen).not.toContain("L196");
  });
});

describe("defaultRunCmd — real sh -c", () => {
  it("captures a zero exit", () => {
    expect(defaultRunCmd("exit 0").code).toBe(0);
  });
  it("captures a non-zero exit and combined stderr", () => {
    const r = defaultRunCmd("echo oops 1>&2; exit 5");
    expect(r.code).toBe(5);
    expect(r.output).toContain("oops");
  });
});

describe("renderFixLines — suggestion-only, no green", () => {
  it("green prints one arc line and no model text", () => {
    const lines = renderFixLines(colorUi, { green: true, code: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tests already green");
    assertNoGreen(lines.join("\n"));
  });
  it("failure stamps the suggestion-only note ahead of the body and never auto-applies", () => {
    const lines = renderFixLines(colorUi, {
      green: false,
      code: 1,
      suggestion: "edit foo.ts line 3",
      prompt: "…",
    });
    const joined = lines.join("\n");
    expect(joined).toContain(SUGGESTION_NOTE);
    expect(joined).toContain("edit foo.ts line 3");
    expect(joined).toContain("forge never applies");
    assertNoGreen(joined);
  });
});

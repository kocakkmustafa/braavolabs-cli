import { describe, it, expect } from "vitest";
import { makeUi } from "../ui";
import { renderCompareLines, renderCascadeLines, renderSavingsTable, extractSaved } from "../../forge";

const colorUi = makeUi({ tty: true });

const compareSession = {
  status: "COMPLETED",
  findings: {
    summary: "s",
    multiModel: {
      perModel: { "gpt-4o": "sky scatters blue light", "claude-3": "Rayleigh scattering" },
      finalAnswer: "Both agree: Rayleigh scattering.",
      totalCostUsd: 0.012,
    },
  },
};

const cascadeResult = {
  answer: "The mitochondria is the powerhouse of the cell.",
  provider: "openai",
  model: "gpt-4o-mini",
  tier: "cheap",
  confidence: 0.9,
  escalated: false,
  totalCostUsd: 0.0003,
  stoppedReason: "confident",
  attempts: [{ provider: "openai", model: "gpt-4o-mini", tier: "cheap", confidence: 0.9, costUsd: 0.0003 }],
};

const savingsData = {
  period: { days: 7 },
  report: {
    actualUsd: 12.34,
    baselineUsd: 40,
    savedUsd: 27.66,
    savedTokens: 123456,
    savedPct: 69,
    breakdown: { cheapRoutingUsd: 20, cacheUsd: 5, retrievalUsd: 0 },
  },
  note: "some rows reconstructed",
};

/** Regex/substrings for any green ANSI — these must never appear. */
function assertNoGreen(text: string) {
  // SGR green foregrounds: 32 / 92 (basic + bright), and 256-color green band.
  expect(text).not.toMatch(/\x1b\[(?:\d+;)*(?:32|92)m/);
  for (const code of ["38;5;2m", "38;5;10m", "38;5;22", "38;5;28", "38;5;34", "38;5;40", "38;5;46"]) {
    expect(text).not.toContain(code);
  }
}

describe("renderCompareLines", () => {
  it("emits an arc-blue block header per model plus a synthesis block", () => {
    const lines = renderCompareLines(colorUi, compareSession);
    const joined = lines.join("\n");
    expect(joined).toContain("── gpt-4o ──");
    expect(joined).toContain("── claude-3 ──");
    expect(joined).toContain("sky scatters blue light");
    expect(joined).toContain("── synthesis ──");
    expect(joined).toContain("Both agree");
  });

  it("omits the saved line when findings carry no real savings figure", () => {
    const lines = renderCompareLines(colorUi, compareSession);
    expect(lines.join("\n")).not.toContain("saved");
  });

  it("prints the ember saved line only when a genuine savedUsd exists", () => {
    const withSaved = {
      status: "COMPLETED",
      findings: { multiModel: { perModel: { m: "a" }, savedUsd: 3.5, savedTokens: 1200 } },
    };
    expect(extractSaved(withSaved.findings)).toEqual({ usd: 3.5, tokens: 1200 });
    const joined = renderCompareLines(colorUi, withSaved).join("\n");
    expect(joined).toContain("≈ saved $3.50 · 1,200 tokens");
  });
});

describe("renderCascadeLines", () => {
  it("shows the answer and a tier/confidence meta line", () => {
    const joined = renderCascadeLines(colorUi, cascadeResult).join("\n");
    expect(joined).toContain("powerhouse of the cell");
    expect(joined).toContain("tier=cheap");
    expect(joined).toContain("confidence=90%");
    expect(joined).toContain("no escalation");
  });
});

describe("renderSavingsTable", () => {
  it("renders an aligned table with saved + breakdown rows", () => {
    const lines = renderSavingsTable(colorUi, savingsData);
    const joined = lines.join("\n");
    expect(joined).toContain("saved");
    expect(joined).toContain("$27.66");
    expect(joined).toContain("(69%)");
    expect(joined).toContain("123,456");
    expect(joined).toContain("── breakdown ──");
    expect(joined).toContain("retrieval");
  });
});

describe("terminal-noir palette", () => {
  it("uses arc-blue but never any green across all renders", () => {
    const all = [
      ...renderCompareLines(colorUi, compareSession),
      ...renderCascadeLines(colorUi, cascadeResult),
      ...renderSavingsTable(colorUi, savingsData),
    ].join("\n");
    expect(all).toContain("38;5;75"); // arc-blue is present → colors really are on
    assertNoGreen(all);
  });

  it("emits no ANSI escapes at all when not a TTY (piped output stays clean)", () => {
    const plain = makeUi({ tty: false });
    const joined = renderSavingsTable(plain, savingsData).join("\n");
    expect(joined).not.toContain("\x1b[");
    expect(plain.enabled).toBe(false);
  });
});

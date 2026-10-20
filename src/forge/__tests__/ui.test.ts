import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUi } from "../ui";

describe("approved coin terminal motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("BRAAVO_NO_COLOR", undefined);
    vi.stubEnv("BRAAVO_REDUCED_MOTION", undefined);
    vi.stubEnv("BRAAVO_THEME", undefined);
    vi.stubEnv("COLORFGBG", undefined);
    vi.stubEnv("TERM", "xterm-256color");
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses coin face/edge frames only on stderr and accepts live labels", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const spin = makeUi({ tty: true, stderrTty: true }).spinner("thinking");
    vi.advanceTimersByTime(180);
    expect(err.mock.calls.at(-1)?.[0]).toContain("◉");
    spin.update("waiting for response");
    vi.advanceTimersByTime(180);
    expect(err.mock.calls.at(-1)?.[0]).toContain("◐");
    expect(err.mock.calls.at(-1)?.[0]).toContain("waiting for response");
    vi.advanceTimersByTime(180);
    expect(err.mock.calls.at(-1)?.[0]).toContain("│");
    expect(out).not.toHaveBeenCalled();
    spin.stop();
  });

  it("stops exactly once without inventing a successful result", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const final = vi.spyOn(console, "error").mockImplementation(() => {});
    const spin = makeUi({ tty: true, stderrTty: true }).spinner("thinking");
    vi.advanceTimersByTime(180);
    spin.stop();
    const count = err.mock.calls.length;
    spin.stop("should not print");
    spin.update("after stop");
    vi.advanceTimersByTime(2000);
    expect(err).toHaveBeenCalledTimes(count);
    expect(final).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { tty: false, stderrTty: true },
    { tty: true, stderrTty: false },
    { tty: true, stderrTty: true, reducedMotion: true },
  ])("keeps non-animated output plain for %j", (opts) => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const final = vi.spyOn(console, "error").mockImplementation(() => {});
    const spin = makeUi(opts).spinner("thinking");
    spin.update("still working");
    vi.advanceTimersByTime(900);
    expect(err).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    spin.stop("finished");
    spin.stop("duplicate");
    expect(final.mock.calls).toEqual([["thinking"], ["finished"]]);
  });

  it.each([
    ["NO_COLOR", ""], ["NO_COLOR", "1"],
    ["BRAAVO_NO_COLOR", ""], ["BRAAVO_NO_COLOR", "1"],
    ["BRAAVO_REDUCED_MOTION", "1"], ["TERM", "dumb"],
  ])("disables animation for %s=%s", (key, value) => {
    vi.stubEnv(key, value);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const ui = makeUi({ tty: true, stderrTty: true });
    const spin = ui.spinner("thinking");
    vi.advanceTimersByTime(900);
    spin.stop();
    expect(err).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (key !== "BRAAVO_REDUCED_MOTION") {
      expect(ui.primary("plain")).toBe("plain");
    }
  });

  it("defaults spinner capability to actual stderr, not a forced stdout TTY", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      const spin = makeUi({ tty: true }).spinner("thinking");
      vi.advanceTimersByTime(500);
      spin.stop();
      expect(err).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });

  it("keeps redirected warnings and failure strings free of stdout color codes", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ui = makeUi({ tty: true, stderrTty: false });
    expect(ui.primary("colored stdout")).toContain("\x1b[");
    ui.warn("warning"); expect(err).toHaveBeenCalledExactlyOnceWith("! warning");
    expect(ui.fail("failure")).toBe("✗ failure");
    expect(makeUi({ tty: false, stderrTty: true }).fail("stdout failure")).not.toContain("\x1b[");
  });

  it("keeps narrow animated CJK/Hindi labels on one line without splitting clusters", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spin = makeUi({ tty: true, stderrTty: true, columns: 9 }).spinner("中文中文中文");
    vi.advanceTimersByTime(180); expect(err.mock.calls.at(-1)?.[0]).toContain("中文…");
    spin.update("क्षिक्षिक्षिक्षिक्षिक्षिक्षि");
    vi.advanceTimersByTime(180); expect(err.mock.calls.at(-1)?.[0]).toContain("क्षिक्षिक्षिक्षिक्षि…");
    spin.stop();
  });

  it("chooses explicit palettes, recognized background hints and a safe system fallback", () => {
    vi.stubEnv("BRAAVO_THEME", "light"); expect(makeUi({ tty: true }).primary("x")).toContain("38;5;24m");
    expect(makeUi({ tty: true, theme: "dark" }).primary("x")).toContain("38;5;146m");
    vi.stubEnv("BRAAVO_THEME", "system");
    for (const [hint, code] of [["15;0", "146"], ["0;15", "24"], ["0;7", "24"], ["15;0;0", "146"]]) {
      vi.stubEnv("COLORFGBG", hint); expect(makeUi({ tty: true }).primary("x")).toContain(`38;5;${code}m`);
    }
    for (const hint of [undefined, "", "0;4", "0;255", "0;15\n", "background=white"]) {
      vi.stubEnv("COLORFGBG", hint); expect(makeUi({ tty: true }).primary("x")).toBe("\x1b[39mx\x1b[0m");
    }
    vi.stubEnv("BRAAVO_THEME", "invalid"); expect(makeUi({ tty: true }).primary("x")).toBe("\x1b[39mx\x1b[0m");
  });

  it("keeps standard light/dark palette text above 4.5:1 without faint styling", () => {
    function luminance(rgb: number[]) {
      const linear = rgb.map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    function ansiRgb(code: number) {
      if (code >= 232) return [0, 0, 0].map(() => 8 + 10 * (code - 232));
      const levels = [0, 95, 135, 175, 215, 255], index = code - 16;
      return [levels[Math.floor(index / 36)], levels[Math.floor(index / 6) % 6], levels[index % 6]];
    }
    for (const theme of ["light", "dark"] as const) {
      const ui = makeUi({ tty: true, stderrTty: true, theme }); const bg = theme === "light" ? 1 : 0;
      for (const format of [ui.primary, ui.ember, ui.molten, ui.steel, ui.dim]) {
        const text = format("readable"); const code = Number(/38;5;(\d+)m/.exec(text)![1]); const fg = luminance(ansiRgb(code));
        expect((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05), `${theme}:${code}`).toBeGreaterThanOrEqual(4.5);
        expect(text).not.toContain("\x1b[2m");
      }
      expect(makeUi({ tty: false, stderrTty: false, theme }).primary("plain")).toBe("plain");
      vi.stubEnv("NO_COLOR", ""); expect(makeUi({ tty: true, theme }).primary("plain")).toBe("plain");
      vi.stubEnv("NO_COLOR", undefined);
    }
  });
});

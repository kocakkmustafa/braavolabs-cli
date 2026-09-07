import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUi } from "../ui";

describe("approved coin terminal motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("BRAAVO_NO_COLOR", undefined);
    vi.stubEnv("BRAAVO_REDUCED_MOTION", undefined);
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
    expect(final).toHaveBeenCalledExactlyOnceWith("finished");
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
});

import { describe, it, expect, vi } from "vitest";
import { requireConfirmation, ConfirmationRequiredError, emit } from "../output";
import { EXIT } from "../exit-codes";

/**
 * BR-P1-002 — "Mutating command exact confirmation veya bound approval token
 * ister" (roadmap §5.2).
 *
 * The failure this prevents: a script loops over run ids and calls
 * `braavo stop` on each. One typo, and it stops production runs with no prompt
 * because nothing is a TTY in CI. So the refusal must be the DEFAULT, and
 * opting out must be explicit and visible in the command line.
 */
describe("requireConfirmation", () => {
  it("refuses a mutating action by default", () => {
    expect(() => requireConfirmation({}, "stop run r1")).toThrow(ConfirmationRequiredError);
  });

  it("carries the CONFIRMATION_REQUIRED exit code, not a generic 1", () => {
    try {
      requireConfirmation({}, "stop run r1");
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ConfirmationRequiredError).exitCode).toBe(EXIT.CONFIRMATION_REQUIRED);
    }
  });

  it("names the exact action in the refusal, so the operator can see what would have happened", () => {
    try {
      requireConfirmation({}, "stop run r1");
    } catch (e) {
      expect((e as Error).message).toContain("stop run r1");
      expect((e as Error).message).toMatch(/--yes/);
    }
  });

  it("proceeds with an explicit --yes", () => {
    expect(() => requireConfirmation({ yes: true }, "stop run r1")).not.toThrow();
  });

  it("proceeds with a bound approval token", () => {
    expect(() => requireConfirmation({ approval: "tok_abc" }, "stop run r1")).not.toThrow();
  });

  it("does NOT accept a --yes that was given a string value by accident", () => {
    // `--yes something` parses as {yes: "something"}. Treating that as consent
    // would let `braavo stop --yes <runId>` swallow the id and confirm itself.
    expect(() => requireConfirmation({ yes: "run-123" }, "stop run r1")).toThrow(
      ConfirmationRequiredError,
    );
  });

  it("does not accept an empty approval token as consent", () => {
    expect(() => requireConfirmation({ approval: "" }, "x")).toThrow(ConfirmationRequiredError);
    expect(() => requireConfirmation({ approval: true }, "x")).toThrow(ConfirmationRequiredError);
  });
});

describe("emit (--json contract)", () => {
  it("prints machine-readable JSON when --json is set, and nothing else", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    emit({ json: true }, { ok: true, id: "r1" }, () => "human text");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ ok: true, id: "r1" });
    log.mockRestore();
  });

  it("prints the human form when --json is absent", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    emit({}, { ok: true }, () => "human text");
    expect(log).toHaveBeenCalledWith("human text");
    log.mockRestore();
  });

  it("never interleaves human text into the JSON stream", () => {
    // A script does `braavo cost --json | jq`. One stray console.log of a
    // spinner or a hint makes that a parse error.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    emit({ json: true }, { a: 1 }, () => "should not appear");
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).not.toContain("should not appear");
    expect(() => JSON.parse(printed)).not.toThrow();
    log.mockRestore();
  });
});

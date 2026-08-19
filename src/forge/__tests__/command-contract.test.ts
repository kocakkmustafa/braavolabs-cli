import { describe, it, expect } from "vitest";
import { EXIT, EXIT_MEANING } from "../exit-codes";
import { CONTRACT_COMMANDS, helpCoversContract } from "../contract";

/**
 * BR-P1-002 — the CLI's top-level command contract.
 *
 * Roadmap §5.2 fixes the surface a scriptable CLI must expose. Today the CLI
 * grew organically (ask/cascade/local/direct/fix/spawn/media-key…) and only
 * `run` and `steer` of the contract exist, so a script written against the
 * documented contract fails at the shell.
 *
 * Two things are pinned here rather than left to review:
 *   - every contract command is REACHABLE and DOCUMENTED in --help;
 *   - exit codes are a stable, documented enum, because a non-interactive
 *     caller branches on them and "1 for everything" is not a contract.
 */
describe("command contract (roadmap §5.2)", () => {
  it("names every command the contract requires", () => {
    expect(CONTRACT_COMMANDS).toEqual([
      "doctor", "init", "run", "watch", "approve", "steer", "pause", "stop",
      "policy", "audit", "cost", "connect", "agent", "session",
    ]);
  });

  it("--help documents every contract command", () => {
    // helpCoversContract returns the MISSING ones, so the failure message
    // names exactly what to add rather than just going red.
    expect(helpCoversContract()).toEqual([]);
  });
});

describe("exit codes", () => {
  it("are distinct — a caller must be able to tell them apart", () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
  });

  it("reserve 0 for success and never reuse it", () => {
    expect(EXIT.OK).toBe(0);
    expect(Object.entries(EXIT).filter(([, v]) => v === 0)).toHaveLength(1);
  });

  it("document every code — an undocumented exit code is not a contract", () => {
    for (const name of Object.keys(EXIT)) {
      expect(EXIT_MEANING[name as keyof typeof EXIT], `${name} has no documented meaning`).toBeTruthy();
    }
  });

  it("distinguishes the failures a script actually branches on", () => {
    // These four are the ones automation needs to tell apart: bad invocation,
    // no credentials, refused-for-safety, and upstream failure. Collapsing any
    // pair into one code makes a wrapper script unable to react correctly.
    const distinct = [EXIT.USAGE, EXIT.AUTH, EXIT.CONFIRMATION_REQUIRED, EXIT.API];
    expect(new Set(distinct).size).toBe(4);
    // "none of these is 0" is deliberately NOT asserted: the literal types make
    // it a compile-time truth, and tsc flags the comparison as unintentional.
    // The type system is the stronger guard here.
  });
});

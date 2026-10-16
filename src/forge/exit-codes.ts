/**
 * Documented exit codes (BR-P1-002, roadmap §5.2:
 * "Non-interactive mode exit code ve structured error taşır").
 *
 * A non-interactive caller branches on these, so they are part of the public
 * contract: stable values, distinct meanings, and never reused. Exiting 1 for
 * everything is not a contract — a wrapper script cannot tell "you typed it
 * wrong" from "the server is down" from "I refused this for safety", and those
 * three need completely different reactions.
 */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** Unclassified failure. Prefer a specific code; this is the fallback. */
  GENERAL: 1,
  /** Bad invocation: unknown command, missing/invalid argument. */
  USAGE: 2,
  /** Not authenticated, or the token was rejected. Re-run `braavo login`. */
  AUTH: 3,
  /** A mutating action was refused because it lacked local confirmation or
   *  supplied an unverified approval token. The action did NOT happen. */
  CONFIRMATION_REQUIRED: 4,
  /** The API host is not trusted for credentials (see forge/config.ts).
   *  Nothing was sent. */
  UNTRUSTED_HOST: 5,
  /** The referenced resource does not exist, or is not visible to this tenant. */
  NOT_FOUND: 6,
  /** The API returned an error. Transient vs permanent is in the message. */
  API: 7,
  /** A local verification failed (e.g. `audit verify` hash-chain mismatch). */
  VERIFICATION_FAILED: 8,
  /** Ctrl-C stopped a local wait; remote work may still be running. */
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Human-readable meaning per code. Exported (not just a comment) so `braavo
 * --help` and the docs render from ONE source — a documented exit code that
 * drifts from its implementation is worse than an undocumented one.
 */
export const EXIT_MEANING: Record<keyof typeof EXIT, string> = {
  OK: "success",
  GENERAL: "unclassified failure",
  USAGE: "bad invocation — unknown command or invalid argument",
  AUTH: "not authenticated, or the token was rejected",
  CONFIRMATION_REQUIRED: "refused: mutating action needs a bare --yes; unverified approvals are rejected",
  UNTRUSTED_HOST: "refused: API host is not trusted for credentials",
  NOT_FOUND: "resource not found or not visible to this tenant",
  API: "the API returned an error",
  VERIFICATION_FAILED: "local verification failed",
  INTERRUPTED: "interrupted while waiting; remote work may still be running",
};

/**
 * Non-interactive output + mutation safety (BR-P1-002, roadmap §5.2:
 * "Default human output kısa. Her read/action command için --json. Mutating
 * action exact confirmation veya bound approval token ister.").
 */
import { EXIT, type ExitCode } from "./exit-codes";

/** Flags as parsed by braavo.ts: a bare `--flag` is `true`, `--flag v` is `v`. */
export type Flags = Record<string, string | boolean | undefined>;

export class ConfirmationRequiredError extends Error {
  readonly exitCode: ExitCode = EXIT.CONFIRMATION_REQUIRED;
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationRequiredError";
  }
}

/**
 * Gate a mutating action.
 *
 * Refusal is the DEFAULT and consent must be explicit, because nothing is a TTY
 * in CI: a script that loops over ids and calls a mutating command would
 * otherwise act on every one of them with no prompt. `action` is echoed back so
 * the operator sees exactly what would have happened.
 *
 * Consent is `--yes` as a BARE flag, or a non-empty `--approval <token>`.
 * `--yes <value>` is deliberately NOT consent: `braavo stop --yes r1` parses as
 * `{yes: "r1"}` with no positional, and treating that as confirmation would let
 * a mistyped command confirm itself.
 */
export function requireConfirmation(flags: Flags, action: string): void {
  if (flags.yes === true) return;
  if (typeof flags.approval === "string" && flags.approval.trim() !== "") return;
  throw new ConfirmationRequiredError(
    `Refusing to ${action} without confirmation.\n` +
      `  Re-run with --yes to confirm, or --approval <token> to supply a bound approval.\n` +
      `  Nothing has been changed.`,
  );
}

/**
 * Emit a result in the caller's requested shape.
 *
 * With `--json`, the ONLY thing written to stdout is one JSON document —
 * `braavo cost --json | jq` must not have to tolerate a stray hint or spinner
 * line. Human output is produced lazily so formatting work is skipped entirely
 * in JSON mode.
 */
export function emit(flags: Flags, data: unknown, human: () => string): void {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(human());
}

/**
 * forge fix — run YOUR test command, and if it fails, ask a model for a fix.
 *
 *   forge fix --cmd "<test-command>" [--via local|direct <provider>|ask] [--repo]
 *
 * Contract (why this is safe by construction):
 *   - The command is the USER'S OWN, passed to `sh -c` exactly as given. Forge
 *     adds nothing to it. (README carries the security note that this executes
 *     whatever you type — treat it like any shell command.)
 *   - Cost honesty: if the command exits 0, forge prints "tests already green"
 *     and NEVER calls a model. No spend on a passing suite.
 *   - Suggestion-only: on failure, forge sends the tail of the output (+ optional
 *     --repo context) to the selected backend and PRINTS the suggested fix. It
 *     NEVER writes to a file or applies a patch. The output is prefixed with a
 *     steel "suggestion only — review before applying" note.
 *
 * The command runner and the LLM backend are injected so tests exercise both
 * the green short-circuit and the failure payload without a real shell or model.
 */
import { spawnSync } from "node:child_process";

/** Steel note stamped ahead of every suggestion — forge never auto-applies. */
export const SUGGESTION_NOTE = "suggestion only — review before applying";

/** Default tail size (lines of command output) sent to the model. */
export const FIX_TAIL_LINES = 80;

export interface RunResult {
  code: number;
  output: string;
}

/** Turns a failure payload into a suggested fix (a model backend). */
export type AskFn = (prompt: string) => Promise<string>;

export interface FixDeps {
  /** Run the user's test command; returns exit code + combined output. */
  run: (cmd: string) => RunResult;
  /** Backend that produces a suggestion — only invoked when the command FAILS. */
  ask: AskFn;
  /** Optional repo-context block prepended to the failure payload. */
  repoBlock?: string;
  /** Override the output-tail line count (default FIX_TAIL_LINES). */
  tailLines?: number;
}

export type FixOutcome =
  | { green: true; code: 0 }
  | { green: false; code: number; suggestion: string; prompt: string };

/** Default runner: sh -c "<cmd>" — the user's own command, verbatim. */
export function defaultRunCmd(cmd: string): RunResult {
  // Combined stream so the model sees stderr (where most test failures print)
  // alongside stdout. A signal-killed process has status null → treat as failure.
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: r.status ?? 1, output };
}

/** Keep the last `n` lines of `text` (after trimming trailing whitespace). */
export function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** Build the failure payload sent to the model (tail of output + repo context). */
export function buildFixPrompt(tail: string, repoBlock?: string): string {
  const parts: string[] = [];
  if (repoBlock) parts.push(repoBlock);
  parts.push(
    "The following test command failed. Suggest a focused fix. " +
      "Do not restate the whole file — give the minimal change and a one-line rationale.",
  );
  parts.push("--- command output (tail) ---");
  parts.push(tail);
  return parts.join("\n\n");
}

/**
 * Run the command; short-circuit to green on exit 0 (no model call), otherwise
 * send the failure tail (+ repo context) to `deps.ask` and return the suggestion.
 * Never applies anything.
 */
export async function runFix(cmd: string, deps: FixDeps): Promise<FixOutcome> {
  const res = deps.run(cmd);
  if (res.code === 0) {
    return { green: true, code: 0 };
  }
  const tail = lastLines(res.output, deps.tailLines ?? FIX_TAIL_LINES);
  const prompt = buildFixPrompt(tail, deps.repoBlock);
  const suggestion = await deps.ask(prompt);
  return { green: false, code: res.code, suggestion, prompt };
}

/**
 * The top-level command contract (roadmap §5.2).
 *
 * Kept as data, not prose, so `--help` and the contract test read the SAME
 * list. A contract asserted only in a doc comment drifts the first time
 * somebody adds a command and forgets the doc.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_COMMANDS = [
  "doctor",
  "init",
  "run",
  "watch",
  "approve",
  "steer",
  "pause",
  "stop",
  "policy",
  "audit",
  "cost",
  "connect",
  "agent",
  "session",
] as const;

export type ContractCommand = (typeof CONTRACT_COMMANDS)[number];

/**
 * Which contract commands are NOT documented in the help text.
 *
 * Reads braavo.ts's source rather than rendering help at runtime: help
 * rendering pulls in the whole CLI (config, keychain, network clients), and a
 * documentation check should not need any of that. Returns the missing names
 * so a failure says what to add.
 */
export function helpCoversContract(sourcePath?: string): string[] {
  const src = readFileSync(
    sourcePath ?? join(process.cwd(), "src", "forge", "help.ts"),
    "utf8",
  );
  // Only look inside the HELP template so a command merely being implemented
  // in the switch does not count as documented.
  const start = src.indexOf("const HELP");
  const help = start >= 0 ? src.slice(start) : src;
  return CONTRACT_COMMANDS.filter(
    (cmd) => !new RegExp(`braavo ${cmd}\\b`).test(help),
  );
}

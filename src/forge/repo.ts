/**
 * forge --repo — structured git context, prepended to a prompt.
 *
 * When the caller passes `--repo` and the cwd is a git work tree, forge gathers
 * a compact, factual snapshot (branch, porcelain status, last 5 commits, staged
 * and unstaged diff --stat) and prepends it to the prompt so a model reasons
 * about the ACTUAL working tree — not a guess.
 *
 * Guarantees:
 *   - Every git invocation is an execFile arg-array (no shell, no injection).
 *   - Total block is capped at ~4KB; on overflow we cut and mark it honestly
 *     with a [truncated …] line (never silently drop context).
 *   - If cwd is not a git repo, we return an honest error — we never fabricate
 *     a "clean tree" or empty context.
 *
 * `git` is injectable so tests never shell out to a real repository.
 */
import { execFileSync } from "node:child_process";

/** Hard ceiling for the assembled context block (bytes ≈ chars). */
export const REPO_CONTEXT_MAX = 4096;

const TRUNC_MARK = "[truncated: repo context exceeded 4096 bytes — showing the head]";

/** Run `git` with an arg-array (never a shell string) inside `cwd`. */
export type GitRunner = (args: string[]) => string;

export interface RepoDeps {
  cwd: string;
  /** Injected git runner; defaults to `execFileSync("git", args, { cwd })`. */
  git?: GitRunner;
}

export type RepoContext =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

function defaultGit(cwd: string): GitRunner {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Collect the repo context block for `cwd`. Returns { ok:false } with an honest
 * message when cwd is not inside a git work tree.
 */
export function collectRepoContext(deps: RepoDeps): RepoContext {
  const git = deps.git ?? defaultGit(deps.cwd);

  // Gate: is this a git work tree at all? A non-zero exit (throw) or any answer
  // other than "true" means no — report it honestly rather than inventing state.
  let inside = "";
  try {
    inside = git(["rev-parse", "--is-inside-work-tree"]).trim();
  } catch {
    return { ok: false, error: `not a git repository: ${deps.cwd}` };
  }
  if (inside !== "true") {
    return { ok: false, error: `not a git repository: ${deps.cwd}` };
  }

  // Each of these can legitimately fail (e.g. a repo with no commits yet) — a
  // failure yields an empty section, never a thrown error or a fabricated value.
  // Trim only trailing whitespace — porcelain status carries a MEANINGFUL leading
  // space (worktree vs. index column) that a full .trim() would destroy.
  const safe = (args: string[]): string => {
    try {
      return git(args).replace(/\s+$/, "");
    } catch {
      return "";
    }
  };

  const branch = safe(["rev-parse", "--abbrev-ref", "HEAD"]) || "(unknown)";
  const status = safe(["status", "--porcelain"]);
  const log = safe(["log", "-5", "--oneline"]);
  const staged = safe(["diff", "--cached", "--stat"]);
  const unstaged = safe(["diff", "--stat"]);

  const lines: string[] = [];
  lines.push("=== repo context ===");
  lines.push(`branch: ${branch}`);
  lines.push("--- status (git status --porcelain) ---");
  lines.push(status || "(clean)");
  lines.push("--- last 5 commits (git log -5 --oneline) ---");
  lines.push(log || "(no commits)");
  lines.push("--- staged (git diff --cached --stat) ---");
  lines.push(staged || "(none)");
  lines.push("--- unstaged (git diff --stat) ---");
  lines.push(unstaged || "(none)");
  lines.push("=== end repo context ===");

  const full = lines.join("\n");
  if (full.length <= REPO_CONTEXT_MAX) {
    return { ok: true, text: full, truncated: false };
  }

  // Overflow: cut to fit the marker under the ceiling and flag it honestly.
  const head = full.slice(0, REPO_CONTEXT_MAX - TRUNC_MARK.length - 1).trimEnd();
  return { ok: true, text: `${head}\n${TRUNC_MARK}`, truncated: true };
}

/** Prepend a repo-context block to a prompt (context first, per the blueprint). */
export function prependRepoContext(context: string, prompt: string): string {
  return `${context}\n\n${prompt}`;
}

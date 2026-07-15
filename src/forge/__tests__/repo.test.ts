import { describe, it, expect, vi } from "vitest";
import { collectRepoContext, prependRepoContext, REPO_CONTEXT_MAX, type GitRunner } from "../repo";

/** A fake `git` that answers from a fixture keyed by the joined argv. */
function fakeGit(map: Record<string, string>, calls?: string[][]): GitRunner {
  return (args) => {
    calls?.push(args);
    const key = args.join(" ");
    if (key in map) return map[key];
    throw new Error(`git ${key} failed (exit 128)`);
  };
}

const HAPPY: Record<string, string> = {
  "rev-parse --is-inside-work-tree": "true\n",
  "rev-parse --abbrev-ref HEAD": "feat/forge-cli-p4\n",
  "status --porcelain": " M src/forge.ts\n?? new.ts\n",
  "log -5 --oneline": "9b505c3 merge\nb681ebe merge main\n",
  "diff --cached --stat": " src/a.ts | 2 +-\n",
  "diff --stat": " src/b.ts | 9 +++++----\n",
};

describe("collectRepoContext", () => {
  it("assembles branch, status, last-5 commits and both diff stats", () => {
    const calls: string[][] = [];
    const res = collectRepoContext({ cwd: "/repo", git: fakeGit(HAPPY, calls) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(false);
    expect(res.text).toContain("branch: feat/forge-cli-p4");
    expect(res.text).toContain(" M src/forge.ts");
    expect(res.text).toContain("9b505c3 merge");
    expect(res.text).toContain("src/a.ts | 2 +-");
    expect(res.text).toContain("src/b.ts | 9 +++++----");
  });

  it("invokes git only as arg-arrays — never a shell string (no injection seam)", () => {
    const calls: string[][] = [];
    collectRepoContext({ cwd: "/repo", git: fakeGit(HAPPY, calls) });
    for (const c of calls) {
      expect(Array.isArray(c)).toBe(true);
      // no token is a joined shell command with metacharacters
      expect(c.join(" ")).not.toMatch(/[;&|]/);
    }
    expect(calls[0]).toEqual(["rev-parse", "--is-inside-work-tree"]);
  });

  it("returns an honest error when cwd is not a git work tree (rev-parse throws)", () => {
    const git = vi.fn(() => {
      throw new Error("fatal: not a git repository");
    });
    const res = collectRepoContext({ cwd: "/tmp/plain", git });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not a git repository");
    expect(res.error).toContain("/tmp/plain");
  });

  it("returns an honest error when rev-parse answers something other than 'true'", () => {
    const res = collectRepoContext({
      cwd: "/repo/.git",
      git: fakeGit({ "rev-parse --is-inside-work-tree": "false\n" }),
    });
    expect(res.ok).toBe(false);
  });

  it("falls back to placeholders (never fabricates) for empty sections", () => {
    const res = collectRepoContext({
      cwd: "/repo",
      git: fakeGit({
        "rev-parse --is-inside-work-tree": "true",
        "rev-parse --abbrev-ref HEAD": "main",
        "status --porcelain": "",
        "log -5 --oneline": "",
        "diff --cached --stat": "",
        "diff --stat": "",
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("(clean)");
    expect(res.text).toContain("(no commits)");
    expect(res.text).toContain("(none)");
  });

  it("caps the block at ~4KB and marks the truncation honestly", () => {
    const huge = Array.from({ length: 2000 }, (_, i) => ` M file_${i}.ts`).join("\n");
    const res = collectRepoContext({
      cwd: "/repo",
      git: fakeGit({ ...HAPPY, "status --porcelain": huge }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(REPO_CONTEXT_MAX);
    expect(res.text).toContain("[truncated");
  });
});

describe("prependRepoContext", () => {
  it("puts the context block BEFORE the prompt", () => {
    const out = prependRepoContext("=== repo context ===\nbranch: main", "fix the bug");
    expect(out.indexOf("repo context")).toBeLessThan(out.indexOf("fix the bug"));
    expect(out.startsWith("=== repo context ===")).toBe(true);
  });
});

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Skills (plan 5.3, local part): folders with a `SKILL.md` — the format Claude Code and
 * the Agent Skills spec use — that the user gives an agent.
 *
 *   ~/.braavo/skills/<name>/SKILL.md          user skills
 *   <project>/.braavo/skills/<name>/SKILL.md  project skills (projects registered in ~/.braavo/skills.json)
 *   <project>/.claude/skills/<name>/SKILL.md  read as project skills too, so existing skills just work
 *
 * SKILL.md starts with YAML front matter (`name`, `description`; other keys are kept but
 * unused) followed by Markdown instructions. An agent with a skill gets the skill's
 * instructions in its system prompt (conversations freeze them with the memory snapshot).
 * Nothing in a skill folder is executed: scripts next to SKILL.md are listed, never run.
 * On a name clash the project skill wins over the user skill, as in Claude Code.
 */

export const SKILL_BODY_MAX = 12_000;
const SKILLS_PROMPT_MAX = 24_000;
const MAX_SKILLS = 500;

export interface Skill {
  name: string;
  description: string;
  source: "user" | "project";
  /** Folder holding SKILL.md. */
  dir: string;
  /** Other files in the folder (names only), e.g. scripts or references the instructions mention. */
  files: string[];
}

export interface SkillWithBody extends Skill { body: string; truncated: boolean }

export class SkillError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Minimal front matter reader: top-level `key: value` lines, quotes stripped, `>`/`|` blocks joined. */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[kv[1]] = value;
  }
  return { meta, body: m[2].trim() };
}

export interface SkillsConfig { projects: string[] }

export class SkillRegistry {
  constructor(private readonly userDir: string, private readonly configFile: string) {}

  config(): SkillsConfig {
    try {
      const raw = JSON.parse(readFileSync(this.configFile, "utf8")) as { projects?: unknown };
      return { projects: Array.isArray(raw.projects) ? raw.projects.filter((p): p is string => typeof p === "string") : [] };
    } catch { return { projects: [] }; }
  }

  /** Register a project folder (absolute path); its .braavo/skills and .claude/skills are read. */
  addProject(path: string): SkillsConfig {
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new SkillError(400, `not a folder: ${abs}`);
    const cfg = this.config();
    if (!cfg.projects.includes(abs)) cfg.projects.push(abs);
    this.save(cfg);
    return cfg;
  }

  removeProject(path: string): SkillsConfig {
    const abs = resolve(path);
    const cfg = { projects: this.config().projects.filter(p => p !== abs) };
    this.save(cfg);
    return cfg;
  }

  private save(cfg: SkillsConfig): void {
    mkdirSync(dirname(this.configFile), { recursive: true, mode: 0o700 });
    writeFileSync(this.configFile, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  }

  /** Every readable skill; `extraProjects` adds folders for one call (e.g. the CLI's working directory). */
  list(extraProjects: string[] = []): Skill[] {
    const found = new Map<string, Skill>();
    const scan = (root: string, source: Skill["source"]) => {
      if (!existsSync(root)) return;
      let entries: string[];
      try { entries = readdirSync(root); } catch { return; }
      for (const entry of entries.sort()) {
        if (found.size >= MAX_SKILLS) return;
        const dir = join(root, entry);
        const file = join(dir, "SKILL.md");
        try { if (!statSync(dir).isDirectory() || !existsSync(file)) continue; } catch { continue; }
        const parsed = parseSkillFile(readFileSync(file, "utf8").slice(0, 200_000));
        const name = parsed?.meta.name ?? "";
        if (!parsed || !NAME.test(name)) continue;
        // A project skill replaces a user skill of the same name; the first project wins among projects.
        if (found.has(name) && !(source === "project" && found.get(name)!.source === "user")) continue;
        let files: string[] = [];
        try { files = readdirSync(dir).filter(f => f !== "SKILL.md" && !f.startsWith(".")).slice(0, 50); } catch { /* unreadable */ }
        found.set(name, { name, description: (parsed.meta.description ?? "").slice(0, 1024), source, dir, files });
      }
    };
    scan(this.userDir, "user");
    for (const project of [...new Set([...this.config().projects, ...extraProjects.map(p => resolve(p))])]) {
      scan(join(project, ".braavo", "skills"), "project");
      scan(join(project, ".claude", "skills"), "project");
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string, extraProjects: string[] = []): SkillWithBody | null {
    const skill = this.list(extraProjects).find(s => s.name === name);
    if (!skill) return null;
    const body = parseSkillFile(readFileSync(join(skill.dir, "SKILL.md"), "utf8"))?.body ?? "";
    return { ...skill, body: body.slice(0, SKILL_BODY_MAX), truncated: body.length > SKILL_BODY_MAX };
  }

  /**
   * The instructions of the given skills for a system prompt, in order, capped as a whole.
   * Skills that disappeared from disk are skipped (the assignment stays until changed).
   */
  promptFor(names: string[]): string {
    if (!names.length) return "";
    const all = new Map(this.list().map(s => [s.name, s]));
    const parts: string[] = [];
    let used = 0;
    for (const name of names) {
      const skill = all.get(name);
      if (!skill) continue;
      const body = (parseSkillFile(readFileSync(join(skill.dir, "SKILL.md"), "utf8"))?.body ?? "").slice(0, SKILL_BODY_MAX);
      const part = `### Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ""}${body}`;
      if (used + part.length > SKILLS_PROMPT_MAX) break;
      parts.push(part); used += part.length;
    }
    return parts.join("\n\n");
  }
}

export const isSkillName = (v: unknown): v is string => typeof v === "string" && NAME.test(v);

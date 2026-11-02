import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStore } from "../store";
import { ChatService } from "../chat";
import { Daemon } from "../server";
import { runTask } from "../tasks";
import { parseSkillFile, SkillRegistry } from "../skills";

const KEY = "gsk_test_0123456789abcdef";
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function skill(root: string, folder: string, frontMatter: string, body = "Do the thing.", extra: Record<string, string> = {}) {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), `---\n${frontMatter}\n---\n\n${body}\n`);
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(root, folder, f), c);
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), "braavo-skills-"));
  const userDir = join(home, "skills");
  const project = join(home, "project");
  mkdirSync(project);
  const registry = new SkillRegistry(userDir, join(home, "skills.json"));
  return { home, userDir, project, registry };
}
const sse = (text: string) => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`, "data: [DONE]\n\n",
].join(""), { status: 200 });

describe("SKILL.md front matter", () => {
  it("reads name and description in the forms real skills use", () => {
    expect(parseSkillFile("---\nname: reddit-fetch\ndescription: Fetch Reddit.\n---\n\n# Body\n")).toEqual({ meta: { name: "reddit-fetch", description: "Fetch Reddit." }, body: "# Body" });
    expect(parseSkillFile('---\nname: "flutter-widgets"\ndescription: "Adds widgets."\nmetadata:\n  model: "x"\n\n---\nBody')?.meta).toEqual({ name: "flutter-widgets", description: "Adds widgets.", metadata: "" });
    expect(parseSkillFile("---\nname: a\ndescription: >\n  folded\n  text\n---\nB")?.meta.description).toBe("folded text");
    expect(parseSkillFile("no front matter")).toBeNull();
  });
});

describe("skill registry (5.3)", () => {
  it("lists user and project skills, reads .claude/skills, lets a project skill win, and skips invalid ones", () => {
    const { userDir, project, registry } = setup();
    skill(userDir, "launch-post", "name: launch-post\ndescription: Write launch posts.", "Keep it short.", { "template.md": "x" });
    skill(userDir, "shared", "name: shared\ndescription: user version");
    skill(join(project, ".braavo", "skills"), "shared", "name: shared\ndescription: project version");
    skill(join(project, ".claude", "skills"), "code-review", "name: code-review\ndescription: Review diffs.");
    skill(userDir, "bad", "name: Bad Name\ndescription: x");
    skill(userDir, "nameless", "description: no name");
    expect(registry.list().map(s => s.name)).toEqual(["launch-post", "shared"]);
    registry.addProject(project);
    const all = registry.list();
    expect(all.map(s => [s.name, s.source])).toEqual([["code-review", "project"], ["launch-post", "user"], ["shared", "project"]]);
    expect(all.find(s => s.name === "shared")!.description).toBe("project version");
    expect(all.find(s => s.name === "launch-post")!.files).toEqual(["template.md"]);
    expect(registry.get("launch-post")).toMatchObject({ body: "Keep it short.", truncated: false });
    expect(registry.get("missing")).toBeNull();
    registry.removeProject(project);
    expect(registry.list([project]).map(s => s.name)).toContain("code-review");
    expect(() => registry.addProject(join(project, "nope"))).toThrow(/not a folder/);
  });

  it("builds the prompt in the assigned order, skips skills that are gone and caps the total", () => {
    const { userDir, registry } = setup();
    skill(userDir, "one", "name: one\ndescription: First.", "Body one.");
    skill(userDir, "two", "name: two\ndescription: Second.", "Body two.");
    skill(userDir, "huge", "name: huge\ndescription: Big.", "x".repeat(20_000));
    expect(registry.promptFor(["two", "gone", "one"])).toBe("### Skill: two\nSecond.\n\nBody two.\n\n### Skill: one\nFirst.\n\nBody one.");
    expect(registry.promptFor([])).toBe("");
    const capped = registry.promptFor(["huge", "huge", "huge", "one"]);
    expect(capped.length).toBeLessThanOrEqual(24_000);
  });
});

describe("skills on agents", () => {
  async function daemonWith() {
    const { userDir, registry } = setup();
    skill(userDir, "launch-post", "name: launch-post\ndescription: Write launch posts.", "Always end with the link.");
    const store = new DaemonStore(":memory:");
    const co = store.createCompany({ name: "Acme" });
    const ag = store.createAgent({ companyId: co.id, name: "Writer", role: "content-social", provider: "GROQ", model: "openai/gpt-oss-20b" });
    const token = "t".repeat(43);
    const daemon = new Daemon({ store, token, version: "test", skills: registry });
    const port = await daemon.listen(0);
    closers.push(async () => { await daemon.close(); store.close(); });
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => {
        let data = ""; res.on("data", c => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return { store, co, ag, registry, userDir, call };
  }

  it("lists skills and assigns them to an agent over the API; the panel shows them", async () => {
    const { call, ag, co } = await daemonWith();
    expect((await call("GET", "/v1/skills")).body.skills.map((s: { name: string }) => s.name)).toEqual(["launch-post"]);
    expect((await call("GET", "/v1/skills/launch-post")).body.skill.body).toBe("Always end with the link.");
    expect((await call("GET", "/v1/skills/nope")).status).toBe(404);
    expect((await call("PUT", `/v1/agents/${ag.id}/skills`, { skills: ["missing"] })).body.error).toBe("unknown skills: missing");
    expect((await call("PUT", `/v1/agents/${ag.id}/skills`, { skills: "launch-post" })).status).toBe(400);
    expect((await call("PUT", `/v1/agents/${ag.id}/skills`, { skills: ["launch-post"] })).body.skills).toEqual(["launch-post"]);
    expect((await call("GET", `/v1/agents/${ag.id}/skills`)).body.skills).toEqual(["launch-post"]);
    expect((await call("GET", `/v1/companies/${co.id}/panel`)).body.agents[0].skills).toEqual(["launch-post"]);
  });

  it("puts an agent's skills into its conversations (frozen) and tasks", async () => {
    const { store, co, ag, registry, userDir } = await daemonWith();
    store.setAgentSkills(ag.id, ["launch-post"]);
    const fetchImpl = vi.fn(async () => sse("ok"));
    const chat = new ChatService(store, { keys: { get: () => KEY }, keyProviders: () => ["groq"], fetchImpl: fetchImpl as never, skills: registry });
    const cv = chat.create({ agentId: ag.id });
    writeFileSync(join(userDir, "launch-post", "SKILL.md"), "---\nname: launch-post\ndescription: changed\n---\nChanged body.\n");
    await chat.send(cv.id, "Write it", () => {});
    const system = (n: number) => JSON.parse((fetchImpl.mock.calls[n] as unknown as [string, { body: string }])[1].body).messages[0].content as string;
    expect(system(0)).toContain("## Skills");
    expect(system(0)).toContain("Always end with the link.");
    expect(system(0)).not.toContain("Changed body.");

    const task = store.createTask({ companyId: co.id, title: "Post", assigneeAgentId: ag.id, createdBy: "user" });
    expect(await runTask(store, task.id, { keys: { get: () => KEY }, fetchImpl: fetchImpl as never, skills: registry })).toEqual({ outcome: "done" });
    expect(system(1)).toContain("Changed body.");
    expect(readFileSync(join(userDir, "launch-post", "SKILL.md"), "utf8")).toContain("changed");
  });
});

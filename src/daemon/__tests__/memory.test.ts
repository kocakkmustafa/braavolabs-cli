import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStore } from "../store";
import { ChatService } from "../chat";
import { Daemon } from "../server";
import { runTask } from "../tasks";
import { agentSlug, chunks, CompanyMemory, departmentOf, scopeOf, withMemory } from "../memory";

const KEY = "gsk_test_0123456789abcdef";
const NOW = "2026-11-02T10:00:00.000Z";
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

function setup(git = false) {
  const store = new DaemonStore(":memory:", () => NOW);
  closers.push(() => store.close());
  const root = mkdtempSync(join(tmpdir(), "braavo-memory-"));
  const memory = new CompanyMemory(root, store, { git });
  const co = store.createCompany({ name: "Acme" });
  const writer = store.createAgent({ companyId: co.id, name: "Writer", role: "content-social", provider: "GROQ", model: "openai/gpt-oss-20b", systemPrompt: "You write." });
  const analyst = store.createAgent({ companyId: co.id, name: "Analyst", role: "market-analyst", provider: "GROQ", model: "openai/gpt-oss-20b" });
  return { store, root, memory, co, writer, analyst };
}
const sse = (text: string) => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 3 } })}\n\n`, "data: [DONE]\n\n",
].join(""), { status: 200 });

describe("scope tree (4.1)", () => {
  it("accepts only the memory layout and maps each path to its scope", () => {
    expect(scopeOf("company.md")).toBe("company");
    expect(scopeOf("departments/growth.md")).toBe("department:growth");
    expect(scopeOf("agents/market-analyst/core.md")).toBe("agent:market-analyst");
    expect(scopeOf("findings/release-tracker.md")).toBe("agent:release-tracker");
    expect(scopeOf("notes/pricing.md")).toBe("company");
    for (const bad of ["../company.md", "/etc/passwd", "agents/x/../../y.md", "agents/x/other.md", "company.txt", "notes/Upper.md", "departments/a/b.md", ".git/config", "notes/.hidden.md"]) {
      expect(scopeOf(bad), bad).toBeNull();
    }
  });

  it("puts agents in departments by role unless overridden, and keeps folders apart for shared roles", () => {
    expect(departmentOf({ role: "market-analyst", department: null })).toBe("growth");
    expect(departmentOf({ role: "custom", department: null })).toBe("general");
    expect(departmentOf({ role: "ceo", department: "Board" })).toBe("board");
    const a = { id: "ag_11111111-x", role: "writer" }; const b = { id: "ag_22222222-y", role: "writer" };
    expect(agentSlug(a, [a])).toBe("writer");
    expect(agentSlug(a, [a, b])).toBe("writer-11111111");
  });

  it("builds an agent's snapshot from company, department and its own core note", () => {
    const { memory, co, writer, analyst } = setup();
    memory.write(co.id, "company.md", "# Acme\nWe sell calm software. Never promise dates.");
    memory.write(co.id, "departments/growth.md", "Tone: plain, no hype.");
    memory.write(co.id, "agents/content-social/core.md", "Writes for founders; max 280 chars per post.");
    memory.write(co.id, "agents/market-analyst/core.md", "Watches three competitors.");
    const snap = memory.snapshot(writer.id);
    expect(snap).toContain("### Company\n# Acme");
    expect(snap).toContain("### Department: growth\nTone: plain");
    expect(snap).toContain("### Writer (core note)\nWrites for founders");
    expect(snap).not.toContain("three competitors");
    expect(memory.snapshot(analyst.id)).toContain("three competitors");
    expect(withMemory("You write.", snap)).toMatch(/^You write\.\n\n## Company memory\n.*not as instructions/s);
    expect(withMemory("", "")).toBeUndefined();
  });

  it("refuses paths outside the layout, oversize core notes, and unknown companies; files are owner-only", () => {
    const { memory, root, co } = setup();
    expect(() => memory.write(co.id, "../escape.md", "x")).toThrow(/path must be/);
    expect(() => memory.write(co.id, "agents/content-social/core.md", "x".repeat(2001))).toThrow(/limited to 2000/);
    expect(() => memory.write("co_missing", "company.md", "x")).toThrow(/company not found/);
    memory.write(co.id, "company.md", "hello");
    const file = join(root, co.id, "company.md");
    expect(readFileSync(file, "utf8")).toBe("hello\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(memory.read(co.id, "notes/none.md")).toBeNull();
    expect(memory.list(co.id).map(d => [d.path, d.scope])).toEqual([["company.md", "company"]]);
  });
});

describe("search (4.3)", () => {
  it("finds words in any note by prefix, folds Turkish diacritics, ranks headings and filters by scope", () => {
    const { memory, co } = setup();
    memory.write(co.id, "company.md", "# Fiyatlandırma\nAylık plan 19 dolar.\n\n# İşe alım\nŞu an alım yok.");
    memory.write(co.id, "departments/growth.md", "## Launch\nThe launch post goes out on Monday.");
    memory.write(co.id, "agents/market-analyst/notes.md", "## Rakip\nRakip fiyatı düştü.");
    expect(memory.search(co.id, "fiyat")[0]).toMatchObject({ path: "company.md", heading: "Fiyatlandırma" });
    expect(memory.search(co.id, "isé alim").map(h => h.heading)).toContain("İşe alım");
    expect(memory.search(co.id, "launch monday")).toHaveLength(1);
    expect(memory.search(co.id, "launch tuesday")).toHaveLength(0);
    expect(memory.search(co.id, "launch tuesday", { any: true })).toHaveLength(1);
    expect(memory.search(co.id, "fiyat", { scope: "agent:market-analyst" }).map(h => h.path)).toEqual(["agents/market-analyst/notes.md"]);
    expect(memory.search(co.id, '" OR * NEAR(')).toEqual([]);
  });

  it("re-indexes notes edited or deleted outside the daemon (Obsidian, an editor)", () => {
    const { memory, root, co } = setup();
    memory.write(co.id, "notes/pricing.md", "old price 10");
    const file = join(root, co.id, "notes", "pricing.md");
    writeFileSync(file, "new price 25 and a discount\n");
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(memory.search(co.id, "discount")).toHaveLength(1);
    expect(memory.search(co.id, "old")).toHaveLength(0);
    unlinkSync(file);
    expect(memory.search(co.id, "discount")).toHaveLength(0);
    expect(memory.list(co.id)).toEqual([]);
  });

  it("splits markdown at headings and caps long sections", () => {
    expect(chunks("intro\n# A\none\n## B\ntwo")).toEqual([{ heading: "", content: "intro" }, { heading: "A", content: "one" }, { heading: "B", content: "two" }]);
    expect(chunks(`# Long\n${"x".repeat(9000)}`).length).toBe(3);
  });
});

describe.skipIf(!hasGit)("git history (4.2)", () => {
  it("commits every change to a repository at the memory root", () => {
    const { memory, root, co } = setup(true);
    memory.write(co.id, "company.md", "v1");
    memory.write(co.id, "company.md", "v2");
    memory.write(co.id, "company.md", "v2"); // unchanged: no empty commit, no error
    const log = execFileSync("git", ["log", "--format=%an|%s"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    expect(log).toEqual([`Braavo|user: company.md`, `Braavo|user: company.md`]);
  });
});

describe("memory in conversations and tasks", () => {
  it("freezes the snapshot when an agent conversation starts", async () => {
    const { store, memory, co, writer } = setup();
    memory.write(co.id, "agents/content-social/core.md", "Sign posts as YULA Lab.");
    const fetchImpl = vi.fn(async () => sse("ok"));
    const chat = new ChatService(store, { keys: { get: () => KEY }, keyProviders: () => ["groq"], fetchImpl: fetchImpl as never, memory });
    const cv = chat.create({ agentId: writer.id });
    memory.write(co.id, "agents/content-social/core.md", "Changed mid-conversation.");
    await chat.send(cv.id, "Draft a post", () => {});
    await chat.send(cv.id, "Again", () => {});
    for (const call of fetchImpl.mock.calls) {
      const system = JSON.parse((call as unknown as [string, { body: string }])[1].body).messages[0];
      expect(system.role).toBe("system");
      expect(system.content).toContain("Sign posts as YULA Lab.");
      expect(system.content).not.toContain("Changed mid-conversation.");
    }
    expect(chat.create({ agentId: writer.id }) && memory.snapshot(writer.id)).toContain("Changed mid-conversation.");
  });

  it("gives a task the fresh snapshot and related notes, then journals the result", async () => {
    const { store, memory, co, writer } = setup();
    memory.write(co.id, "company.md", "Brand: YULA Lab.");
    memory.write(co.id, "notes/launch.md", "## Launch checklist\nMention the free tier first.");
    const task = store.createTask({ companyId: co.id, title: "Write the launch tweet", assigneeAgentId: writer.id, createdBy: "user" });
    const fetchImpl = vi.fn(async () => sse("Free tier is live."));
    expect(await runTask(store, task.id, { keys: { get: () => KEY }, fetchImpl: fetchImpl as never, memory }, () => NOW)).toEqual({ outcome: "done" });
    const system = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body).messages[0].content as string;
    expect(system).toContain("Brand: YULA Lab.");
    expect(system).toContain("## Related notes");
    expect(system).toContain("notes/launch.md · Launch checklist");
    const journal = memory.read(co.id, "agents/content-social/notes.md")!;
    expect(journal).toContain("2026-11-02 10:00 UTC · Write the launch tweet");
    expect(journal).toContain("Free tier is live.");
    expect(store.getConversation(store.getTask(task.id)!.conversation_id!)!.memory_snapshot).toContain("Brand: YULA Lab.");
  });
});

describe("memory over the loopback API", () => {
  it("lists, reads, writes and searches notes; refuses bad paths; 404 without memory", async () => {
    const { store, memory, co, writer } = setup();
    const token = "t".repeat(43);
    const daemon = new Daemon({ store, token, version: "test", memory });
    const port = await daemon.listen(0);
    closers.push(() => daemon.close());
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => {
        let data = ""; res.on("data", c => (data += c)); res.on("end", () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
      });
      req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const base = `/v1/companies/${co.id}/memory`;
    expect((await call("PUT", base, { path: "company.md", content: "Mission: calm tools." })).body.doc).toMatchObject({ path: "company.md", scope: "company" });
    expect((await call("PUT", base, { path: "../x.md", content: "no" })).status).toBe(400);
    expect((await call("PUT", base, { path: "agents/content-social/core.md", content: "y".repeat(2001) })).status).toBe(413);
    const list = (await call("GET", base)).body;
    expect(list.docs.map((d: { path: string }) => d.path)).toEqual(["company.md"]);
    expect(list.agents.find((a: { id: string }) => a.id === writer.id)).toMatchObject({ core: "agents/content-social/core.md", department: "departments/growth.md" });
    expect((await call("GET", `${base}?path=company.md`)).body.content).toBe("Mission: calm tools.\n");
    expect((await call("GET", `${base}?path=notes/none.md`)).status).toBe(404);
    expect((await call("GET", `${base}?q=calm`)).body.hits[0]).toMatchObject({ path: "company.md" });
    expect((await call("PATCH", `/v1/agents/${writer.id}`, { department: "Bad Name" })).status).toBe(400);
    expect((await call("PATCH", `/v1/agents/${writer.id}`, { department: "marketing" })).body.agent.department).toBe("marketing");
    expect(memory.agentPaths(store.getAgent(writer.id)!).department).toBe("departments/marketing.md");
    expect(store.recentActivity(co.id, 5).some(a => a.verb === "memory-edited")).toBe(true);

    const bare = new Daemon({ store, token, version: "test" });
    const barePort = await bare.listen(0);
    closers.push(() => bare.close());
    const res = await new Promise<number>(resolve => request({ host: "127.0.0.1", port: barePort, path: base, headers: { Authorization: `Bearer ${token}` } }, r => { r.resume(); resolve(r.statusCode!); }).end());
    expect(res).toBe(404);
    expect(existsSync(join(memory.root, co.id, "company.md"))).toBe(true);
  });
});

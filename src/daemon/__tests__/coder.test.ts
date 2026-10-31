import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideRoot, projectInstructions, runCoder, undoSession, unifiedDiff, type CoderEvent } from "../coder";
import type { StreamEvent } from "../../core/providers";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "braavo-coder-")); dirs.push(d); return d; };

/** A scripted model: each turn yields the next list of events; records what it was sent. */
function scripted(turns: StreamEvent[][]) {
  const sent: any[] = [];
  let i = 0;
  const call = {
    ok: true as const,
    async *stream(request: any) { sent.push(JSON.parse(JSON.stringify(request))); for (const ev of turns[i++] ?? [{ type: "done", stopReason: "end_turn" }]) yield ev as StreamEvent; },
  };
  return { call, sent };
}
const tool = (id: string, name: string, args: unknown): StreamEvent => ({ type: "tool_call", call: { id, name, argumentsJson: JSON.stringify(args) } });

function project() {
  const root = tmp();
  writeFileSync(join(root, "AGENTS.md"), "Use two-space indentation. Never touch secrets.env.");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "greet.ts"), 'export function greet(name: string) {\n  return "Hello " + name;\n}\n');
  return root;
}

describe("coding agent paths and context", () => {
  it("keeps every path inside the project", () => {
    const root = project(); const outside = tmp();
    expect(insideRoot(root, "src/greet.ts")).toMatch(/src\/greet\.ts$/);
    expect(() => insideRoot(root, "../x")).toThrow(/outside the project/);
    expect(() => insideRoot(root, "/etc/passwd")).toThrow(/outside the project/);
    expect(() => insideRoot(root, ".git/config")).toThrow(/off limits/);
    symlinkSync(outside, join(root, "escape"));
    expect(() => insideRoot(root, "escape/new.txt")).toThrow(/leaves the project/);
  });

  it("reads AGENTS.md / CLAUDE.md from the root and its parents, nearest last", () => {
    const parent = tmp(); writeFileSync(join(parent, "CLAUDE.md"), "PARENT RULE");
    const root = join(parent, "app"); mkdirSync(root); writeFileSync(join(root, "AGENTS.md"), "CHILD RULE");
    const text = projectInstructions(root);
    expect(text.indexOf("PARENT RULE")).toBeLessThan(text.indexOf("CHILD RULE"));
  });

  it("renders a unified diff with context", () => {
    expect(unifiedDiff("a.ts", "one\ntwo\nthree\n", "one\n2\nthree\n")).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,4 @@\n one\n-two\n+2\n three\n ");
    expect(unifiedDiff("n.ts", null, "x\n")).toContain("--- /dev/null");
  });
});

describe("coding agent loop", () => {
  it("reads, edits with a diff, checkpoints, summarises — and undo restores the file", async () => {
    const root = project(); const cp = tmp();
    const { call, sent } = scripted([
      [tool("1", "read_file", { path: "src/greet.ts" }), { type: "done", stopReason: "tool_use" }],
      [tool("2", "edit_file", { path: "src/greet.ts", old_string: '"Hello " + name', new_string: "`Hello, ${name}!`" }),
        tool("3", "write_file", { path: "src/greet.test.ts", content: "// test\n" }), { type: "done", stopReason: "tool_use" }],
      [{ type: "text", text: "Switched to a template string and added a test file." }, { type: "done", stopReason: "end_turn" }],
    ]);
    const events: CoderEvent[] = [];
    const result = await runCoder({ root, task: "Use a template string in greet", call, checkpointDir: cp, sessionId: "s1", onEvent: e => events.push(e) });

    expect(readFileSync(join(root, "src", "greet.ts"), "utf8")).toContain("`Hello, ${name}!`");
    expect(result.changes.map(c => c.path)).toEqual(["src/greet.ts", "src/greet.test.ts"]);
    expect(result.changes[0].diff).toContain('-  return "Hello " + name;');
    expect(result.text).toBe("Switched to a template string and added a test file.");
    expect(sent[0].system).toContain("Use two-space indentation");
    expect(sent[0].tools.map((t: any) => t.name)).toEqual(["list_files", "read_file", "search", "edit_file", "write_file"]);
    expect(sent[1].messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "1" });
    expect(sent[1].messages.at(-1).content).toContain('return "Hello " + name;');
    expect(events.filter(e => e.type === "change")).toHaveLength(2);

    expect(undoSession(cp).sort()).toEqual(["src/greet.test.ts", "src/greet.ts"]);
    expect(readFileSync(join(root, "src", "greet.ts"), "utf8")).toContain('"Hello " + name');
    expect(existsSync(join(root, "src", "greet.test.ts"))).toBe(false);
    expect(undoSession(cp)).toEqual([]);
  });

  it("reports tool errors back to the model instead of failing", async () => {
    const root = project(); const cp = tmp();
    const { call, sent } = scripted([
      [tool("1", "edit_file", { path: "src/greet.ts", old_string: "nope", new_string: "x" }), tool("2", "read_file", { path: "../../etc/hosts" }), { type: "done", stopReason: "tool_use" }],
      [{ type: "text", text: "Could not." }, { type: "done", stopReason: "end_turn" }],
    ]);
    await runCoder({ root, task: "t", call, checkpointDir: cp, sessionId: "s2" });
    const results = sent[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(results[0]).toMatch(/appears 0 times/);
    expect(results[1]).toMatch(/outside the project/);
  });

  it("plan mode offers read-only tools; a declined change is not written", async () => {
    const root = project(); const cp = tmp();
    const plan = scripted([[{ type: "text", text: "1. Edit src/greet.ts" }, { type: "done", stopReason: "end_turn" }]]);
    await runCoder({ root, task: "t", call: plan.call, plan: true, checkpointDir: cp, sessionId: "p" });
    expect(plan.sent[0].tools.map((t: any) => t.name)).toEqual(["list_files", "read_file", "search"]);
    expect(plan.sent[0].system).toContain("PLAN MODE");

    const declined = scripted([
      [tool("1", "write_file", { path: "src/greet.ts", content: "gone\n" }), { type: "done", stopReason: "tool_use" }],
      [{ type: "text", text: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const result = await runCoder({ root, task: "t", call: declined.call, approve: async () => false, checkpointDir: cp, sessionId: "d" });
    expect(result.changes).toEqual([]);
    expect(readFileSync(join(root, "src", "greet.ts"), "utf8")).toContain("greet");
    expect(declined.sent[1].messages.at(-1).content).toBe("error: the user declined this change");
  });
});

describe("web_fetch (FK-8)", () => {
  const resolvePublic = async () => ["93.184.216.34"];

  it("checks the allowlist, refuses addresses, localhost and private resolution", async () => {
    const { checkWebUrl } = await import("../coder");
    await expect(checkWebUrl("https://docs.example.com/a", ["example.com"], resolvePublic)).resolves.toBeInstanceOf(URL);
    await expect(checkWebUrl("https://evil.com/", ["example.com"], resolvePublic)).rejects.toThrow(/not in the allowed domains/);
    await expect(checkWebUrl("https://notexample.com/", ["example.com"], resolvePublic)).rejects.toThrow(/not in the allowed/);
    await expect(checkWebUrl("http://127.0.0.1/", ["127.0.0.1"], resolvePublic)).rejects.toThrow(/addresses and localhost/);
    await expect(checkWebUrl("https://user:pw@example.com/", ["example.com"], resolvePublic)).rejects.toThrow(/plain http/);
    await expect(checkWebUrl("https://intranet.example.com/", ["example.com"], async () => ["10.0.0.5"])).rejects.toThrow(/private address/);
    await expect(checkWebUrl("https://v6.example.com/", ["example.com"], async () => ["::ffff:192.168.1.2"])).rejects.toThrow(/private address/);
  });

  it("is offered only with an allowlist, wraps text as untrusted and re-checks redirects", async () => {
    const root = project(); const cp = tmp();
    const fetchImpl = async (url: any) => String(url).includes("/moved")
      ? new Response("", { status: 302, headers: { location: "https://evil.com/x" } })
      : new Response("<html><body><h1>API</h1><p>Use fetch()</p><script>x</script></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const { call, sent } = scripted([
      [tool("1", "web_fetch", { url: "https://docs.example.com/api" }), tool("2", "web_fetch", { url: "https://docs.example.com/moved" }), { type: "done", stopReason: "tool_use" }],
      [{ type: "text", text: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await runCoder({ root, task: "t", call, checkpointDir: cp, sessionId: "w", web: { allow: ["example.com"], fetchImpl: fetchImpl as never, resolve: resolvePublic } });
    expect(sent[0].tools.map((t: any) => t.name)).toContain("web_fetch");
    const results = sent[1].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(results[0]).toMatch(/^<untrusted source="https:\/\/docs\.example\.com\/api">/);
    expect(results[0]).toContain("Use fetch()");
    expect(results[1]).toMatch(/evil\.com is not in the allowed domains/);

    const off = scripted([[{ type: "text", text: "x" }, { type: "done", stopReason: "end_turn" }]]);
    await runCoder({ root, task: "t", call: off.call, checkpointDir: cp, sessionId: "w2" });
    expect(off.sent[0].tools.map((t: any) => t.name)).not.toContain("web_fetch");
  });
});

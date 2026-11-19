import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonStore } from "../store";
import { runRoutine, type RunnerDeps } from "../runner";
import { DEFAULT_POLICY, type PinnedTransport } from "../browse";

const KEY = "gsk_test_0123456789abcdef";
const stores: DaemonStore[] = []; const dirs: string[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const feed = (...titles: string[]) => `<rss version="2.0"><channel>${titles.map(t => `<item><title>${t}</title><link>https://blog.example/${t}</link><guid>${t}</guid><description>About ${t}</description></item>`).join("")}</channel></rss>`;
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200 });

function setup(urls: string[], body: () => string | { status: number; body: string }, type = "application/rss+xml") {
  const store = new DaemonStore(":memory:"); stores.push(store);
  const root = mkdtempSync(join(tmpdir(), "rss-")); dirs.push(root);
  const co = store.createCompany({ name: "Acme" });
  const ag = store.createAgent({ companyId: co.id, name: "Analyst", role: "analyst", systemPrompt: "x", provider: "GROQ", model: "openai/gpt-oss-20b" });
  const rt = store.createRoutine({ companyId: co.id, agentId: ag.id, name: "Feeds", prompt: "Summarise new posts.", rrule: "FREQ=DAILY", timezone: "UTC", createdBy: "user", nextFireAt: new Date().toISOString(), preflight: { type: "rss", urls } });
  const transport = vi.fn<PinnedTransport>(async () => { const b = body(); const o = typeof b === "string" ? { status: 200, body: b } : b; return { status: o.status, headers: { "content-type": type }, body: o.body }; });
  const fetchImpl = vi.fn(async () => sse("One new post."));
  const deps: RunnerDeps = { keys: { get: () => KEY }, fetchImpl: fetchImpl as never, monitorRoot: join(root, "m"), memoryRoot: join(root, "mem"), rss: { policy: DEFAULT_POLICY, browse: { transport, lookup: async () => ["93.184.216.34"] } } };
  return { store, rt, deps, transport, fetchImpl };
}

describe("rss preflight", () => {
  it("baselines silently, then sends only unseen items to the model as untrusted content", async () => {
    let xml = feed("a", "b");
    const { store, rt, deps, fetchImpl } = setup(["https://blog.example/feed.xml"], () => xml);
    expect(await runRoutine(store, rt.id, deps)).toMatchObject({ outcome: "no-change", note: "1 feeds · 1 baseline" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await runRoutine(store, rt.id, deps)).toMatchObject({ outcome: "no-change" });
    xml = feed("c", "a", "b");
    const r = await runRoutine(store, rt.id, deps);
    expect(r).toMatchObject({ outcome: "changed" });
    expect(r.note).toContain("1 new");
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body).messages[1].content as string;
    expect(sent).toContain("<untrusted_web_content");
    expect(sent).toContain("About c");
    expect(sent).not.toContain("About a");
  });

  it("refuses http feeds without any request", async () => {
    const { store, rt, deps, transport } = setup(["http://blog.example/feed.xml"], () => feed("a"));
    const r = await runRoutine(store, rt.id, deps);
    expect(r.outcome).toBe("failed");
    expect(r.note).toMatch(/https feeds only/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects loopback, private and unresolvable-to-public hosts", async () => {
    for (const u of ["https://localhost/f.xml", "https://127.0.0.1/f.xml", "https://10.0.0.5/f.xml", "https://169.254.169.254/latest"]) {
      const { store, rt, deps, transport } = setup([u], () => feed("a"));
      expect(await runRoutine(store, rt.id, deps), u).toMatchObject({ outcome: "failed", note: "1 feeds · 1 failed" });
      expect(transport).not.toHaveBeenCalled();
    }
    const { store, rt, deps, transport } = setup(["https://evil.example/f.xml"], () => feed("a"));
    deps.rss!.browse!.lookup = async () => ["192.168.1.9"];
    expect(await runRoutine(store, rt.id, deps)).toMatchObject({ outcome: "failed" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports HTTP errors, non-feed bodies and wrong content types as failed", async () => {
    expect((await (async () => { const s = setup(["https://blog.example/f"], () => ({ status: 500, body: "" })); return runRoutine(s.store, s.rt.id, s.deps); })()).outcome).toBe("failed");
    expect((await (async () => { const s = setup(["https://blog.example/f"], () => "<html>no feed</html>"); return runRoutine(s.store, s.rt.id, s.deps); })()).outcome).toBe("failed");
    expect((await (async () => { const s = setup(["https://blog.example/f"], () => feed("a"), "image/png"); return runRoutine(s.store, s.rt.id, s.deps); })()).outcome).toBe("failed");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStore } from "../store";
import { CompanyMemory } from "../memory";
import { dot, fromBlob, loadVectorSettings, ollamaEmbedder, rrf, saveVectorSettings, toBlob, type Embedder } from "../vectors";

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

/** Words in the same synonym group land on the same axis, so "price" finds "cost" without sharing a keyword. */
const GROUPS = [["price", "cost", "fiyat", "pricing"], ["launch", "release", "ship"], ["hire", "recruit", "hiring"]];
function fakeEmbedder(calls: string[][] = []): Embedder {
  return {
    model: "fake-embed",
    async embed(texts) {
      calls.push(texts);
      return texts.map(t => GROUPS.map(g => (t.toLowerCase().match(/[a-zı]+/g) ?? []).filter(w => g.includes(w)).length + 0.01));
    },
  };
}
function setup(embedder: (() => Embedder | null) | undefined) {
  const store = new DaemonStore(":memory:");
  closers.push(() => store.close());
  const root = mkdtempSync(join(tmpdir(), "braavo-vec-"));
  const memory = new CompanyMemory(root, store, { git: false, embedder });
  const co = store.createCompany({ name: "Acme" });
  return { store, root, memory, co };
}

describe("vector helpers", () => {
  it("normalises on write so search is a dot product, and fuses ranks", () => {
    const a = fromBlob(toBlob([3, 4])); const b = fromBlob(toBlob([6, 8]));
    expect(dot(a, b)).toBeCloseTo(1, 5);
    expect(rrf([["x", "y", "z"], ["z", "y"]])).toEqual(["z", "y", "x"]);
    expect(rrf([["a", "b"], ["b", "c"]])[0]).toBe("b");
  });

  it("calls Ollama's batched /api/embed and explains a missing model", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ embeddings: JSON.parse(String(init?.body)).input.map(() => [0.1, 0.2]) }), { status: 200 }));
    const e = ollamaEmbedder("nomic-embed-text", { host: "http://127.0.0.1:11434", fetchImpl: fetchImpl as never });
    expect(await e.embed(["a", "b"])).toEqual([[0.1, 0.2], [0.1, 0.2]]);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/embed");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]!.body))).toMatchObject({ model: "nomic-embed-text", input: ["a", "b"] });
    const missing = ollamaEmbedder("nomic-embed-text", { fetchImpl: (async () => new Response("{}", { status: 404 })) as never });
    await expect(missing.embed(["a"])).rejects.toThrow(/not pulled \(braavo models pull nomic-embed-text\)/);
  });

  it("keeps the setting off unless a model is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "braavo-vecset-"));
    expect(loadVectorSettings(join(dir, "none.json"))).toEqual({ embedModel: null });
    saveVectorSettings(join(dir, "s.json"), { embedModel: "nomic-embed-text" });
    expect(loadVectorSettings(join(dir, "s.json")).embedModel).toBe("nomic-embed-text");
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ embedModel: "rm -rf /;" }));
    expect(loadVectorSettings(join(dir, "bad.json")).embedModel).toBeNull();
  });
});

describe("hybrid memory search (4.3)", () => {
  it("is keyword search alone without a model", async () => {
    const { memory, co } = setup(undefined);
    memory.write(co.id, "company.md", "## Cost\nThe plan costs 19 dollars.");
    expect(await memory.searchHybrid(co.id, "price")).toEqual({ hits: [], mode: "fts" });
  });

  it("finds a note by meaning that keyword search misses, and keeps keyword hits", async () => {
    const calls: string[][] = [];
    const embedder = fakeEmbedder(calls);
    const { memory, co } = setup(() => embedder);
    memory.write(co.id, "company.md", "## Cost\nThe plan cost is 19 dollars.\n\n## Team\nWe recruit in spring.");
    memory.write(co.id, "notes/launch.md", "## Release\nWe ship on Monday.");
    const r = await memory.searchHybrid(co.id, "price");
    expect(r.mode).toBe("hybrid");
    expect(r.hits[0]).toMatchObject({ path: "company.md", heading: "Cost" });
    const both = await memory.searchHybrid(co.id, "ship");
    expect(both.hits[0]).toMatchObject({ path: "notes/launch.md", heading: "Release" });
    // Chunks are embedded once; the second search embeds only the query.
    expect(calls.slice(1).every(c => c.length === 1)).toBe(true);
  });

  it("re-embeds only changed chunks and drops vectors of deleted notes", async () => {
    const calls: string[][] = [];
    const embedder = fakeEmbedder(calls);
    const { memory, store, root, co } = setup(() => embedder);
    memory.write(co.id, "company.md", "## A\nprice\n\n## B\nlaunch");
    expect(await memory.syncVectors(co.id, embedder)).toEqual({ embedded: 2, pending: 0 });
    memory.write(co.id, "company.md", "## A\nprice\n\n## B\nrelease date moved");
    expect(await memory.syncVectors(co.id, embedder)).toEqual({ embedded: 1, pending: 0 });
    unlinkSync(join(root, co.id, "company.md"));
    await memory.syncVectors(co.id, embedder);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM memory_vec").get()).toEqual({ n: 0 });
  });

  it("falls back to keyword results with a note when the model is down", async () => {
    const { memory, co } = setup(() => ({ model: "down", embed: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:11434"); } }));
    memory.write(co.id, "company.md", "## Cost\nprice list");
    const r = await memory.searchHybrid(co.id, "price");
    expect(r.mode).toBe("fts");
    expect(r.hits).toHaveLength(1);
    expect(r.note).toMatch(/meaning search unavailable: connect ECONNREFUSED/);
  });
});

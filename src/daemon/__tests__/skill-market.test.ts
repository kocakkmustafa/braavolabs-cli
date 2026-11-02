import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRevocations, cachedRevocations, installed, installPackage, MarketError, refreshRevocations, saveRevocations, verifyPackage,
  type RegistryPackage, type RevocationList,
} from "../skill-market";
import { SkillRegistry } from "../skills";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** The registry's canonical JSON (sorted keys), as the platform signs it. */
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const signed = (v: unknown) => { const text = canonical(v); return { text, signature: sign(null, Buffer.from(text), privateKey).toString("base64") }; };

function pkg(name = "weekly-report", version = "1.0.0", files = [{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: Weekly report.\n---\n\nSummarise the week.\n` }, { path: "refs/template.md", content: "- item\n" }]): RegistryPackage {
  const bundle = JSON.stringify({ files, format: 1 });
  const m = signed({ name, version, sha256: sha(bundle), publisher: "acme", trust: "COMMUNITY", approvedAt: "2026-11-02T10:00:00.000Z", files: files.map(f => ({ path: f.path, size: Buffer.byteLength(f.content), sha256: sha(f.content) })) });
  return { name, version, sha256: sha(bundle), bundle, signedManifest: m.text, signature: m.signature };
}
const revocationList = (entries: Array<{ name: string; version: string; sha256: string; reason: string; revokedAt: string }>): RevocationList => {
  const issuedAt = "2026-11-02T11:00:00.000Z";
  const s = signed({ issuedAt, entries });
  return { issuedAt, entries, signedList: s.text, signature: s.signature };
};

describe("verifying a registry package", () => {
  it("accepts a signed, matching package", () => {
    const v = verifyPackage(pkg(), { name: "weekly-report", version: "1.0.0" }, KEY);
    expect(v.manifest.publisher).toBe("acme");
    expect(v.files.map(f => f.path)).toEqual(["SKILL.md", "refs/template.md"]);
  });

  it("refuses without a key, with a bad signature, for another skill, or when anything was changed", () => {
    expect(() => verifyPackage(pkg(), { name: "weekly-report" }, "")).toThrow(/no registry key/);
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(() => verifyPackage(pkg(), { name: "weekly-report" }, other)).toThrow(/signature/);
    expect(() => verifyPackage(pkg(), { name: "weekly-reports" }, KEY)).toThrow(/another skill/);
    expect(() => verifyPackage(pkg(), { name: "weekly-report", version: "2.0.0" }, KEY)).toThrow(/another skill/);
    const p = pkg();
    expect(() => verifyPackage({ ...p, bundle: p.bundle.replace("Summarise", "Exfiltrate") }, { name: "weekly-report" }, KEY)).toThrow(/signed hash/);
    expect(() => verifyPackage(pkg("weekly-report", "1.0.0", [{ path: "SKILL.md", content: "---\nname: weekly-report\ndescription: x\n---\n" }, { path: "../evil.md", content: "x" }]), { name: "weekly-report" }, KEY)).toThrow(/does not match/);
    expect(() => verifyPackage(pkg("weekly-report", "1.0.0", [{ path: "SKILL.md", content: "---\nname: other\ndescription: x\n---\n" }]), { name: "weekly-report" }, KEY)).toThrow(MarketError);
  });
});

describe("installing", () => {
  it("writes the files with a lock, replaces an earlier registry install and never a hand-made skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "braavo-market-"));
    const p1 = pkg();
    const target = installPackage(dir, verifyPackage(p1, { name: "weekly-report" }, KEY), p1);
    expect(readFileSync(join(target, "refs", "template.md"), "utf8")).toBe("- item\n");
    expect(installed(dir).get("weekly-report")).toMatchObject({ version: "1.0.0", sha256: p1.sha256, publisher: "acme" });
    const p2 = pkg("weekly-report", "1.1.0");
    installPackage(dir, verifyPackage(p2, { name: "weekly-report" }, KEY), p2);
    expect(installed(dir).get("weekly-report")?.version).toBe("1.1.0");
    mkdirSync(join(dir, "mine")); writeFileSync(join(dir, "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
    const p3 = pkg("mine");
    expect(() => installPackage(dir, verifyPackage(p3, { name: "mine" }, KEY), p3)).toThrow(/your own skill/);
    expect(new SkillRegistry(dir, join(dir, "skills.json")).list().map(s => s.name)).toEqual(["mine", "weekly-report"]);
  });
});

describe("revocations", () => {
  it("marks a revoked install, hides it from agents' prompts and takes it off every agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "braavo-revoke-"));
    const p = pkg();
    installPackage(dir, verifyPackage(p, { name: "weekly-report" }, KEY), p);
    const skills = new Map([["a1", ["weekly-report", "other"]], ["a2", ["other"]]]);
    const store = {
      listCompanies: () => [{ id: "c1" }],
      listAgents: () => [{ id: "a1", name: "Writer" }, { id: "a2", name: "Analyst" }],
      agentSkills: (id: string) => skills.get(id) ?? [],
      setAgentSkills: vi.fn((id: string, s: string[]) => { skills.set(id, s); }),
    };
    const notify = vi.fn();
    const list = revocationList([{ name: "weekly-report", version: "1.0.0", sha256: p.sha256, reason: "exfiltrates notes", revokedAt: "2026-11-02T10:30:00.000Z" }]);
    expect(await refreshRevocations({ skillsDir: dir, store, notify, key: KEY, fetchList: async () => list })).toEqual(["weekly-report"]);
    expect(skills.get("a1")).toEqual(["other"]);
    expect(store.setAgentSkills).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Skill revoked", expect.stringContaining("weekly-report"));
    expect(installed(dir).get("weekly-report")?.revoked?.reason).toBe("exfiltrates notes");
    expect(new SkillRegistry(dir, join(dir, "skills.json")).list()).toEqual([]);
    expect(existsSync(join(dir, "weekly-report", "SKILL.md"))).toBe(true); // files stay until the user removes them
    expect(applyRevocations(dir, list.entries)).toEqual([]); // already marked
  });

  it("ignores a list whose signature does not verify, and caches only fresh, verified lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "braavo-revoke2-"));
    const forged = { ...revocationList([]), signedList: canonical({ issuedAt: "x", entries: [{ name: "weekly-report" }] }) };
    await expect(refreshRevocations({ skillsDir: dir, store: { listCompanies: () => [], listAgents: () => [], agentSkills: () => [], setAgentSkills: () => {} }, notify: () => {}, key: KEY, fetchList: async () => forged })).rejects.toThrow(/does not verify/);
    saveRevocations(dir, revocationList([]), 1_000);
    expect(cachedRevocations(dir, 60_000, 30_000, KEY)?.entries).toEqual([]);
    expect(cachedRevocations(dir, 60_000, 100_000, KEY)).toBeNull();
    saveRevocations(dir, forged, 1_000);
    expect(cachedRevocations(dir, 60_000, 2_000, KEY)).toBeNull();
  });
});

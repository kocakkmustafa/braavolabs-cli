import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFile } from "./skills";

/**
 * Community skills (registry client). A package from the registry is installed only when:
 *
 *   1. the registry's ed25519 signature over its manifest verifies with the key this CLI
 *      ships with (SKILL_REGISTRY_PUBLIC_KEY),
 *   2. the manifest names the package and version that were asked for,
 *   3. the bundle hashes to the manifest's SHA-256, and every file matches the manifest's
 *      path, size and hash,
 *   4. it is not on the registry's signed revocation list.
 *
 * Installed packages live next to the user's own skills (~/.braavo/skills/<name>/) with a
 * `.braavo-skill.json` lock. A revoked package's lock is marked `revoked`; SkillRegistry
 * then skips it (no network when a prompt is built), and the daemon drops it from agents.
 * Files are removed only when the user says so (`braavo skills remove`).
 */

/** Base64 SPKI DER of the registry key. Empty until the key is created (skill-registry:keygen). */
export const SKILL_REGISTRY_PUBLIC_KEY = "";
export const registryKey = () => (process.env.BRAAVO_SKILL_REGISTRY_KEY ?? "").trim() || SKILL_REGISTRY_PUBLIC_KEY;

export const LOCK_FILE = ".braavo-skill.json";
const REVOCATIONS_FILE = ".revocations.json";
export const REVOCATIONS_MAX_AGE_MS = 24 * 60 * 60_000;

export class MarketError extends Error {}

export interface ManifestFile { path: string; size: number; sha256: string }
export interface Manifest { name: string; version: string; sha256: string; publisher: string; trust: string; approvedAt: string; files: ManifestFile[] }
export interface RegistryPackage { name: string; version: string; sha256: string; bundle: string; signedManifest: string; signature: string }
export interface Lock { name: string; version: string; sha256: string; publisher: string; trust: string; signedManifest: string; signature: string; installedAt: string; revoked?: { reason: string; at: string } }
export interface Revocation { name: string; version: string; sha256: string; reason: string; revokedAt: string }
export interface RevocationList { issuedAt: string; entries: Revocation[]; signedList: string; signature: string }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function verifySignature(text: string, signature: string, key: string): boolean {
  if (!key) return false;
  try {
    return verify(null, Buffer.from(text), createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
  } catch { return false; }
}

const safePath = (p: string) => !!p && !p.startsWith("/") && !p.includes("\\") && p.split("/").every(s => s && s !== "." && s !== ".." && !s.startsWith("."));

/** All four checks; returns the manifest and the files to write. Throws MarketError with the reason. */
export function verifyPackage(pkg: RegistryPackage, want: { name: string; version?: string }, key = registryKey()): { manifest: Manifest; files: Array<{ path: string; content: string }> } {
  if (!key) throw new MarketError("this build has no registry key yet; community skills cannot be installed");
  if (!verifySignature(pkg.signedManifest, pkg.signature, key)) throw new MarketError("the registry signature does not verify");
  const manifest = JSON.parse(pkg.signedManifest) as Manifest;
  if (manifest.name !== want.name || (want.version && manifest.version !== want.version)) throw new MarketError("the signed manifest is for another skill or version");
  if (sha256(pkg.bundle) !== manifest.sha256 || pkg.sha256 !== manifest.sha256) throw new MarketError("the package does not match its signed hash");
  let bundle: { format?: number; files?: Array<{ path: string; content: string }> };
  try { bundle = JSON.parse(pkg.bundle); } catch { throw new MarketError("the package is not a skill bundle"); }
  const files = bundle.files ?? [];
  if (bundle.format !== 1 || files.length !== manifest.files.length) throw new MarketError("the package files do not match the manifest");
  files.forEach((f, i) => {
    const m = manifest.files[i];
    if (f.path !== m.path || !safePath(f.path) || Buffer.byteLength(f.content) !== m.size || sha256(f.content) !== m.sha256) throw new MarketError(`file ${f.path} does not match the manifest`);
  });
  const skill = files.find(f => f.path === "SKILL.md");
  if (!skill || parseSkillFile(skill.content)?.meta.name !== manifest.name) throw new MarketError("SKILL.md does not name this skill");
  return { manifest, files };
}

export function readLock(dir: string): Lock | null {
  try { return JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as Lock; } catch { return null; }
}

/**
 * Write a verified package to <skillsDir>/<name>, replacing an earlier registry install of
 * it; a skill the user wrote by hand (no lock) is never overwritten.
 */
export function installPackage(skillsDir: string, verified: { manifest: Manifest; files: Array<{ path: string; content: string }> }, pkg: RegistryPackage, now = () => new Date()): string {
  const { manifest, files } = verified;
  const target = join(skillsDir, manifest.name);
  if (existsSync(target) && !readLock(target)) throw new MarketError(`${target} is your own skill; rename it or remove it first`);
  const stage = join(skillsDir, `.${manifest.name}.installing-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  for (const f of files) {
    const path = join(stage, ...f.path.split("/"));
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, f.content, { mode: 0o600 });
  }
  const lock: Lock = { name: manifest.name, version: manifest.version, sha256: manifest.sha256, publisher: manifest.publisher, trust: manifest.trust, signedManifest: pkg.signedManifest, signature: pkg.signature, installedAt: now().toISOString() };
  writeFileSync(join(stage, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  const old = join(skillsDir, `.${manifest.name}.previous-${process.pid}`);
  if (existsSync(target)) renameSync(target, old);
  renameSync(stage, target);
  rmSync(old, { recursive: true, force: true });
  return target;
}

/** Registry installs under skillsDir: name → lock. */
export function installed(skillsDir: string): Map<string, Lock> {
  const out = new Map<string, Lock>();
  let entries: string[] = [];
  try { entries = readdirSync(skillsDir); } catch { return out; }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const lock = readLock(join(skillsDir, e));
    if (lock?.name === e) out.set(e, lock);
  }
  return out;
}

// ── revocations ─────────────────────────────────────────────────────────────

export function verifyRevocations(list: RevocationList, key = registryKey()): Revocation[] {
  if (!verifySignature(list.signedList, list.signature, key)) throw new MarketError("the revocation list signature does not verify");
  return (JSON.parse(list.signedList) as { entries: Revocation[] }).entries ?? [];
}

/** The cached list when it is fresh enough and still verifies; else null. */
export function cachedRevocations(skillsDir: string, maxAgeMs = REVOCATIONS_MAX_AGE_MS, now = Date.now(), key = registryKey()): { entries: Revocation[]; fetchedAt: number } | null {
  try {
    const raw = JSON.parse(readFileSync(join(skillsDir, REVOCATIONS_FILE), "utf8")) as { list: RevocationList; fetchedAt: number };
    if (now - raw.fetchedAt > maxAgeMs) return null;
    return { entries: verifyRevocations(raw.list, key), fetchedAt: raw.fetchedAt };
  } catch { return null; }
}

export function saveRevocations(skillsDir: string, list: RevocationList, now = Date.now()): void {
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(skillsDir, REVOCATIONS_FILE), JSON.stringify({ list, fetchedAt: now }), { mode: 0o600 });
}

export const isRevoked = (entries: Revocation[], lock: { name: string; version: string; sha256: string }) =>
  entries.some(r => r.name === lock.name && (r.version === lock.version || r.sha256 === lock.sha256));

/** Mark revoked installs (their lock gets `revoked`); returns the names newly revoked. */
export function applyRevocations(skillsDir: string, entries: Revocation[], now = () => new Date()): string[] {
  const hit: string[] = [];
  for (const [name, lock] of installed(skillsDir)) {
    if (lock.revoked || !isRevoked(entries, lock)) continue;
    const reason = entries.find(r => r.name === lock.name && (r.version === lock.version || r.sha256 === lock.sha256))!.reason;
    writeFileSync(join(skillsDir, name, LOCK_FILE), `${JSON.stringify({ ...lock, revoked: { reason, at: now().toISOString() } }, null, 2)}\n`, { mode: 0o600 });
    hit.push(name);
  }
  return hit;
}

export interface RevocationDeps {
  skillsDir: string;
  fetchList(): Promise<RevocationList>;
  store: { listCompanies(): Array<{ id: string }>; listAgents(companyId: string): Array<{ id: string; name: string }>; agentSkills(agentId: string): string[]; setAgentSkills(agentId: string, skills: string[]): void };
  notify(title: string, body: string): void;
  key?: string;
}

/**
 * The daemon's daily check: fetch and verify the signed list, mark revoked installs, take
 * them off every agent and tell the user. A list that does not verify changes nothing.
 */
export async function refreshRevocations(d: RevocationDeps): Promise<string[]> {
  const key = d.key ?? registryKey();
  if (!key) return [];
  const list = await d.fetchList();
  const entries = verifyRevocations(list, key);
  saveRevocations(d.skillsDir, list);
  const revoked = applyRevocations(d.skillsDir, entries);
  if (!revoked.length) return revoked;
  for (const company of d.store.listCompanies()) {
    for (const agent of d.store.listAgents(company.id)) {
      const skills = d.store.agentSkills(agent.id);
      if (skills.some(s => revoked.includes(s))) d.store.setAgentSkills(agent.id, skills.filter(s => !revoked.includes(s)));
    }
  }
  try { d.notify("Skill revoked", `${revoked.join(", ")}: switched off and removed from your agents. Delete with braavo skills remove.`); } catch { /* best effort */ }
  return revoked;
}

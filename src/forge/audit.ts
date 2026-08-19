/**
 * `braavo audit verify` (BR-P1-002, roadmap §5.2: "audit verify evidence hash
 * zincirini LOKAL doğrulasın").
 *
 * Local by design. An audit trail the server validates on your behalf proves
 * nothing about the server — the point is that a client can recompute the chain
 * independently.
 */
import { createHash } from "node:crypto";

export interface ChainResult {
  ok: boolean;
  checked: number;
  brokenAt?: string;
  reason?: string;
}

interface ChainRecord {
  id?: string;
  previousHash?: string | null;
  currentHash?: string | null;
  [k: string]: unknown;
}

/** The digest the chain commits to: the record's content plus its predecessor. */
export function computeRecordHash(record: ChainRecord): string {
  const { currentHash: _c, ...rest } = record;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/**
 * Verify an evidence hash chain.
 *
 * Returns a result rather than throwing so `--json` can report the break point
 * to a machine. A payload carrying NO chain fields is reported as ok:false with
 * an explicit reason — silently returning "ok" for data that was never chained
 * would be the worst possible answer, because it reads as a passing audit.
 */
export function verifyEvidenceChain(payload: unknown): ChainResult {
  const records = extractRecords(payload);
  if (!records.length) {
    return { ok: false, checked: 0, reason: "no chained records found in the response — nothing was verified" };
  }
  let previous: string | null = null;
  let checked = 0;
  for (const r of records) {
    const id = String(r.id ?? `#${checked}`);
    if (!r.currentHash) {
      return { ok: false, checked, brokenAt: id, reason: "record has no currentHash" };
    }
    if (previous !== null && r.previousHash !== previous) {
      return {
        ok: false,
        checked,
        brokenAt: id,
        reason: `previousHash ${String(r.previousHash)} does not match the prior record's hash ${previous}`,
      };
    }
    const recomputed = computeRecordHash(r);
    if (recomputed !== r.currentHash) {
      return { ok: false, checked, brokenAt: id, reason: `content hash mismatch (recomputed ${recomputed.slice(0, 12)}…)` };
    }
    previous = r.currentHash;
    checked++;
  }
  return { ok: true, checked };
}

function extractRecords(payload: unknown): ChainRecord[] {
  if (Array.isArray(payload)) return payload.filter(isChained);
  if (payload && typeof payload === "object") {
    for (const key of ["events", "records", "activity", "steps", "auditEvents"]) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v.filter(isChained);
    }
  }
  return [];
}

function isChained(x: unknown): x is ChainRecord {
  return !!x && typeof x === "object" && ("currentHash" in x || "previousHash" in x);
}

import { describe, it, expect } from "vitest";
import { verifyEvidenceChain, computeRecordHash } from "../audit";

/**
 * BR-P1-002 — `braavo audit verify` (roadmap §5.2: "audit verify evidence hash
 * zincirini LOKAL doğrulasın").
 *
 * Local verification is the whole point: an audit trail the SERVER validates on
 * your behalf proves nothing about the server. A client has to be able to
 * recompute the chain independently.
 */
function chain(n: number, mutate?: (recs: any[]) => void): any[] {
  const recs: any[] = [];
  let previousHash: string | null = null;
  for (let i = 0; i < n; i++) {
    const r: any = { id: `r${i}`, action: `act-${i}`, previousHash };
    r.currentHash = computeRecordHash(r);
    previousHash = r.currentHash;
    recs.push(r);
  }
  mutate?.(recs);
  return recs;
}

describe("verifyEvidenceChain", () => {
  it("accepts an intact chain", () => {
    expect(verifyEvidenceChain({ events: chain(4) })).toEqual({ ok: true, checked: 4 });
  });

  it("accepts a bare array as well as a wrapped payload", () => {
    expect(verifyEvidenceChain(chain(2)).ok).toBe(true);
    expect(verifyEvidenceChain({ records: chain(2) }).ok).toBe(true);
    expect(verifyEvidenceChain({ activity: chain(2) }).ok).toBe(true);
  });

  it("detects TAMPERED CONTENT — the case the chain exists for", () => {
    // Someone edits an audit record after the fact but leaves the hashes alone.
    const recs = chain(4, (r) => { r[2].action = "quietly-changed"; });
    const res = verifyEvidenceChain({ events: recs });
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe("r2");
    expect(res.reason).toMatch(/content hash mismatch/);
  });

  it("detects a BROKEN LINK — a record removed from the middle", () => {
    const recs = chain(4);
    recs.splice(2, 1); // drop r2; r3.previousHash now points at a missing record
    const res = verifyEvidenceChain({ events: recs });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/does not match the prior record/);
  });

  it("detects a record with no hash at all", () => {
    const recs = chain(3);
    delete recs[1].currentHash;
    const res = verifyEvidenceChain({ events: recs });
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe("r1");
  });

  it("reports ok:FALSE when there is nothing chained to verify", () => {
    // The most dangerous possible answer here would be a cheerful "ok" for a
    // payload that was never chained — it reads as a passing audit when in fact
    // nothing was checked.
    for (const empty of [{}, { events: [] }, [], { events: [{ id: "x" }] }]) {
      const res = verifyEvidenceChain(empty);
      expect(res.ok, `${JSON.stringify(empty)} must not report ok`).toBe(false);
      expect(res.checked).toBe(0);
      expect(res.reason).toMatch(/nothing was verified/);
    }
  });

  it("reports how many records it actually checked", () => {
    expect(verifyEvidenceChain({ events: chain(7) }).checked).toBe(7);
  });

  it("hashing ignores currentHash itself (or no chain could ever verify)", () => {
    const r: any = { id: "a", action: "x", previousHash: null };
    const h = computeRecordHash(r);
    r.currentHash = h;
    expect(computeRecordHash(r)).toBe(h);
  });
});

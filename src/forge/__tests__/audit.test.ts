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

function anchor(recs: any[]) {
  return {
    count: recs.length,
    genesisHash: recs[0].currentHash,
    headHash: recs.at(-1).currentHash,
  };
}

describe("verifyEvidenceChain", () => {
  it("accepts an intact chain", () => {
    const recs = chain(4);
    expect(verifyEvidenceChain({ events: recs }, anchor(recs))).toEqual({ ok: true, checked: 4 });
  });

  it("labels an unanchored chain only as internally consistent, never complete", () => {
    for (const payload of [chain(2), { records: chain(2) }, { activity: chain(2) }]) {
      expect(verifyEvidenceChain(payload)).toMatchObject({
        ok: false,
        subsetConsistent: true,
        checked: 2,
      });
    }
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

  it("rejects an internally consistent missing prefix against the trusted anchor", () => {
    const original = chain(5);
    const truncated = original.slice(2);
    truncated[0] = { ...truncated[0], previousHash: null };
    truncated[0].currentHash = computeRecordHash(truncated[0]);
    for (let i = 1; i < truncated.length; i++) {
      truncated[i] = { ...truncated[i], previousHash: truncated[i - 1].currentHash };
      truncated[i].currentHash = computeRecordHash(truncated[i]);
    }
    const result = verifyEvidenceChain({ events: truncated }, anchor(original));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/count|genesis/);
  });

  it("rejects an internally consistent missing tail against the trusted anchor", () => {
    const original = chain(5);
    const result = verifyEvidenceChain({ events: original.slice(0, 3) }, anchor(original));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/count|head/);
  });

  it("rejects a malformed trusted anchor", () => {
    const recs = chain(2);
    expect(verifyEvidenceChain({ events: recs }, {
      count: 2, genesisHash: "not-a-hash", headHash: recs.at(-1).currentHash,
    }).reason).toMatch(/malformed/);
  });

  it("hashing ignores currentHash itself (or no chain could ever verify)", () => {
    const r: any = { id: "a", action: "x", previousHash: null };
    const h = computeRecordHash(r);
    r.currentHash = h;
    expect(computeRecordHash(r)).toBe(h);
  });
});

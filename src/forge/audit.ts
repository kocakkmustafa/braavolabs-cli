/**
 * `braavo audit verify` (BR-P1-002, roadmap §5.2: "audit verify evidence hash
 * zincirini LOKAL doğrulasın").
 *
 * Local by design. An audit trail the server validates on your behalf proves
 * nothing about the server — the point is that a client can recompute the chain
 * independently.
 */
import { createHash } from "node:crypto";
import { t, numberText } from "./locale";

export interface ChainResult {
  ok: boolean;
  checked: number;
  subsetConsistent?: boolean;
  brokenAt?: string;
  reason?: string;
}

export interface TrustedChainAnchor {
  count: number;
  genesisHash: string;
  headHash: string;
}

/** Authored local diagnostics only; ChainResult and --json remain unchanged. */
export function humanChainReason(result: ChainResult): string {
  const reason = result.reason ?? "";
  const previous = /^previousHash (.+) does not match the prior record's hash (.+)$/.exec(reason);
  if (previous) return t("previousHash {0} does not match the prior record's hash {1}", previous[1], previous[2]);
  const content = /^content hash mismatch \(recomputed (.+)\)$/.exec(reason);
  if (content) return t("content hash mismatch (recomputed {0})", content[1]);
  const count = /^trusted count (\d+) does not match response count (\d+)$/.exec(reason);
  if (count) return t("trusted count {0} does not match response count {1}", numberText(count[1]), numberText(count[2]));
  return t(reason);
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
export function verifyEvidenceChain(payload: unknown, anchor?: TrustedChainAnchor): ChainResult {
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
    if (checked === 0 && r.previousHash !== null) {
      return {
        ok: false,
        checked,
        brokenAt: id,
        reason: "first record is not a genesis record (previousHash must be null)",
      };
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

  if (!anchor) {
    return {
      ok: false,
      checked,
      subsetConsistent: true,
      reason: "records are internally consistent, but completeness is unverified without a trusted count/genesis/head anchor",
    };
  }
  if (!Number.isSafeInteger(anchor.count) || anchor.count < 1 ||
      !/^[a-f0-9]{64}$/i.test(anchor.genesisHash) || !/^[a-f0-9]{64}$/i.test(anchor.headHash)) {
    return { ok: false, checked, subsetConsistent: true, reason: "trusted anchor is malformed" };
  }
  if (anchor.count !== records.length) {
    return {
      ok: false,
      checked,
      subsetConsistent: true,
      reason: `trusted count ${anchor.count} does not match response count ${records.length}`,
    };
  }
  if (records[0]!.currentHash !== anchor.genesisHash) {
    return { ok: false, checked, subsetConsistent: true, reason: "trusted genesis hash does not match the first record" };
  }
  if (records.at(-1)!.currentHash !== anchor.headHash) {
    return { ok: false, checked, subsetConsistent: true, reason: "trusted head hash does not match the last record" };
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

/**
 * Relay control-plane contract — CLI-side MIRROR of the sealed Dilim 1
 * (braavolabs monorepo, `packages/api/src/modules/relay/protocol.ts`) and a
 * near-verbatim port of the Desktop app's own mirror (Companion channel
 * Dilim 2a, sealed — `packages/desktop/src/relay-protocol.ts`). `braavo`
 * cannot import monorepo OR desktop code (three separate repos, three
 * separate deploys), so this contract is duplicated deliberately and kept in
 * lockstep across all three — same discipline, same bounds, same redaction
 * rules, byte-for-byte where the surface allows it.
 *
 * Two message families, each a zod discriminated union on `type`:
 *
 *   SessionEvent    — this LOCAL session → companion (status/output/approvals/audit)
 *   ControlCommand  — companion → this LOCAL session (steer/approve/reject/kill)
 *
 * Naming note (same as the server contract): `SessionEvent`'s
 * "approval-request" variant carries its OWN `kind` field (the governed
 * action's kind, e.g. "browser.navigate"). To avoid colliding with that inner
 * field, the union's OUTER discriminant is named `type`. NOTE: `braavo` has
 * no local governance gate of its own (see relay-bridge.ts's header) — this
 * variant is carried for contract parity with Desktop/server, but nothing in
 * the CLI currently emits it; a future braavo feature with its own approval
 * surface could.
 *
 * REDACTION RULE: this contract never intentionally carries a raw secret.
 * Free-text fields (dialogText / summary / decoded output / label / cwd) are
 * bounded AND passed through `redact()` — see redactSessionEventInput below.
 * The server (bus.ts) redacts again independently; this is DEFENSE IN DEPTH
 * so a raw secret never goes out over the wire from this process in the
 * first place, not a substitute for the server-side guarantee. This matters
 * MOST for `braavo spawn --bridge`: the mirrored `output` events are the
 * vendor CLI's own stdout/stderr, which the CLI itself never inspects for
 * secrets otherwise (see spawn.ts's opaque-passthrough contract) — the relay
 * mirror is the ONE place that output gets scanned at all.
 *
 * EXCEPTION — structured/round-tripped identifiers: `approval-request`'s
 * `actionId`/`kind` and `approve`/`reject`'s `actionId` are NOT passed
 * through the general `redact()` (which would corrupt a UUID/hex-shaped id
 * and silently break the approve/reject round-trip). They get the narrower
 * `redactStructuredId()` instead — see its doc comment.
 *
 * SURFACE NOTE: `SessionRegistration.surface` carries all three of
 * "cli"|"desktop"|"web" (server's Dilim 1 contract) so this one mirror stays
 * usable regardless of which surface registers — `braavo` itself only ever
 * registers as "cli".
 */
import { z } from "zod";

// ─── Bounds ─────────────────────────────────────────────────────────────
// Mirrors the server contract's bounds exactly (protocol.ts) so a message
// this client builds can never be rejected by the server's own zod parse.
export const MAX_TEXT_LEN = 4000;
export const MAX_OUTPUT_B64_LEN = 200_000;
export const MAX_ACTION_ID_LEN = 200;
export const MAX_ACTION_KIND_LEN = 120;
export const MAX_LABEL_LEN = 200;
export const MAX_CWD_LEN = 1024;

// ─── Redaction ──────────────────────────────────────────────────────────
// Defense-in-depth BACKSTOP, NOT the primary guarantee. The primary
// guarantee is upstream discipline: `output` is bounded (MAX_OUTPUT_B64_LEN)
// and everything else here is already a short human summary, not a raw
// secret dump — this contract should never be HANDED a secret in the first
// place. `redact()` below is the last line of defense for the cases that
// discipline misses. Three simple, cheap patterns:
//   - `sk-...` style provider API key prefixes
//   - `Bearer <opaque>` authorization-header-shaped tokens
//   - long (>=32 char) opaque runs — alnum/[-_.] (JWT/hex-secret shaped) OR
//     standard base64 alphabet (+, /, = — the char class deliberately
//     INCLUDES +/=/ so a standard-base64-encoded secret does not split into
//     sub-32-char alnum runs at each `+`/`/` and pass through unredacted;
//     base64url's `-`/`_` are covered too) — same fix the Desktop mirror
//     carries (adversarial review P2-1).
// This will over-redact some legitimate long identifiers (hashes, commit
// SHAs) — an acceptable false-positive rate for a mirrored, human-readable
// audit/approval feed where under-redaction is the far worse failure mode.
//
// KNOWN, ACCEPTED GAPS (this is a backstop, not a guarantee — do not try to
// "fix" these here, tighten the upstream discipline instead):
//   - a secret SHORTER than 32 chars is not caught by this pattern
//   - a secret split across multiple `emitOutput()` calls (i.e. dribbled a
//     few bytes at a time across separate chunks/events) is not caught —
//     redaction runs per-event, not across a stream. For `braavo spawn
//     --bridge`, each TEE'd chunk of vendor stdout/stderr is its own event —
//     a secret split across a chunk boundary by the OS pipe buffer has the
//     same gap.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /(?<![A-Za-z0-9+\/=._-])[A-Za-z0-9+\/=._-]{32,}(?![A-Za-z0-9+\/=._-])/g,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "«redacted»");
  }
  return out;
}

// Narrower pass for STRUCTURED IDENTIFIERS that must remain functional after
// redaction: `approval-request.actionId`/`.kind` and `approve`/`reject`
// commands' `actionId` round-trip. Those ids are commonly UUID/hex-shaped
// (>=32 chars) and would be destroyed by the generic long-opaque-token rule
// in `redact()`, silently breaking the approval flow (worse than the
// redaction gap it would "fix"). So structured ids only pass through the
// sk-/Bearer patterns.
const STRUCTURED_ID_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi,
];

export function redactStructuredId(text: string): string {
  let out = text;
  for (const pattern of STRUCTURED_ID_PATTERNS) {
    out = out.replace(pattern, "«redacted»");
  }
  return out;
}

// ─── SessionRegistration ────────────────────────────────────────────────
export const SURFACES = ["cli", "desktop", "web"] as const;
export type Surface = (typeof SURFACES)[number];

export const SessionRegistrationSchema = z.object({
  surface: z.enum(SURFACES),
  label: z.string().trim().min(1).max(MAX_LABEL_LEN).optional(),
  cwd: z.string().trim().min(1).max(MAX_CWD_LEN).optional(),
});
export type SessionRegistration = z.infer<typeof SessionRegistrationSchema>;

// ─── SessionEvent (this LOCAL session → companion) ─────────────────────
// Governed-action approval mirror. `kind` here is the governed action's OWN
// kind (e.g. "browser.navigate"), unrelated to the outer union discriminant.
// braavo has no local gate that produces these today (see relay-bridge.ts) —
// carried for contract parity only.
export const ApprovalRequestEventSchema = z.object({
  type: z.literal("approval-request"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
  kind: z.string().trim().min(1).max(MAX_ACTION_KIND_LEN),
  dialogText: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

// Redacted turn summary — never the raw transcript.
export const AgentTurnEventSchema = z.object({
  type: z.literal("agent-turn"),
  summary: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

// Terminal/agent output, base64-encoded and bounded. For `braavo spawn
// --bridge` this is the TEE'd vendor stdout/stderr chunk.
export const OutputEventSchema = z.object({
  type: z.literal("output"),
  textB64: z.string().min(1).max(MAX_OUTPUT_B64_LEN),
});

// Audit ledger line mirror — redacted summary, never raw ledger payload.
export const AuditEventSchema = z.object({
  type: z.literal("audit"),
  summary: z.string().trim().min(1).max(MAX_TEXT_LEN),
});

export const SESSION_STATES = ["running", "idle", "ended"] as const;
export type SessionEventState = (typeof SESSION_STATES)[number];

export const StatusEventSchema = z.object({
  type: z.literal("status"),
  state: z.enum(SESSION_STATES),
});

export const SessionEventInputSchema = z.discriminatedUnion("type", [
  ApprovalRequestEventSchema,
  AgentTurnEventSchema,
  OutputEventSchema,
  AuditEventSchema,
  StatusEventSchema,
]);
/** What this LOCAL session posts — no envelope yet (server assigns it). */
export type SessionEventInput = z.infer<typeof SessionEventInputSchema>;

/** What the companion receives — input + server-assigned envelope. This
 * client never has to construct one (the server does); the type exists for
 * completeness/documentation parity with the server contract. */
export type SessionEvent = SessionEventInput & {
  sessionId: string;
  seq: number;
  ts: string;
};

/**
 * Apply the redaction rule to a parsed SessionEventInput's free-text
 * fields BEFORE it is handed to the transport — the client-side half of
 * defense-in-depth (the server redacts again independently in bus.ts).
 * `output` is base64 — decoded, redacted, and re-encoded so the pattern
 * match runs against the actual text, not its base64 encoding. Malformed
 * base64 is treated conservatively (replaced wholesale) rather than left
 * un-redacted.
 */
export function redactSessionEventInput(ev: SessionEventInput): SessionEventInput {
  switch (ev.type) {
    case "approval-request":
      // actionId/kind: structured-id pass (round-trip safety, see
      // redactStructuredId doc). dialogText: full redaction (free text).
      return {
        ...ev,
        actionId: redactStructuredId(ev.actionId),
        kind: redactStructuredId(ev.kind),
        dialogText: redact(ev.dialogText),
      };
    case "agent-turn":
      return { ...ev, summary: redact(ev.summary) };
    case "audit":
      return { ...ev, summary: redact(ev.summary) };
    case "output": {
      let decoded: string;
      try {
        decoded = base64Decode(ev.textB64);
      } catch {
        return { ...ev, textB64: base64Encode("«unreadable output»") };
      }
      return { ...ev, textB64: base64Encode(redact(decoded)) };
    }
    case "status":
      return ev; // no free text to redact
  }
}

// base64 helpers that work in BOTH a browser-shaped runtime (no Buffer) and
// the Vitest/Node test runner + the real `braavo` Node process (no atob/btoa
// without a shim) — mirrors the Desktop mirror's discipline of not assuming
// either global is present, even though `braavo` itself always runs on Node
// (Buffer is always available here; the atob/btoa branch is dead code on
// this specific runtime but kept for contract-parity with the other two
// mirrors and in case a future bundled/browser braavo surface needs it).
function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === "function") {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64Decode(b64: string): string {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, "base64").toString("utf8");
}

// ─── ControlCommand (companion → this LOCAL session) ───────────────────
export const SteerCommandSchema = z.object({
  type: z.literal("steer"),
  message: z.string().trim().min(1).max(MAX_TEXT_LEN),
});
export const ApproveCommandSchema = z.object({
  type: z.literal("approve"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
});
export const RejectCommandSchema = z.object({
  type: z.literal("reject"),
  actionId: z.string().trim().min(1).max(MAX_ACTION_ID_LEN),
});
export const KillCommandSchema = z.object({
  type: z.literal("kill"),
});

export const ControlCommandSchema = z.discriminatedUnion("type", [
  SteerCommandSchema,
  ApproveCommandSchema,
  RejectCommandSchema,
  KillCommandSchema,
]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

/** What this LOCAL session receives — command + server-assigned envelope. */
export type ControlCommandMessage = ControlCommand & {
  sessionId: string;
  seq: number;
  ts: string;
};

/**
 * Symmetric redaction pass for an INCOMING command — defense-in-depth for
 * whatever this session logs/mirrors locally from a companion command (the
 * server already redacts outbound in bus.ts; this is the client-side
 * backstop, same rationale as redactSessionEventInput above). `steer.message`
 * is free text → full redaction (this is the message `braavo spawn --bridge`
 * writes verbatim into the vendor CLI's stdin — see spawn.ts — so a redacted
 * echo here is purely for whatever this session logs locally, NOT a
 * modification of what gets sent to the child). `approve`/`reject`'s
 * `actionId` is a structured, round-tripped identifier → structured-id pass
 * only. `kill` carries no payload.
 */
export function redactControlCommand(cmd: ControlCommand): ControlCommand {
  if (cmd.type === "steer") {
    return { ...cmd, message: redact(cmd.message) };
  }
  if (cmd.type === "approve" || cmd.type === "reject") {
    return { ...cmd, actionId: redactStructuredId(cmd.actionId) };
  }
  return cmd;
}

import { describe, it, expect } from "vitest";
import {
  redact,
  redactStructuredId,
  redactSessionEventInput,
  redactControlCommand,
  SessionRegistrationSchema,
  SessionEventInputSchema,
  ControlCommandSchema,
  MAX_TEXT_LEN,
  type SessionEventInput,
} from "../relay-protocol";

const SECRET_KEY = "sk-ant-SUPERSECRET0123456789abcdef0123456789";
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz012345";
const LONG_OPAQUE = "a".repeat(40); // >=32 chars, no sk-/Bearer prefix

describe("redact — free-text backstop", () => {
  it("redacts sk-, Bearer, and long opaque tokens", () => {
    expect(redact(`key=${SECRET_KEY}`)).toContain("«redacted»");
    expect(redact(`key=${SECRET_KEY}`)).not.toContain(SECRET_KEY);
    expect(redact(`auth: ${BEARER}`)).not.toContain(BEARER);
    expect(redact(`token=${LONG_OPAQUE}`)).not.toContain(LONG_OPAQUE);
  });

  it("leaves ordinary short text untouched", () => {
    expect(redact("navigate to bank.example and click submit")).toBe(
      "navigate to bank.example and click submit",
    );
  });
});

describe("redactStructuredId — narrow pass for round-tripped ids", () => {
  it("preserves a long opaque id (UUID/hex-shaped actionId) untouched", () => {
    const actionId = "act_" + "f".repeat(40);
    expect(redactStructuredId(actionId)).toBe(actionId);
  });

  it("still strips sk-/Bearer patterns even from a structured id field", () => {
    expect(redactStructuredId(SECRET_KEY)).not.toContain(SECRET_KEY);
    expect(redactStructuredId(BEARER)).not.toContain(BEARER);
  });
});

describe("redactSessionEventInput", () => {
  it("redacts approval-request dialogText but round-trips actionId/kind", () => {
    const actionId = "act_" + "1".repeat(40);
    const kind = "browser.navigate";
    const ev: SessionEventInput = {
      type: "approval-request",
      actionId,
      kind,
      dialogText: `approve navigating with token ${LONG_OPAQUE}?`,
    };
    const out = redactSessionEventInput(ev);
    expect(out.type).toBe("approval-request");
    if (out.type !== "approval-request") throw new Error("unreachable");
    expect(out.actionId).toBe(actionId); // round-trip preserved
    expect(out.kind).toBe(kind); // round-trip preserved
    expect(out.dialogText).not.toContain(LONG_OPAQUE);
    expect(out.dialogText).toContain("«redacted»");
  });

  it("redacts agent-turn and audit summaries", () => {
    const turn = redactSessionEventInput({ type: "agent-turn", summary: `did X with ${SECRET_KEY}` });
    if (turn.type !== "agent-turn") throw new Error("unreachable");
    expect(turn.summary).not.toContain(SECRET_KEY);

    const audit = redactSessionEventInput({ type: "audit", summary: `granted ${BEARER}` });
    if (audit.type !== "audit") throw new Error("unreachable");
    expect(audit.summary).not.toContain(BEARER);
  });

  it("decodes, redacts, and re-encodes base64 output (the spawn --bridge TEE path)", () => {
    const raw = `vendor stdout: here is a secret: ${SECRET_KEY}`;
    const textB64 = Buffer.from(raw, "utf8").toString("base64");
    const out = redactSessionEventInput({ type: "output", textB64 });
    if (out.type !== "output") throw new Error("unreachable");
    const decoded = Buffer.from(out.textB64, "base64").toString("utf8");
    expect(decoded).not.toContain(SECRET_KEY);
    expect(decoded).toContain("«redacted»");
  });

  it("treats malformed base64 conservatively (never leaks raw bytes as-is)", () => {
    const out = redactSessionEventInput({ type: "output", textB64: "%%%not-base64%%%" });
    if (out.type !== "output") throw new Error("unreachable");
    expect(out.textB64).toBeTypeOf("string");
  });

  it("status has no free text — passes through unchanged", () => {
    const ev: SessionEventInput = { type: "status", state: "running" };
    expect(redactSessionEventInput(ev)).toEqual(ev);
  });
});

describe("redactControlCommand", () => {
  it("redacts steer.message", () => {
    const out = redactControlCommand({ type: "steer", message: `use key ${SECRET_KEY}` });
    if (out.type !== "steer") throw new Error("unreachable");
    expect(out.message).not.toContain(SECRET_KEY);
  });

  it("round-trips approve/reject actionId", () => {
    const actionId = "act_" + "2".repeat(40);
    const approved = redactControlCommand({ type: "approve", actionId });
    if (approved.type !== "approve") throw new Error("unreachable");
    expect(approved.actionId).toBe(actionId);

    const rejected = redactControlCommand({ type: "reject", actionId });
    if (rejected.type !== "reject") throw new Error("unreachable");
    expect(rejected.actionId).toBe(actionId);
  });

  it("kill carries no payload — passes through", () => {
    expect(redactControlCommand({ type: "kill" })).toEqual({ type: "kill" });
  });
});

describe("SessionRegistrationSchema", () => {
  it("accepts all three surfaces (cli/desktop/web)", () => {
    for (const surface of ["cli", "desktop", "web"] as const) {
      expect(SessionRegistrationSchema.safeParse({ surface }).success).toBe(true);
    }
  });

  it("rejects an unknown surface", () => {
    expect(SessionRegistrationSchema.safeParse({ surface: "android" }).success).toBe(false);
  });

  it("accepts optional label/cwd within bounds, rejects over-bound", () => {
    expect(SessionRegistrationSchema.safeParse({ surface: "cli", label: "braavo spawn claude", cwd: "/Users/x" }).success).toBe(true);
    expect(SessionRegistrationSchema.safeParse({ surface: "cli", label: "a".repeat(300) }).success).toBe(false);
  });
});

describe("SessionEventInputSchema", () => {
  it("parses each variant", () => {
    expect(SessionEventInputSchema.safeParse({ type: "approval-request", actionId: "a", kind: "k", dialogText: "d" }).success).toBe(true);
    expect(SessionEventInputSchema.safeParse({ type: "agent-turn", summary: "s" }).success).toBe(true);
    expect(SessionEventInputSchema.safeParse({ type: "output", textB64: "aGk=" }).success).toBe(true);
    expect(SessionEventInputSchema.safeParse({ type: "audit", summary: "s" }).success).toBe(true);
    expect(SessionEventInputSchema.safeParse({ type: "status", state: "idle" }).success).toBe(true);
  });

  it("rejects an unrecognized type and enforces the text-length bound", () => {
    expect(SessionEventInputSchema.safeParse({ type: "not-a-real-type" }).success).toBe(false);
    expect(
      SessionEventInputSchema.safeParse({ type: "audit", summary: "x".repeat(MAX_TEXT_LEN + 1) }).success,
    ).toBe(false);
  });
});

describe("ControlCommandSchema", () => {
  it("parses each variant", () => {
    expect(ControlCommandSchema.safeParse({ type: "steer", message: "go left" }).success).toBe(true);
    expect(ControlCommandSchema.safeParse({ type: "approve", actionId: "a" }).success).toBe(true);
    expect(ControlCommandSchema.safeParse({ type: "reject", actionId: "a" }).success).toBe(true);
    expect(ControlCommandSchema.safeParse({ type: "kill" }).success).toBe(true);
  });

  it("rejects an unknown/malformed command", () => {
    expect(ControlCommandSchema.safeParse({ type: "teleport" }).success).toBe(false);
    expect(ControlCommandSchema.safeParse({ type: "steer" }).success).toBe(false); // missing message
    expect(ControlCommandSchema.safeParse(null).success).toBe(false);
    expect(ControlCommandSchema.safeParse("just a string").success).toBe(false);
  });
});

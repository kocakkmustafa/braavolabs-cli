import { describe, expect, it } from "vitest";
import { parseApprovalDecision } from "../approvalDecision";

describe("approval decision wire contract", () => {
  it.each([undefined, false, true])("preserves explicit claimFailed=%s without inferring run or ledger status", claimFailed => {
    const result = parseApprovalDecision({ success: true, decision: "APPROVED", claimFailed, error: " not frozen " }, "APPROVED");
    expect(result.claimFailed).toBe(claimFailed); expect(result.error).toBe("not frozen");
  });
  it.each([undefined, null, 123, " "])("a failed handoff with unavailable error detail=%s remains a failed handoff", error => {
    expect(parseApprovalDecision({ success: true, decision: "APPROVED", claimFailed: true, error }, "APPROVED")).toEqual({ success: true, decision: "APPROVED", claimFailed: true });
  });
  it.each([null, [], {}, { success: false, decision: "APPROVED" }, { success: true, decision: "REJECTED" }, { success: true, decision: "APPROVED", claimFailed: "true" }])("rejects malformed or mismatched success %j", result => {
    expect(() => parseApprovalDecision(result, "APPROVED")).toThrow("Invalid approval decision response");
  });
  it("a rejected decision cannot claim to have approved a handoff", () => {
    expect(() => parseApprovalDecision({ success: true, decision: "REJECTED", claimFailed: true }, "REJECTED")).toThrow();
  });
});

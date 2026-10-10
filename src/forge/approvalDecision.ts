export type ApprovalDecision = "APPROVED" | "REJECTED";

/** The decision can commit even when the subsequent handoff does not finish. */
export interface ApprovalDecisionOutcome {
  success: true;
  decision: ApprovalDecision;
  claimFailed?: boolean;
  error?: string;
}

export function parseApprovalDecision(value: unknown, expected: ApprovalDecision): ApprovalDecisionOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid approval decision response.");
  }
  const result = value as Record<string, unknown>;
  if (result.success !== true || result.decision !== expected ||
      (result.claimFailed !== undefined && typeof result.claimFailed !== "boolean") ||
      (result.claimFailed === true && expected !== "APPROVED")) {
    throw new Error("Invalid approval decision response.");
  }
  return {
    success: true,
    decision: expected,
    ...(result.claimFailed === undefined ? {} : { claimFailed: result.claimFailed as boolean }),
    ...(typeof result.error === "string" && result.error.trim() ? { error: result.error.trim() } : {}),
  };
}

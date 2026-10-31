import type { DaemonStore } from "./store";
import { collectStream } from "../core/stream";
import { DEFAULT_INFERENCE_TIMEOUT_MS } from "../forge/request-scope";
import { effortNote, prepareCall, redact, type ProviderDeps } from "./provider";
/**
 * Routine runner: one due routine → one model call for its agent (./provider).
 * The result lands in the daemon's own SQLite (conversation + messages for
 * search, cost event, activity).
 *
 * Not yet: tools/agent loop, preflight checks (only `{"type":"none"}` runs),
 * per-model USD pricing (cost events carry tokens, usd stays 0).
 */

export interface RunnerDeps extends ProviderDeps {
  timeoutMs?: number;
}

export interface RunResult { outcome: string; note?: string }

export async function runRoutine(store: DaemonStore, routineId: string, deps: RunnerDeps): Promise<RunResult> {
  const routine = store.getRoutine(routineId);
  if (!routine) return { outcome: "failed", note: "routine not found" };
  const agent = store.getAgent(routine.agent_id);
  if (!agent) return { outcome: "failed", note: "agent not found" };

  let preflight: { type?: unknown };
  try { preflight = JSON.parse(routine.preflight); } catch { preflight = {}; }
  if (preflight.type !== "none") return { outcome: "skipped-preflight-unsupported", note: `preflight ${String(preflight.type)} not implemented` };

  const call = prepareCall({ provider: agent.provider, model: agent.model, effort: agent.effort, effortRounding: agent.effort_rounding }, deps);
  if (!call.ok) return { outcome: "failed", note: call.message };
  const provider = agent.provider;

  const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS);
  let result: Awaited<ReturnType<typeof collectStream>>;
  try {
    result = await collectStream(call.stream({ system: agent.system_prompt || undefined, messages: [{ role: "user", content: routine.prompt }] }, signal));
  } catch (error) {
    return { outcome: "failed", note: redact(error instanceof Error ? error.message : String(error), call.apiKey) };
  }

  const conversationId = store.createConversation({ companyId: routine.company_id, agentId: agent.id, title: routine.name });
  store.addMessage(conversationId, "user", routine.prompt);
  store.addMessage(conversationId, "assistant", result.text);
  store.recordCost({ companyId: routine.company_id, agentId: agent.id, runId: conversationId, provider, model: agent.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  store.activity({ companyId: routine.company_id, actor: agent.id, verb: "ran-routine", objectType: "routine", objectId: routine.id, summary: routine.name });

  const note = [conversationId, `${result.inputTokens}/${result.outputTokens} tokens`, result.stopReason !== "end_turn" ? `stop ${result.stopReason}` : undefined, effortNote(call.effort)]
    .filter(Boolean).join(" · ");
  return { outcome: "ran", note };
}

// A minimal ACP agent for tests: speaks JSON-RPC on stdio like `gemini --acp`.
// SCENARIO: "work" (default) · "crash" (exits during the prompt) · "silent" (never answers the prompt) · "auth" (needs authenticate first).
const scenario = process.env.FAKE_ACP_SCENARIO || "work";
let buffer = "";
let nextId = 1000;
let signedIn = scenario !== "auth";
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const ask = (sessionId, toolCall) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId, toolCall, options: [
    { optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" },
  ] } });
});

async function prompt(id, params) {
  const s = params.sessionId;
  const text = params.prompt.map((p) => p.text).join("\n");
  process.stderr.write(`prompt received (${text.length} chars)\n`);
  if (scenario === "crash") { process.exit(3); }
  if (scenario === "silent") return;
  update(s, { sessionUpdate: "plan", entries: [{ content: "Read notes", priority: "high", status: "completed" }, { content: "Update notes", priority: "high", status: "pending" }] });
  update(s, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read notes.md", kind: "read", status: "completed", locations: [{ path: "notes.md" }] });
  const edit = await ask(s, { toolCallId: "t2", title: "Edit notes.md", kind: "edit", locations: [{ path: "notes.md" }] });
  if (edit.outcome.optionId === "yes") {
    update(s, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit notes.md", kind: "edit", status: "in_progress", locations: [{ path: "notes.md" }] });
    update(s, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [{ type: "diff", path: "notes.md", oldText: "old", newText: "new line\nsecond" }] });
  }
  const run = await ask(s, { toolCallId: "t3", title: "rm -rf build", kind: "execute" });
  update(s, { sessionUpdate: "tool_call_update", toolCallId: "t3", status: run.outcome.optionId === "yes" ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: run.outcome.optionId === "yes" ? "removed" : "not allowed" } }] });
  const outside = await ask(s, { toolCallId: "t4", title: "Read /etc/hosts", kind: "read", locations: [{ path: "/etc/hosts" }] });
  update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: notes updated" } });
  update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `; outside read ${outside.outcome.optionId === "yes" ? "allowed" : "refused"}.` } });
  send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) { const r = waiting.get(m.id); waiting.delete(m.id); r && r(m.result); continue; }
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "oauth-personal", name: "Google" }, { id: "api-key", name: "Key" }] } });
    else if (m.method === "authenticate") { signedIn = m.params.methodId === "oauth-personal"; send({ jsonrpc: "2.0", id: m.id, result: {} }); }
    else if (m.method === "session/new") send(signedIn ? { jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required" } });
    else if (m.method === "session/prompt") void prompt(m.id, m.params);
    else if (m.method === "session/cancel") process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));

# Daemon chat contract (v1)

Plan items 1.2 (CLI), 1.3 (desktop) and 1.4 (mobile) share one chat engine: the local
daemon (`braavo daemon run`). It owns conversations in `~/.braavo/braavo.db` (SQLite,
FTS5 search) and calls the user's own provider key or local model (K3). Surfaces never
call a provider for daemon chat themselves and never see a key.

Design reference: platform `docs/ai-company/TASARIM.tr.md` §4.3, §9 (branch
`design/ai-company-local`).

## 1. Finding and calling the daemon (CLI, desktop)

- `~/.braavo/daemon/state.json` → `{ pid, port, startedAt, version }` (written when the API listens).
- `~/.braavo/daemon/token` → bearer token (0600). Read it at call time; never copy it into
  localStorage, logs or another file.
- Requests: `http://127.0.0.1:<port>/v1/...`, header `Authorization: Bearer <token>`.
- The daemon **refuses any request carrying an `Origin` header** and any `Host` other than
  `127.0.0.1`/`localhost`. A browser or webview `fetch` therefore cannot reach it: the
  desktop app calls it from the Rust side (Tauri command) and forwards results to the
  webview.
- Errors: JSON `{ "error": string, "code"?: string }` with an HTTP status.

## 2. Endpoints

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/models` | — | `{ providers: [{ id, hasKey, local }], local: { OLLAMA?: string[], LMSTUDIO?: string[] }, suggestions: { strong, mid, light, analysis } }` where each suggestion is `@braavo/core` `ModelSuggestion`. Never key values. |
| `GET /v1/conversations?limit=50&before=<updatedAt>` | — | `{ conversations: Conversation[] }`, newest first |
| `POST /v1/conversations` | `{ title?, provider, model, effort? }` | `201 { conversation }` |
| `GET /v1/conversations/:id` | — | `{ conversation, messages: Message[] }` |
| `PATCH /v1/conversations/:id` | `{ title?, provider?, model?, effort? }` | `{ conversation }` |
| `DELETE /v1/conversations/:id` | — | `204` |
| `POST /v1/conversations/:id/messages` | `{ content }` (≤ 100 000 chars) | `text/event-stream`, see §3 |
| `POST /v1/conversations/:id/abort` | — | `{ aborted: boolean }` |
| `POST /v1/conversations/import` | `{ source, conversations: ImportConversation[] }` | `{ imported, skipped, ids }` |
| `GET /v1/conversations/:id/export?format=md\|json` | — | Markdown (default) or JSON file body with `Content-Disposition` |
| `GET /v1/search?q=&limit=20` | — | `{ results: [{ messageId, conversationId, role, snippet, at }] }` |

```ts
type Conversation = {
  id: string; title: string; provider: string | null; model: string | null; effort: string | null;
  companyId: string | null; agentId: string | null; source: string | null;
  createdAt: string; updatedAt: string; messageCount: number; lastMessage: string | null; // ≤ 200 chars
};
type Message = { id: string; role: "user" | "assistant"; content: string; at: string; stopReason?: string | null };
type ImportConversation = {
  externalId: string;            // stable id from the source (e.g. desktop session id)
  title?: string; provider?: string; model?: string; createdAt?: string;
  messages: { role: "user" | "assistant"; content: string; at?: string }[];
};
```

- `effort` is one of `none | low | medium | high | max`; the daemon maps it per model with the
  `@braavo/core` effort profiles and drops it for unprofiled models.
- Import is idempotent on `(source, externalId)`: re-sending the same conversation is
  `skipped`, never duplicated. Clear the source copy only after a successful response.
  `ids` follows the request order and includes skipped conversations. The import body may
  be up to 16 MiB (other requests: 256 KiB); only `user` and `assistant` messages are kept.
- `GET /v1/events` (existing SSE stream) also carries
  `conversation.changed { conversationId }` whenever a conversation is created, renamed,
  deleted or gets a message, so other open surfaces can refresh.

## 3. Streaming a turn

`POST /v1/conversations/:id/messages` stores the user message first, then streams:

```
event: message    data: {"id":"ms_…","role":"user"}
event: delta      data: {"text":"…"}            (repeated)
event: reasoning  data: {"text":"…"}            (optional, repeated; not stored)
event: usage      data: {"inputTokens":n,"outputTokens":n}
event: done       data: {"messageId":"ms_…","stopReason":"end_turn|max_tokens|refusal|other|aborted"}
event: error      data: {"error":"…","code":"missing-key|model-required|provider|busy"}
```

- The model sees the whole conversation (all stored user and assistant messages).
- One turn per conversation at a time: a second send while streaming is `409 { code: "busy" }`.
- No key for the conversation's provider: `400 { code: "missing-key", error: "no anthropic key; run: braavo keys add anthropic" }` before any stream starts.
- Client disconnect or `POST …/abort` stops the provider call. Partial text is kept as the
  assistant message with `stopReason: "aborted"`.
- Provider errors arrive as `event: error` with the key value redacted. The partial answer
  is kept as above.
- Every turn records a cost event (tokens) on the daemon side.

## 4. Mobile over the relay (1.4)

The phone never connects to the daemon directly. With `braavo daemon run --relay` (or a
LaunchAgent installed with `--relay`), the daemon registers **one relay session** with the
existing cloud relay. The relay protocol is unchanged, so no platform deploy is needed.

- Registration: `{ surface: "cli", label: "Braavo chat · <hostname>" }`. A mobile client
  recognises a daemon chat session by the label prefix `Braavo chat`.
- Phone → daemon: `steer { message }` (≤ 4000 chars) is one user turn in the session's
  current conversation (`source: "relay"`). Commands typed as the whole message:
  - `/new` starts a new conversation;
  - `/model PROVIDER/model` switches the current conversation's model.
- Company commands, also typed as the whole message, answer with text and never call a model:
  - `/company` shows the panel as text (org tree with provider/model · effort · status, routines);
  - `/findings [role]` shows the latest findings memory;
  - `/run <routine name>` runs a routine now;
  - `/pause <agent>` and `/resume <agent>` change an agent's state (name, role or id).
- `kill` aborts the in-flight turn (the daemon keeps running). `approve`/`reject` are no-ops.
- Daemon → phone, per turn:
  1. `status { state: "running" }`.
  2. `output { textB64 }`: base64 UTF-8 chunks of the answer as it streams (batched
     roughly every 250 ms). Concatenate them in `seq` order to render the answer live.
  3. `agent-turn { summary }`: the final answer (cut to 4000 chars). This closes the
     bubble. On failure the summary starts with `error:`.
  4. `status { state: "idle" }`.
- Both the daemon and the relay server redact secrets in event text. What the phone shows
  can therefore differ from the stored answer where a secret-looking string was masked.
- **Panel snapshot (opt-in):** after company changes (at most every 10 s) and at start, the daemon
  posts a `panel-snapshot` event: company name; agents with id, name, role, managerId, model
  (`PROVIDER/model`, or null while setup is needed), effort, status, runs this month; routines
  with name, agentId, nextFireAt, lastOutcome; month token totals. It never carries prompts or
  transcripts. A companion receives it only when it polls/streams with `include=panel-snapshot`
  (relay server from platform `feat/relay-snapshot`); a relay without the type refuses the post,
  which the daemon ignores.
- The default model for a new relay conversation is the `mid` suggestion from
  `GET /v1/models`; with no usable model the turn answers `error: setup required …`.

## 5. Not in v1

Tools and the agent loop inside chat, attachments, per-model USD pricing, multi-device
conflict handling beyond `conversation.changed`, and Linux service install.

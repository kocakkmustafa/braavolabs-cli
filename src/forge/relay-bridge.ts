/**
 * CLI relay bridge — Companion channel Dilim 2b: the `braavo`-side client
 * CORE that bridges a local `braavo spawn --bridge` session to the cloud
 * relay control plane (Dilim 1, sealed — braavolabs monorepo
 * `packages/api/src/modules/relay/*`, mirrored in relay-protocol.ts). A
 * bridged local session registers itself with the relay, mirrors its
 * activity UP to a companion (mobile panel) that observes it, and receives
 * commands DOWN from that companion.
 *
 * This is a near-verbatim port of the Desktop app's own core (Companion
 * channel Dilim 2a, sealed — `packages/desktop/src/relay-bridge.ts`): same
 * shape as R6's browser.ts/pty.ts on that side — a PURE, unit-tested core
 * with the real I/O INJECTED —
 *   1. RelayTransport — the wire (real: fetch+SSE, relay-transport.ts; fake:
 *      an in-memory stand-in the tests drive headlessly),
 *   2. BridgeHandlers — how an inbound ControlCommand becomes a LOCAL action.
 *      RelayBridge only CALLS these; the actual wiring lives in spawn.ts's
 *      `spawnVendorBridged` (steer → child.stdin.write, kill → child.kill).
 *
 * DELIBERATE DIVERGENCE FROM THE DESKTOP CORE: Desktop wraps a local
 * `Governance` gate (`bridgeGovernance`, `resolveApproval`/`resolveRejection`)
 * because a Tauri session has its own governed-action approval dialog that
 * can race a companion `approve`/`reject`. `braavo` has NO local governance
 * gate — `spawn` runs the user's own already-authenticated vendor CLI
 * (claude/codex) as an opaque child process (see spawn.ts's SAFE-SPAWN
 * contract) and never intercepts or gates the vendor's OWN actions. So this
 * port carries ONLY the transport-agnostic RelayBridge core (register,
 * subscribe, the emit-family, dispatch) and drops bridgeGovernance/
 * resolveApproval/resolveRejection entirely — there is no governance object
 * on this side to decorate. An inbound `approve`/`reject` ControlCommand still round-trips
 * through `dispatch()` like any other command (contract parity — a future
 * companion UI may not know a given CLI session has no gate), but spawn.ts's
 * BridgeHandlers.onApprove/onReject are a logged NO-OP: there is nothing
 * local for them to resolve.
 */
import {
  ControlCommandSchema,
  redactSessionEventInput,
  type ControlCommand,
  type SessionEventInput,
  type SessionEventState,
  type SessionRegistration,
} from "./relay-protocol";

// ── injected transport ──────────────────────────────────────────────────

/**
 * The wire between this local session and the cloud relay. Real
 * implementation: relay-transport.ts (fetch + fetch-streamed SSE, runtime-
 * only, verified headed). Fake implementation: tests.
 */
export interface RelayTransport {
  /** Register this local session with the relay. Returns the server-minted id. */
  register(reg: SessionRegistration): Promise<{ sessionId: string }>;
  /** Post an already-gated, already-(client-side)-redacted event. */
  postEvent(sessionId: string, ev: SessionEventInput): Promise<void>;
  /**
   * Subscribe to inbound ControlCommands for this session. `onCmd` receives
   * an UNVALIDATED, already-JSON-parsed payload — RelayBridge re-validates
   * with ControlCommandSchema before dispatch (defense-in-depth independent
   * of whatever the transport already checked; a fake test transport can
   * push anything). Returns an unsubscribe function.
   */
  subscribeCommands(sessionId: string, onCmd: (raw: unknown) => void): () => void;
}

// ── injected local handlers ─────────────────────────────────────────────

/**
 * Translates an inbound (already-validated) ControlCommand into a LOCAL
 * action. Provided by the app's wiring layer (spawn.ts's
 * `spawnVendorBridged`/braavo.ts's `spawn --bridge` handling), NOT
 * implemented in this module — RelayBridge only calls these. `onSteer` is
 * synchronous (writes into the spawned vendor child's stdin); the others are
 * async side effects.
 */
export interface BridgeHandlers {
  onSteer(message: string): void;
  onApprove(actionId: string): Promise<void>;
  onReject(actionId: string): Promise<void>;
  onKill(): Promise<void>;
}

// ── the bridge ───────────────────────────────────────────────────────────

/**
 * One relay-bridged local session. `start()` registers + subscribes;
 * `emit*()` mirror activity UP (client-side redacted, then handed to the
 * transport); inbound commands are validated + dispatched to `handlers`;
 * `stop()` marks the session ended and unsubscribes.
 */
export class RelayBridge {
  private readonly transport: RelayTransport;
  private readonly handlers: BridgeHandlers;
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private outputInFlight = 0;
  private outputLossNotified = false;
  private droppedOutput = 0;

  constructor(transport: RelayTransport, handlers: BridgeHandlers, private options: { onOutputDropped?: () => void } = {}) {
    this.transport = transport;
    this.handlers = handlers;
  }

  /** The relay-assigned session id, once started (null before `start()`). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Register with the relay and start listening for inbound commands. */
  async start(reg: SessionRegistration): Promise<{ sessionId: string }> {
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sessionId = null;
    const { sessionId } = await this.transport.register(reg);
    if (generation !== this.generation) {
      // The child may exit while registration is in flight. Mirror its end
      // without reopening command delivery or replacing a newer session.
      try { await this.transport.postEvent(sessionId, { type: "status", state: "ended" }); } catch { /* best effort */ }
      return { sessionId };
    }
    this.sessionId = sessionId;
    this.unsubscribe = this.transport.subscribeCommands(sessionId, (raw) => {
      if (generation === this.generation && this.sessionId === sessionId) this.dispatch(raw);
    });
    return { sessionId };
  }

  /** Stop command delivery immediately, then mirror the captured session's end. */
  async stop(): Promise<void> {
    ++this.generation; // Also cancels a registration that has not returned yet.
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!sessionId) return;
    try { await this.transport.postEvent(sessionId, { type: "status", state: "ended" }); } catch { /* best effort mirror */ }
  }

  // ── inbound: companion → local ─────────────────────────────────────────

  /**
   * Validate + dispatch ONE inbound payload. A malformed/unknown-`type`
   * payload is IGNORED, never thrown — a future command type this build
   * doesn't know about (or a corrupted frame) must not take the bridge
   * down. Fire-and-forget: dispatch itself is synchronous from the
   * transport's point of view (it does not block the next inbound message
   * on this one's handler finishing).
   */
  private dispatch(raw: unknown): void {
    const parsed = ControlCommandSchema.safeParse(raw);
    if (!parsed.success) return;
    void this.runHandler(parsed.data);
  }

  /**
   * Run the ONE handler for this command, isolated in its own try/catch —
   * a handler throwing (or its promise rejecting) must never kill the
   * bridge / the command subscription. The command stream keeps delivering
   * regardless of any single handler's outcome.
   */
  private async runHandler(cmd: ControlCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case "steer":
          this.handlers.onSteer(cmd.message);
          break;
        case "approve":
          await this.handlers.onApprove(cmd.actionId);
          break;
        case "reject":
          await this.handlers.onReject(cmd.actionId);
          break;
        case "kill":
          await this.handlers.onKill();
          break;
      }
    } catch {
      // Swallowed by design — see the doc comment above. A failed handler
      // should surface through the app's own error/audit path, not by
      // crashing this dispatch loop.
    }
  }

  // ── outbound: local → companion ────────────────────────────────────────

  /**
   * Post an event, applying CLIENT-SIDE redaction first (defense-in-depth —
   * the relay server redacts again independently; a raw secret must not
   * even leave this process). A transport/network failure is swallowed:
   * the companion mirror is best-effort observability, and losing it must
   * never break the local session it's mirroring. No-ops before `start()`.
   */
  private async post(ev: SessionEventInput): Promise<void> {
    if (!this.sessionId) return;
    const redacted = redactSessionEventInput(ev);
    try {
      await this.transport.postEvent(this.sessionId, redacted);
    } catch {
      // best-effort mirror — see doc comment above.
    }
  }

  /** Mirror an approval-request up to the companion. braavo carries no local
   * gate that produces this today (see module header) — kept for contract
   * parity; nothing in this build currently calls it. */
  emitApprovalRequest(actionId: string, kind: string, dialogText: string): Promise<void> {
    return this.post({ type: "approval-request", actionId, kind, dialogText });
  }

  /** Mirror a chunk of terminal/agent output (base64, bounded). This is what
   * `spawn --bridge` calls with each TEE'd vendor stdout/stderr chunk. */
  emitOutput(text: string): Promise<void> {
    if (!this.sessionId) return Promise.resolve();
    // Best-effort mirror never backpressures the local terminal or accumulates
    // an unbounded queue. Eight bounded chunks at most; omitted output is explicit.
    if (this.outputInFlight >= 8 || Buffer.byteLength(text, "utf8") > 128 * 1024) {
      this.droppedOutput++;
      if (!this.outputLossNotified) {
        this.outputLossNotified = true;
        try { this.options.onOutputDropped?.(); } catch { /* notification must not interrupt local output */ }
      }
      return Promise.resolve();
    }
    this.outputInFlight++;
    return this.post({ type: "output", textB64: toBase64(text) }).finally(() => { this.outputInFlight--; });
  }

  /** A mirror is not a durable transcript; local stdout/stderr remain complete. */
  getDroppedOutputCount(): number { return this.droppedOutput; }

  /** Mirror a redacted audit-ledger line. */
  emitAudit(summary: string): Promise<void> {
    return this.post({ type: "audit", summary });
  }

  /** Mirror a redacted agent-turn summary — never the raw transcript. */
  emitAgentTurn(summary: string): Promise<void> {
    return this.post({ type: "agent-turn", summary });
  }

  /** Mirror the session's lifecycle state. */
  setStatus(state: SessionEventState): Promise<void> {
    return this.post({ type: "status", state });
  }
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  if (typeof btoa === "function") {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

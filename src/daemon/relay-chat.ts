import type { DaemonStore } from "./store";
import { ChatError, type ChatService } from "./chat";
import { isAIProvider } from "../core/providers";
/**
 * Phone chat over the cloud relay (plan 1.4; docs/DAEMON-CHAT.md §4). The daemon
 * registers one relay session and treats every `steer` as a user turn in its
 * current `source: "relay"` conversation. The relay protocol is unchanged, so this
 * needs no server deploy: answers stream back as `output` chunks, the final
 * answer as `agent-turn`, and `status` brackets each turn.
 *
 * All posts go through one queue so the relay assigns `seq` in the order the
 * text was produced (RelayBridge.emitOutput alone would post chunks in parallel).
 */

export interface RelayChatBridge {
  emitOutput(text: string): Promise<void>;
  emitAgentTurn(summary: string): Promise<void>;
  setStatus(state: "running" | "idle" | "ended"): Promise<void>;
}

export interface RelayChatOptions {
  /** Model for a new relay conversation: the `mid` suggestion from the user's own keys, if any. */
  defaultModel: () => Promise<{ provider: string; model: string } | undefined>;
  flushMs?: number;
}

const SOURCE = "relay";
const MAX_SUMMARY = 4000;

const summary = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length > MAX_SUMMARY ? `${trimmed.slice(0, MAX_SUMMARY - 1)}…` : trimmed || "(empty answer)";
};

export class RelayChat {
  private bridge?: RelayChatBridge;
  private queue: Promise<void> = Promise.resolve();
  private current?: string;
  private nextModel?: { provider: string; model: string };

  constructor(private readonly chat: ChatService, private readonly store: DaemonStore, private readonly options: RelayChatOptions) {
    this.current = store.latestConversation(SOURCE)?.id;
  }

  attach(bridge: RelayChatBridge): void { this.bridge = bridge; }

  /** BridgeHandlers for RelayBridge: steer = a turn, kill = stop the turn (never the daemon). */
  handlers() {
    return {
      onSteer: (message: string) => { void this.onSteer(message); },
      onKill: async () => { if (this.current) this.chat.abort(this.current); },
      onApprove: async () => {},
      onReject: async () => {},
    };
  }

  private post(fn: (b: RelayChatBridge) => Promise<void>): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return this.queue;
    this.queue = this.queue.then(() => fn(bridge)).catch(() => { /* a lost mirror frame never breaks the turn */ });
    return this.queue;
  }

  private reply(text: string): Promise<void> {
    this.post(b => b.setStatus("running"));
    this.post(b => b.emitAgentTurn(summary(text)));
    return this.post(b => b.setStatus("idle"));
  }

  async onSteer(raw: string): Promise<void> {
    const message = raw.trim();
    if (message === "/new") { this.current = undefined; return this.reply("New conversation started."); }
    const model = /^\/model\s+([A-Z_]+)\/(\S{1,200})$/.exec(message);
    if (model) {
      if (!isAIProvider(model[1])) return this.reply(`error: unknown provider ${model[1]}`);
      const choice = { provider: model[1], model: model[2] };
      if (this.current && this.store.getConversation(this.current)) this.chat.update(this.current, choice);
      else this.nextModel = choice;
      return this.reply(`Model: ${choice.provider}/${choice.model}`);
    }

    if (!this.current || !this.store.getConversation(this.current)) {
      const choice = this.nextModel ?? await this.options.defaultModel();
      if (!choice) return this.reply("error: setup required. Add a key on your computer (braavo keys add <provider>) or pull a local model (Ollama, LM Studio).");
      this.current = this.chat.create({ ...choice, source: SOURCE }).id;
      this.nextModel = undefined;
    }
    const id = this.current;
    if (this.chat.isBusy(id)) return this.reply("error: still answering the previous message. Send stop first.");

    this.post(b => b.setStatus("running"));
    let pending = ""; let full = ""; let failure: string | undefined;
    const flush = () => { if (pending) { const chunk = pending; pending = ""; this.post(b => b.emitOutput(chunk)); } };
    const timer = setInterval(flush, this.options.flushMs ?? 250);
    try {
      await this.chat.send(id, message, ev => {
        if (ev.type === "delta") { pending += ev.text; full += ev.text; }
        else if (ev.type === "error") failure = ev.error;
      });
    } catch (error) {
      failure = error instanceof ChatError ? error.message : "the turn failed";
    } finally {
      clearInterval(timer);
    }
    flush();
    this.post(b => b.emitAgentTurn(summary(failure ? `error: ${failure}${full ? `\n\n${full}` : ""}` : full)));
    return this.post(b => b.setStatus("idle"));
  }
}

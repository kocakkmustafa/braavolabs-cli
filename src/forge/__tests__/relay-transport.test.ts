import { describe, it, expect, vi } from "vitest";
import { createRelayTransport, splitSseEvents, parseSseEvent } from "../relay-transport";
import type { Config } from "../config";

function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

// BR-P0-004: apiFetch now refuses to send credentials to a non-official host,
// so the fixture uses the official one. Host-trust behavior itself is covered
// in host-trust.test.ts.
const baseCfg = (): Config => ({ apiUrl: "https://braavolabs.com/api/v1", token: "tok" });

describe("splitSseEvents — pure SSE framing", () => {
  it("splits complete blocks and keeps the partial tail", () => {
    const { events, rest } = splitSseEvents("id: 1\ndata: a\n\nid: 2\ndata: b\n\npartial-no-terminat");
    expect(events).toEqual(["id: 1\ndata: a", "id: 2\ndata: b"]);
    expect(rest).toBe("partial-no-terminat");
  });

  it("handles an empty buffer", () => {
    expect(splitSseEvents("")).toEqual({ events: [], rest: "" });
  });

  it("reassembles a frame split across two chunks via the rest tail", () => {
    const first = splitSseEvents("id: 1\ndata: {\"type\":\"kil");
    expect(first.events).toEqual([]);
    const second = splitSseEvents(first.rest + "l\"}\n\n");
    expect(second.events).toEqual(['id: 1\ndata: {"type":"kill"}']);
  });
});

describe("parseSseEvent — pure frame decoding", () => {
  it("extracts and JSON-parses the data: line", () => {
    expect(parseSseEvent('id: 1\ndata: {"type":"kill"}')).toEqual({ type: "kill" });
  });

  it("returns null for a keepalive/comment-only block", () => {
    expect(parseSseEvent(": keepalive 12345")).toBeNull();
  });

  it("returns null for an event:done marker with no data line", () => {
    expect(parseSseEvent("event: done\ndata: {}")).toEqual({});
    expect(parseSseEvent("event: done")).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(parseSseEvent("data: {not-json")).toBeNull();
  });
});

describe("createRelayTransport — register/postEvent (reuses apiFetch)", () => {
  it("register() POSTs to /relay/sessions with Bearer auth and returns the sessionId", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(201, { sessionId: "sess_7", surface: "cli", status: "active", createdAt: "now" });
    });
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    const out = await transport.register({ surface: "cli", label: "braavo spawn claude" });
    expect(out).toEqual({ sessionId: "sess_7" });
    expect(calls[0].url).toBe("https://braavolabs.com/api/v1/relay/sessions");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init.body)).toEqual({ surface: "cli", label: "braavo spawn claude" });
  });

  it("postEvent() POSTs to /relay/sessions/:id/events", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return resp(202, { success: true });
    });
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    await transport.postEvent("sess_7", { type: "status", state: "running" });
    expect(calls[0].url).toBe("https://braavolabs.com/api/v1/relay/sessions/sess_7/events");
    expect(JSON.parse(calls[0].init.body)).toEqual({ type: "status", state: "running" });
  });

  it("postEvent() URL-encodes a session id with special characters", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return resp(202, { success: true });
    });
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    await transport.postEvent("sess/weird id", { type: "status", state: "idle" });
    expect(calls[0]).toBe("https://braavolabs.com/api/v1/relay/sessions/sess%2Fweird%20id/events");
  });
});

describe("createRelayTransport — subscribeCommands (fetch+SSE)", () => {
  /** Fake ReadableStream-shaped body: yields the given text chunks, then `done`. */
  function fakeBody(chunks: string[]) {
    const encoder = new TextEncoder();
    let i = 0;
    return {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              const value = encoder.encode(chunks[i]);
              i += 1;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it("GETs the command stream with Accept: text/event-stream + Bearer auth", async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { body: fakeBody([]) };
    });
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    const unsubscribe = transport.subscribeCommands("sess_1", () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0].url).toBe("https://braavolabs.com/api/v1/relay/sessions/sess_1/commands");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers.Accept).toBe("text/event-stream");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
    unsubscribe();
  });

  it("parses each data: frame and calls onCmd, skipping keepalive comments", async () => {
    const chunks = [
      "id: 1\ndata: {\"type\":\"steer\",\"message\":\"hi\"}\n\n",
      ": keepalive 123\n\n",
      "id: 2\ndata: {\"type\":\"kill\"}\n\n",
    ];
    const fetchImpl = vi.fn(async () => ({ body: fakeBody(chunks) }));
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    const received: unknown[] = [];
    const unsubscribe = transport.subscribeCommands("sess_1", (raw) => received.push(raw));
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([{ type: "steer", message: "hi" }, { type: "kill" }]);
    unsubscribe();
  });

  it("unsubscribe() aborts the underlying request signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      capturedSignal = init.signal;
      return { body: fakeBody([]) };
    });
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    const unsubscribe = transport.subscribeCommands("sess_1", () => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedSignal?.aborted).toBe(false);
    unsubscribe();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("a body without a stream reader is a harmless no-op (never throws)", async () => {
    const fetchImpl = vi.fn(async () => ({ body: null }));
    const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl });
    expect(() => transport.subscribeCommands("sess_1", () => {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("adversarial hardening (P2-2b timeout · P3 multi-line data)", () => {
  it("parseSseEvent joins MULTIPLE data: lines with \\n (SSE spec) instead of keeping only the last", () => {
    // A payload split across two data: lines must reassemble, not parse to null.
    const block = 'id: 1\ndata: {"type":\ndata: "kill"}';
    expect(parseSseEvent(block)).toEqual({ type: "kill" });
    // Single-line behaviour is unchanged (one leading space stripped).
    expect(parseSseEvent('data: {"type":"steer","message":"go"}')).toEqual({ type: "steer", message: "go" });
  });

  it("register() rejects when apiFetch hangs past the timeout (a slow-loris relay can't freeze the caller)", async () => {
    vi.useFakeTimers();
    try {
      // fetchImpl never resolves → without withTimeout the promise would hang forever.
      const fetchImpl = vi.fn(() => new Promise(() => {}));
      const transport = createRelayTransport({ cfg: baseCfg(), fetchImpl: fetchImpl as any });
      const p = transport.register({ surface: "cli" });
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

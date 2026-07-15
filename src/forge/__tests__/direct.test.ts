import { describe, it, expect, vi } from "vitest";
import { directChat, DirectApiError, DIRECT_PROVIDERS, DIRECT_DEFAULT_MODEL, isDirectProvider } from "../direct";

/** Minimal fetch Response stand-in. */
function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

describe("isDirectProvider / DIRECT_PROVIDERS", () => {
  it("lists exactly anthropic, openai, groq", () => {
    expect(DIRECT_PROVIDERS).toEqual(["anthropic", "openai", "groq"]);
  });

  it("rejects unknown providers", () => {
    expect(isDirectProvider("gemini")).toBe(false);
    expect(isDirectProvider("anthropic")).toBe(true);
  });

  it("has a documented default model for every provider", () => {
    for (const p of DIRECT_PROVIDERS) {
      expect(typeof DIRECT_DEFAULT_MODEL[p]).toBe("string");
      expect(DIRECT_DEFAULT_MODEL[p].length).toBeGreaterThan(0);
    }
  });
});

describe("directChat: anthropic", () => {
  it("sends x-api-key (NOT Authorization) plus anthropic-version, and parses content[0].text", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return resp(200, { content: [{ type: "text", text: "hello from claude" }] });
    });
    const res = await directChat("anthropic", "sk-ant-secret", "claude-3-5-sonnet-20241022", "hi", { fetchImpl });
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(captured.headers.Authorization).toBeUndefined();
    expect(captured.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured.body).toEqual({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.content).toBe("hello from claude");
  });
});

describe("directChat: openai", () => {
  it("sends Bearer auth and parses choices[0].message.content", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return resp(200, { choices: [{ message: { content: "hello from gpt" } }] });
    });
    const res = await directChat("openai", "sk-openai-secret", "gpt-4o-mini", "hi", { fetchImpl });
    expect(captured.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured.headers.Authorization).toBe("Bearer sk-openai-secret");
    expect(captured.headers["x-api-key"]).toBeUndefined();
    expect(captured.body).toEqual({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    expect(res.content).toBe("hello from gpt");
  });
});

describe("directChat: groq", () => {
  it("uses the openai-compatible endpoint + Bearer auth", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return resp(200, { choices: [{ message: { content: "hello from groq" } }] });
    });
    const res = await directChat("groq", "gsk-secret", "llama-3.1-8b-instant", "hi", { fetchImpl });
    expect(captured.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(captured.headers.Authorization).toBe("Bearer gsk-secret");
    expect(res.content).toBe("hello from groq");
  });
});

describe("directChat errors", () => {
  it("throws DirectApiError with provider + status + server message on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => resp(401, { error: { message: "invalid x-api-key" } }));
    await expect(
      directChat("anthropic", "bad-key", "claude-3-5-sonnet-20241022", "hi", { fetchImpl }),
    ).rejects.toMatchObject({ name: "DirectApiError", provider: "anthropic", status: 401, message: "invalid x-api-key" });
  });

  it("never includes the API key anywhere in a thrown error's message", async () => {
    const secret = "sk-openai-super-secret-value";
    const fetchImpl = vi.fn(async () => resp(500, { error: "server exploded" }));
    try {
      await directChat("openai", secret, "gpt-4o-mini", "hi", { fetchImpl });
      throw new Error("expected directChat to throw");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).not.toContain(secret);
    }
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  resolveOllamaHost,
  listOllamaModels,
  ollamaChat,
  resolveOllamaModel,
  OllamaUnreachableError,
  DEFAULT_OLLAMA_HOST,
} from "../local";

/** Minimal fetch Response stand-in. */
function resp(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  };
}

describe("resolveOllamaHost", () => {
  it("defaults to http://localhost:11434", () => {
    const prev = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST;
    expect(resolveOllamaHost()).toBe(DEFAULT_OLLAMA_HOST);
    if (prev !== undefined) process.env.OLLAMA_HOST = prev;
  });

  it("honors OLLAMA_HOST env override", () => {
    const prev = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://box:9999";
    expect(resolveOllamaHost()).toBe("http://box:9999");
    process.env.OLLAMA_HOST = prev;
  });

  it("an explicit arg wins over the env var", () => {
    const prev = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://envhost:1";
    expect(resolveOllamaHost("http://explicit:2")).toBe("http://explicit:2");
    process.env.OLLAMA_HOST = prev;
  });

  it("strips a trailing slash", () => {
    expect(resolveOllamaHost("http://localhost:11434/")).toBe("http://localhost:11434");
  });
});

describe("listOllamaModels", () => {
  it("GETs /api/tags and returns model names", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { models: [{ name: "llama3.1" }, { name: "mistral" }] }));
    const models = await listOllamaModels("http://localhost:11434", { fetchImpl });
    expect(models).toEqual(["llama3.1", "mistral"]);
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:11434/api/tags", undefined);
  });

  it("throws OllamaUnreachableError when the connection is refused", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(listOllamaModels("http://localhost:11434", { fetchImpl })).rejects.toBeInstanceOf(
      OllamaUnreachableError,
    );
  });

  it("carries an honest 'not reachable — is it running?' message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(listOllamaModels("http://localhost:11434", { fetchImpl })).rejects.toThrow(
      "Ollama not reachable — is it running?",
    );
  });
});

describe("ollamaChat", () => {
  it("POSTs /api/chat with stream:false and the question as a user message", async () => {
    let captured: any;
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      captured = { url, method: init.method, body: JSON.parse(init.body) };
      return resp(200, { model: "llama3.1", message: { role: "assistant", content: "42" } });
    });
    const res = await ollamaChat("http://localhost:11434", "llama3.1", "meaning of life?", { fetchImpl });
    expect(captured.url).toBe("http://localhost:11434/api/chat");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({
      model: "llama3.1",
      stream: false,
      messages: [{ role: "user", content: "meaning of life?" }],
    });
    expect(res.content).toBe("42");
  });

  it("surfaces OllamaUnreachableError when the daemon is down mid-chat", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      ollamaChat("http://localhost:11434", "llama3.1", "hi", { fetchImpl }),
    ).rejects.toBeInstanceOf(OllamaUnreachableError);
  });

  it("throws a descriptive error on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => resp(404, { error: "model 'ghost' not found" }));
    await expect(ollamaChat("http://localhost:11434", "ghost", "hi", { fetchImpl })).rejects.toThrow(
      "model 'ghost' not found",
    );
  });
});

describe("resolveOllamaModel", () => {
  it("returns the explicit --model choice without calling /api/tags", async () => {
    const fetchImpl = vi.fn();
    const model = await resolveOllamaModel("http://localhost:11434", "mistral", { fetchImpl });
    expect(model).toBe("mistral");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the first installed model when none is specified", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { models: [{ name: "llama3.1" }, { name: "mistral" }] }));
    const model = await resolveOllamaModel("http://localhost:11434", undefined, { fetchImpl });
    expect(model).toBe("llama3.1");
  });

  it("throws honestly (no hardcoded guess) when nothing is installed", async () => {
    const fetchImpl = vi.fn(async () => resp(200, { models: [] }));
    await expect(resolveOllamaModel("http://localhost:11434", undefined, { fetchImpl })).rejects.toThrow(
      "No local Ollama models installed",
    );
  });
});

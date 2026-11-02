import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveOllamaHost } from "../forge/local";

/**
 * Vector search for company memory (plan 4.3, optional): local embeddings from Ollama,
 * stored next to the FTS index, fused with the keyword results (reciprocal rank).
 *
 * Off by default (the founder's dogfooding runs model-free). Turned on by naming an
 * embedding model (`braavo company memory embed nomic-embed-text`). Whenever the model is
 * not set, Ollama does not answer, or the model is missing, search is the FTS search alone
 * and the result says so — memory never depends on a model being up.
 */

export interface Embedder { model: string; embed(texts: string[]): Promise<number[][]> }

export interface VectorSettings { embedModel: string | null; ollamaHost?: string }

export function loadVectorSettings(file: string): VectorSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<VectorSettings>;
    const model = typeof raw.embedModel === "string" && /^[\w.:/-]{1,120}$/.test(raw.embedModel) ? raw.embedModel : null;
    return { embedModel: model, ...(typeof raw.ollamaHost === "string" ? { ollamaHost: raw.ollamaHost } : {}) };
  } catch { return { embedModel: null }; }
}

export function saveVectorSettings(file: string, settings: VectorSettings): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Ollama's /api/embed (batched); a bounded wait so a sleeping Ollama never stalls a search. */
export function ollamaEmbedder(model: string, o: { host?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Embedder {
  const host = resolveOllamaHost(o.host);
  const fetchImpl = o.fetchImpl ?? fetch;
  return {
    model,
    async embed(texts) {
      const res = await fetchImpl(`${host}/api/embed`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts, truncate: true }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
      if (!res.ok) throw new Error(res.status === 404 ? `embedding model ${model} is not pulled (braavo models pull ${model})` : `Ollama answered ${res.status}`);
      const body = await res.json() as { embeddings?: unknown };
      const out = Array.isArray(body.embeddings) ? body.embeddings as number[][] : [];
      if (out.length !== texts.length || out.some(v => !Array.isArray(v) || !v.length || v.some(x => typeof x !== "number"))) throw new Error("Ollama returned no embeddings");
      return out;
    },
  };
}

export const hashText = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function toBlob(v: number[]): Uint8Array {
  const f = new Float32Array(v.length);
  // Normalised once at write time, so search is a dot product.
  const norm = Math.hypot(...v) || 1;
  v.forEach((x, i) => { f[i] = x / norm; });
  return new Uint8Array(f.buffer);
}

export function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** Reciprocal rank fusion of ranked key lists (k = 60, as in the RRF paper). */
export function rrf(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((key, rank) => score.set(key, (score.get(key) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

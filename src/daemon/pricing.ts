import { existsSync, readFileSync } from "node:fs";

/**
 * USD per million tokens for cost events and budgets (fark kapatma FK-12, plan 2.9).
 *
 * Only prices we can source are built in: Anthropic base rates from
 * https://platform.claude.com/docs/en/about-claude/pricing (fetched 2026-11-01), and 0 for
 * local runtimes. Anything else is unpriced (null) unless the user sets it in
 * ~/.braavo/prices.json as { "PROVIDER/model": { "inputPerM": n, "outputPerM": n } }.
 * Unpriced usage still records tokens; budgets count only priced spend and say so.
 */
export interface Price { inputPerM: number; outputPerM: number }
export type PriceOverrides = Record<string, Price>;

const LOCAL = new Set(["OLLAMA", "LMSTUDIO"]);

// Longest prefix wins, so claude-opus-5-5 is matched before claude-opus-5.
const ANTHROPIC: Array<[prefix: string, input: number, output: number]> = [
  ["claude-opus-5-5", 4, 20],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-opus-4-5", 5, 25],
  ["claude-opus-4", 15, 75],
  ["claude-sonnet-5-5", 2, 10],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-haiku-4-5", 1, 5],
].sort((a, b) => (b[0] as string).length - (a[0] as string).length) as Array<[string, number, number]>;
// Haiku 5.5 bills prompts over 100K tokens at a higher tier.
const HAIKU_5_5_LONG: Price = { inputPerM: 0.5, outputPerM: 2.5 };

/** The price that applies to one call, or null when the model is unpriced. */
export function priceFor(provider: string, model: string, inputTokens = 0, overrides: PriceOverrides = {}): Price | null {
  const key = `${provider.toUpperCase()}/${model}`;
  if (overrides[key]) return overrides[key];
  if (LOCAL.has(provider.toUpperCase())) return { inputPerM: 0, outputPerM: 0 };
  if (provider.toUpperCase() !== "ANTHROPIC") return null;
  const id = model.toLowerCase();
  if (id.startsWith("claude-haiku-5-5") && inputTokens > 100_000) return HAIKU_5_5_LONG;
  const hit = ANTHROPIC.find(([prefix]) => id.startsWith(prefix));
  return hit ? { inputPerM: hit[1], outputPerM: hit[2] } : null;
}

/** USD for one call, or null when unpriced. */
export function usdFor(provider: string, model: string, inputTokens: number, outputTokens: number, overrides: PriceOverrides = {}): number | null {
  const p = priceFor(provider, model, inputTokens, overrides);
  return p ? (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM : null;
}

/** User price overrides; a missing or unreadable file means none (never a guess). */
export function loadPriceOverrides(file: string): PriceOverrides {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: PriceOverrides = {};
    for (const [key, value] of Object.entries(raw)) {
      const v = value as { inputPerM?: unknown; outputPerM?: unknown };
      if (/^[A-Z_]+\/.+/.test(key) && typeof v?.inputPerM === "number" && typeof v?.outputPerM === "number" && v.inputPerM >= 0 && v.outputPerM >= 0) {
        out[key] = { inputPerM: v.inputPerM, outputPerM: v.outputPerM };
      }
    }
    return out;
  } catch {
    return {};
  }
}

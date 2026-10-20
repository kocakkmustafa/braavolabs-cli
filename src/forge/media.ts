import { t, numberText, moneyText } from "./locale";
/**
 * `braavo image` / `braavo voice` — terminal front-end for the FAZ E media
 * orchestration backend (fal.ai FLUX image, Google/ElevenLabs TTS). BYOK-only:
 * the server bills the tenant's own provider key and fail-closes with 402 when
 * none is set.
 *
 * Honesty flow (mirrors the server's cost-ack mandate): ALWAYS preview first to
 * get the server-computed estimate, show "≈ $X", and only generate when the
 * user explicitly opts in (`--yes`), sending that exact estimate back as
 * `acknowledgedCostUsd`. Without `--yes` the CLI stops after the (free) preview
 * — never spends silently.
 *
 * Pure helpers here (parseSize / render / decodeAudio); the command wiring +
 * network live in braavo.ts.
 */

export const IMAGE_MODELS = ["fal-ai/flux/schnell", "fal-ai/flux/dev"] as const;
export const TTS_PROVIDERS = ["GOOGLE_TTS", "ELEVENLABS"] as const;

export interface Size {
  width: number;
  height: number;
}

/**
 * Parse a "WIDTHxHEIGHT" size (e.g. "1024x768"); a bare "1024" means square.
 * Undefined → 1024×1024. Bounds mirror the server schema (256..1536). Throws a
 * clear message on anything malformed so the CLI can `die()` before any spend.
 */
export function parseSize(s: string | undefined): Size {
  if (!s) return { width: 1024, height: 1024 };
  const m = /^(\d{2,4})(?:x(\d{2,4}))?$/i.exec(s.trim());
  if (!m) throw new Error(t('bad --size "{0}" — use e.g. 1024x768 or 1024', s));
  const width = Number(m[1]);
  const height = m[2] ? Number(m[2]) : width;
  for (const [k, v] of [["width", width], ["height", height]] as const) {
    if (v < 256 || v > 1536) throw new Error(t("--size {0} {1} out of range (256..1536)", k, numberText(v)));
  }
  return { width, height };
}

/** The dollar figure the CLI must echo back as acknowledgedCostUsd. */
export function estimateUsd(estimate: unknown): number {
  const v = Number((estimate as { usd?: unknown } | null | undefined)?.usd);
  return Number.isFinite(v) ? v : 0;
}

type UiLike = {
  primary: (s: string) => string;
  steel: (s: string) => string;
  ember: (s: string) => string;
  dim: (s: string) => string;
  fail: (s: string) => string;
};

/** Preview block: the estimated cost + key/opt-in status (honesty surface). */
export function renderMediaPreview(
  ui: UiLike,
  estimate: { usd?: number; units?: number; note?: string } | null | undefined,
  keyConfigured: boolean,
  optedIn: boolean,
): string[] {
  const usd = estimateUsd(estimate);
  const out: string[] = [
    ui.primary(`── ${t("media preview")} ──`),
    ui.ember(`≈ ${moneyText(usd)} (${t("estimate")})`),
  ];
  if (estimate?.note) out.push(ui.dim(`  ${estimate.note}`));
  if (!keyConfigured) {
    out.push(ui.fail(`  ${t("No provider key — generation will fail (402). Add one:")}`));
    out.push(ui.dim("  braavo media-key add <FAL|GOOGLE_TTS|ELEVENLABS> <secret>"));
  } else if (!optedIn) {
    out.push(ui.dim(`  ${t("Add --yes to generate (this spends on your provider key)")}`));
  }
  return out;
}

/** Image result: the provider-CDN URLs (never stored on our server). */
export function renderImageResult(ui: UiLike, result: { images?: Array<{ url?: string }>; urlNote?: string }): string[] {
  const urls = (result?.images ?? []).map((i) => i?.url).filter((u): u is string => !!u);
  if (urls.length === 0) return [ui.fail(t("no image URL in response"))];
  const out = [ui.primary(`── ${t("{0} images", numberText(urls.length))} ──`)];
  for (const u of urls) out.push(ui.steel(`  ${u}`));
  if (result?.urlNote) out.push(ui.dim(`  ${result.urlNote}`));
  return out;
}

/** Decode a TTS base64 payload to bytes for writing to --out. */
export function decodeAudio(audioBase64: string): Buffer {
  return Buffer.from(audioBase64, "base64");
}

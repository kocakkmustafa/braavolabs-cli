/**
 * braavo config — token + defaults live in ~/.braavo/config.json.
 *
 * The config shape (apiUrl/token/refreshToken) drives an identical
 * refresh-retry loop everywhere, plus a `defaultCompany` set by `braavo use`.
 * Paths are injectable so tests round-trip against a tmp file, never real $HOME.
 */
import { chmodSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Config {
  apiUrl: string;
  token?: string;
  refreshToken?: string;
  /** Default company id used by `braavo ask` when --company is omitted. */
  defaultCompany?: string;
  /**
   * The user's explicit opt-in to a self-hosted / non-official API host, set by
   * `--allow-custom-host`. Persisted next to apiUrl so the decision travels with
   * the host it was made about — a later `--api` change to a DIFFERENT unknown
   * host is a fresh decision and must be opted into again.
   */
  allowCustomHost?: boolean;
}

export const CONFIG_DIR = join(homedir(), ".braavo");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_API =
  process.env.BRAAVO_API_URL ?? "https://braavolabs.com/api/v1";

/**
 * ── Custom-host credential safety (BR-P0-004) ────────────────────────────────
 *
 * `apiUrl` is attacker-influenceable from three directions: the `--api` flag
 * (which braavo.ts persists to config before running ANY command), the
 * BRAAVO_API_URL env var, and ~/.braavo/config.json itself. forge/client.ts
 * builds `${cfg.apiUrl}${path}`, so whatever lands there receives the user's
 * email + password on `braavo login` and the Bearer token on every other call.
 *
 * Policy: HTTPS required; official hosts and loopback allowlisted; anything
 * else denied unless the user explicitly opts in (self-hosting is a supported
 * deployment, so "custom host" must be possible — just never silent). The
 * exact ORIGIN is always named, so the user sees where credentials would go.
 */

/** Hosts shipped as trusted. Compared by exact equality — never by suffix,
 * which `braavolabs.com.evil.test` would satisfy. */
export const OFFICIAL_API_HOSTS = [
  "braavolabs.com",
  "www.braavolabs.com",
  "api.braavolabs.com",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type HostClassification =
  | { kind: "official"; origin: string; https: true }
  | { kind: "loopback"; origin: string; https: boolean }
  | { kind: "custom"; origin: string; https: boolean }
  | { kind: "invalid"; reason: string };

/** Raised when an API host must not receive credentials. */
export class UntrustedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedHostError";
  }
}

/**
 * Classify an API base URL. Pure and side-effect free so it can be used for
 * both the hard gate and for warning copy.
 */
export function classifyApiHost(apiUrl: string): HostClassification {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return { kind: "invalid", reason: "not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "invalid", reason: `unsupported scheme ${url.protocol}` };
  }
  const https = url.protocol === "https:";
  // `origin` deliberately drops path/query — an apiUrl can carry a token in a
  // query string, and warning copy must never echo a secret.
  const origin = url.origin;
  const host = url.hostname.toLowerCase();

  if (LOOPBACK_HOSTS.has(host)) return { kind: "loopback", origin, https };
  if ((OFFICIAL_API_HOSTS as readonly string[]).includes(host) && https) {
    return { kind: "official", origin, https: true };
  }
  return { kind: "custom", origin, https };
}

/**
 * Gate an API base URL before credentials (password, token, refresh token) are
 * sent to it. Throws UntrustedHostError with the exact origin when unsafe.
 *
 * @param opts.allowCustomHost the user's explicit opt-in for a self-hosted
 *   deployment. It permits an UNKNOWN host — it does NOT permit plaintext
 *   HTTP, which would still put credentials on the wire in the clear.
 */
export function assertHostSafeForCredentials(
  apiUrl: string,
  opts: { allowCustomHost?: boolean } = {},
): void {
  const c = classifyApiHost(apiUrl);

  if (c.kind === "invalid") {
    throw new UntrustedHostError(
      `Refusing to send credentials: API URL is unusable (${c.reason}).`,
    );
  }
  if (c.kind === "official" || c.kind === "loopback") return;

  if (!opts.allowCustomHost) {
    throw new UntrustedHostError(
      `Refusing to send credentials to an unrecognised host.\n` +
        `  Destination: ${c.origin}\n` +
        `  Official:    ${OFFICIAL_API_HOSTS.map((h) => `https://${h}`).join(", ")}\n` +
        `If you self-host Braavolabs and this address is yours, re-run with ` +
        `--allow-custom-host. If you did not set this address, someone else may have.`,
    );
  }
  if (!c.https) {
    throw new UntrustedHostError(
      `Refusing to send credentials over plaintext HTTP to ${c.origin}. ` +
        `Use https:// — --allow-custom-host permits an unknown host, not an unencrypted one.`,
    );
  }
}


export function loadConfig(path: string = CONFIG_PATH): Config {
  try {
    return { apiUrl: DEFAULT_API, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { apiUrl: DEFAULT_API };
  }
}

export function saveConfig(c: Config, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(c, null, 2), { mode: 0o600 });
  // writeFile's mode only applies on create; force an already-existing config
  // back to the credential-safe contract too.
  chmodSync(path, 0o600);
}

export function clearConfig(path: string = CONFIG_PATH): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * braavo config — token + defaults live in ~/.braavo/config.json.
 *
 * The config shape (apiUrl/token/refreshToken) drives an identical
 * refresh-retry loop everywhere, plus a `defaultCompany` set by `braavo use`.
 * Paths are injectable so tests round-trip against a tmp file, never real $HOME.
 */
import { chmodSync, closeSync, openSync, readFileSync, renameSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

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


interface DiskConfig {
  config: Config;
  present: boolean;
  valid: boolean;
}

/** Non-secret disk generation; kept out of the public config JSON and shape. */
export interface ConfigOwner extends Pick<Config, "apiUrl" | "token" | "refreshToken"> {
  readonly path: string;
  readonly nonce: string;
  readonly present: boolean;
}
const configOwners = new WeakMap<Config, ConfigOwner>();

function changedOwner(): Error {
  const error = new Error("Session changed while the command was pending");
  error.name = "SessionChangedError";
  return error;
}

function readConfig(path: string): DiskConfig {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { config: { apiUrl: DEFAULT_API }, present: false, valid: true };
  }
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid config");
    return { config: { apiUrl: DEFAULT_API, ...parsed }, present: true, valid: true };
  } catch {
    return { config: { apiUrl: DEFAULT_API }, present: true, valid: false };
  }
}

/** All CLI writers share this short lock; no network work occurs while held. */
function withConfigLock<T>(path: string, write: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const lockPath = `${path}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Config is being updated by another process; retry the command.");
    }
    throw error;
  }
  try {
    return write();
  } finally {
    try { closeSync(lock); } finally { rmSync(lockPath, { force: true }); }
  }
}

/** Atomic replacement also lets readers see a complete credential-safe file. */
function writeAtomic(value: unknown, path: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readNonce(path: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(`${path}.owner`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const marker = JSON.parse(contents) as { version?: unknown; nonce?: unknown };
  if (marker?.version !== 1 || typeof marker.nonce !== "string" || !marker.nonce) {
    throw new Error("Invalid config session owner marker");
  }
  return marker.nonce;
}

function writeNonce(path: string, nonce = randomUUID()): string {
  writeAtomic({ version: 1, nonce }, `${path}.owner`);
  return nonce;
}

function ownerSnapshot(path: string, nonce: string, disk: DiskConfig): ConfigOwner {
  return Object.freeze({ path: resolve(path), nonce, present: disk.present,
    apiUrl: disk.config.apiUrl, token: disk.config.token, refreshToken: disk.config.refreshToken });
}

function samePair(a: Pick<Config, "apiUrl" | "token" | "refreshToken">, b: Pick<Config, "apiUrl" | "token" | "refreshToken">): boolean {
  return a.apiUrl === b.apiUrl && a.token === b.token && a.refreshToken === b.refreshToken;
}

function matchesOwner(path: string, owner: ConfigOwner, nonce: string | undefined, disk: DiskConfig): boolean {
  return disk.valid && owner.path === resolve(path) && owner.nonce === nonce &&
    owner.present === disk.present && samePair(disk.config, owner);
}

function applyCommittedConfig(cfg: Config, committed: Config): void {
  Object.assign(cfg, committed);
  if (!("defaultCompany" in committed)) delete cfg.defaultCompany;
  if (!("allowCustomHost" in committed)) delete cfg.allowCustomHost;
}

export function loadConfig(path: string = CONFIG_PATH): Config {
  // Pair + generation must come from one critical section. Two independent
  // atomic reads can otherwise combine a pre-transition config with its new nonce.
  return withConfigLock(path, () => {
    const disk = readConfig(path);
    const nonce = readNonce(path) ?? writeNonce(path);
    if (disk.valid) configOwners.set(disk.config, ownerSnapshot(path, nonce, disk));
    return disk.config;
  });
}

/** Capture before prompts/network; a previously loaded owner cannot be rebound to B. */
export function captureConfigOwner(cfg: Config, path: string = CONFIG_PATH): ConfigOwner {
  return withConfigLock(path, () => {
    const disk = readConfig(path);
    const nonce = readNonce(path) ?? writeNonce(path);
    const known = configOwners.get(cfg);
    if (!disk.valid || !samePair(disk.config, cfg) || (known && !matchesOwner(path, known, nonce, disk))) {
      throw changedOwner();
    }
    const owner = ownerSnapshot(path, nonce, disk);
    configOwners.set(cfg, owner);
    return owner;
  });
}

export function saveConfig(c: Config, path: string = CONFIG_PATH): void {
  withConfigLock(path, () => {
    readNonce(path); // A corrupt marker is not silently replaced.
    // Publish the invalidation first: a failed subsequent config write must
    // still prevent pending old commands from committing successfully.
    const nonce = writeNonce(path);
    writeAtomic(c, path);
    configOwners.set(c, ownerSnapshot(path, nonce, { config: c, present: true, valid: true }));
  });
}

/** Refresh keeps the same generation and changes only authentication fields. */
export function saveConfigIfCurrent(
  next: Config,
  owner: Pick<Config, "apiUrl" | "token" | "refreshToken">,
  path: string = CONFIG_PATH,
): boolean {
  return withConfigLock(path, () => {
    const disk = readConfig(path);
    const nonce = readNonce(path);
    const known = configOwners.get(next) ?? configOwners.get(owner);
    if (!known || !disk.present || !matchesOwner(path, { ...known,
      apiUrl: owner.apiUrl, token: owner.token, refreshToken: owner.refreshToken }, nonce, disk) || next.apiUrl !== owner.apiUrl) {
      return false;
    }
    const committed = { ...disk.config, token: next.token, refreshToken: next.refreshToken };
    writeAtomic(committed, path);
    applyCommittedConfig(next, committed);
    configOwners.set(next, ownerSnapshot(path, nonce!, { config: committed, present: true, valid: true }));
    return true;
  });
}

/** Email-login may replace an unchanged present OR initially absent owner. */
export function commitLoginIfCurrent(
  cfg: Config,
  pair: Pick<Config, "token" | "refreshToken">,
  owner: ConfigOwner,
  path: string = CONFIG_PATH,
): boolean {
  return withConfigLock(path, () => {
    const disk = readConfig(path);
    if (!matchesOwner(path, owner, readNonce(path), disk) || !samePair(cfg, owner)) return false;
    if (typeof pair.token !== "string" || !pair.token.trim() ||
        (pair.refreshToken !== undefined && (typeof pair.refreshToken !== "string" || !pair.refreshToken.trim()))) {
      throw new Error("Invalid authentication response");
    }
    const committed = { ...disk.config, token: pair.token, refreshToken: pair.refreshToken };
    const nonce = writeNonce(path);
    writeAtomic(committed, path);
    applyCommittedConfig(cfg, committed);
    configOwners.set(cfg, ownerSnapshot(path, nonce, { config: committed, present: true, valid: true }));
    return true;
  });
}

export function clearConfig(path: string = CONFIG_PATH): void {
  withConfigLock(path, () => {
    readNonce(path);
    writeNonce(path); // Tombstone survives deletion, including an already absent config.
    rmSync(path, { force: true });
  });
}

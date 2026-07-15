/**
 * forge keys — LOCAL BYOK key storage. These keys are stored/listed/deleted
 * on this machine only; they are NEVER sent to the server (a future Lane-A
 * direct-provider mode will consume them). A key value is never printed or
 * logged — `list` shows a masked fingerprint (first4…last4) only.
 *
 * macOS: the login keychain via `security ...-generic-password` (service
 * "forge-cli"), with a names-only index file so `list` knows what to fetch.
 * Other OSes: a fallback ~/.forge/keys.json, chmod 600, with an honest warning.
 *
 * Dependencies (exec / fs / platform / paths) are injected so tests exercise
 * both the keychain and fallback branches without touching a real keychain.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config";

export const KEYCHAIN_SERVICE = "forge-cli";

/** Reveal nothing meaningful: first4…last4 for long keys, just … for short. */
export function maskKey(secret: string): string {
  const s = (secret ?? "").trim();
  if (s.length <= 8) return "…";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export interface KeyEntry {
  provider: string;
  masked: string;
}

export interface KeyStoreDeps {
  platform: NodeJS.Platform;
  dir: string;
  /** Run the macOS `security` tool. Returns stdout; throws on non-zero exit. */
  exec: (args: string[]) => string;
  fs: {
    readFileSync: (p: string) => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string) => void;
    chmodSync: (p: string, mode: number) => void;
    rmSync: (p: string) => void;
  };
}

export interface KeyStore {
  /** True when secrets live in the OS keychain (macOS), false = plaintext file. */
  readonly secure: boolean;
  add(provider: string, secret: string): void;
  list(): KeyEntry[];
  remove(provider: string): void;
}

function defaultDeps(): KeyStoreDeps {
  return {
    platform: process.platform,
    dir: CONFIG_DIR,
    exec: (args) => execFileSync("security", args, { encoding: "utf8" }),
    fs: {
      readFileSync: (p) => readFileSync(p, "utf8"),
      writeFileSync: (p, data) => writeFileSync(p, data),
      existsSync: (p) => existsSync(p),
      mkdirSync: (p) => mkdirSync(p, { recursive: true }),
      chmodSync: (p, mode) => chmodSync(p, mode),
      rmSync: (p) => rmSync(p),
    },
  };
}

export function makeKeyStore(partial: Partial<KeyStoreDeps> = {}): KeyStore {
  const deps: KeyStoreDeps = { ...defaultDeps(), ...partial };
  const isMac = deps.platform === "darwin";
  const indexPath = join(deps.dir, "keys-index.json");
  const filePath = join(deps.dir, "keys.json");

  const readJson = <T>(p: string, fallback: T): T => {
    try {
      if (!deps.fs.existsSync(p)) return fallback;
      return JSON.parse(deps.fs.readFileSync(p)) as T;
    } catch {
      return fallback;
    }
  };

  const writeIndex = (names: string[]): void => {
    deps.fs.mkdirSync(deps.dir);
    deps.fs.writeFileSync(indexPath, JSON.stringify([...new Set(names)].sort(), null, 2));
  };

  const writeFallbackFile = (map: Record<string, string>): void => {
    deps.fs.mkdirSync(deps.dir);
    deps.fs.writeFileSync(filePath, JSON.stringify(map, null, 2));
    deps.fs.chmodSync(filePath, 0o600);
  };

  if (isMac) {
    return {
      secure: true,
      add(provider, secret) {
        // -U upserts (updates if the item already exists).
        deps.exec(["add-generic-password", "-a", provider, "-s", KEYCHAIN_SERVICE, "-w", secret, "-U"]);
        const names = readJson<string[]>(indexPath, []);
        names.push(provider);
        writeIndex(names);
      },
      list() {
        const names = readJson<string[]>(indexPath, []);
        return names.map((provider) => {
          let masked = "(missing)";
          try {
            const secret = deps.exec(["find-generic-password", "-a", provider, "-s", KEYCHAIN_SERVICE, "-w"]);
            masked = maskKey(secret);
          } catch {
            /* item was removed out-of-band */
          }
          return { provider, masked };
        });
      },
      remove(provider) {
        try {
          deps.exec(["delete-generic-password", "-a", provider, "-s", KEYCHAIN_SERVICE]);
        } catch {
          /* not in keychain; still drop from index below */
        }
        const names = readJson<string[]>(indexPath, []).filter((n) => n !== provider);
        writeIndex(names);
      },
    };
  }

  // Fallback: plaintext file, locked to the owner.
  return {
    secure: false,
    add(provider, secret) {
      const map = readJson<Record<string, string>>(filePath, {});
      map[provider] = secret;
      writeFallbackFile(map);
    },
    list() {
      const map = readJson<Record<string, string>>(filePath, {});
      return Object.entries(map).map(([provider, secret]) => ({ provider, masked: maskKey(secret) }));
    },
    remove(provider) {
      const map = readJson<Record<string, string>>(filePath, {});
      delete map[provider];
      writeFallbackFile(map);
    },
  };
}

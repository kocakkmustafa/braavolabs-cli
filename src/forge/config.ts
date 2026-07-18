/**
 * braavo config — token + defaults live in ~/.braavo/config.json.
 *
 * The config shape (apiUrl/token/refreshToken) drives an identical
 * refresh-retry loop everywhere, plus a `defaultCompany` set by `braavo use`.
 * Paths are injectable so tests round-trip against a tmp file, never real $HOME.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Config {
  apiUrl: string;
  token?: string;
  refreshToken?: string;
  /** Default company id used by `braavo ask` when --company is omitted. */
  defaultCompany?: string;
}

export const CONFIG_DIR = join(homedir(), ".braavo");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_API =
  process.env.BRAAVO_API_URL ?? "https://braavolabs.com/api/v1";

export function loadConfig(path: string = CONFIG_PATH): Config {
  try {
    return { apiUrl: DEFAULT_API, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { apiUrl: DEFAULT_API };
  }
}

export function saveConfig(c: Config, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2));
}

export function clearConfig(path: string = CONFIG_PATH): void {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}

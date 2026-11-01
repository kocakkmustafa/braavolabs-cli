import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../forge/config";
/**
 * Daemon process bookkeeping under ~/.braavo/daemon/: the bearer token (0600),
 * and a state file with pid + port written once the API listens. Clients
 * (`braavo daemon status`, desktop sidecar) read these to find the daemon.
 */

export const DAEMON_DIR = join(CONFIG_DIR, "daemon");

export interface DaemonPaths { dir: string; token: string; state: string; log: string; db: string }

export function daemonPaths(root: string = CONFIG_DIR): DaemonPaths {
  const dir = join(root, "daemon");
  return { dir, token: join(dir, "token"), state: join(dir, "state.json"), log: join(dir, "daemon.log"), db: join(root, "braavo.db") };
}

/** Read the token, creating a random one (0600) on first use. */
export function ensureToken(paths: DaemonPaths): string {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (existsSync(paths.token)) {
    const token = readFileSync(paths.token, "utf8").trim();
    if (token.length >= 32) { chmodSync(paths.token, 0o600); return token; }
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(paths.token, token + "\n", { mode: 0o600 });
  return token;
}

export interface DaemonState { pid: number; port: number; startedAt: string; version: string }

export function writeState(paths: DaemonPaths, state: DaemonState): void {
  writeFileSync(paths.state, JSON.stringify(state) + "\n", { mode: 0o600 });
}

export function readState(paths: DaemonPaths): DaemonState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(paths.state, "utf8"));
    return Number.isInteger(parsed?.pid) && Number.isInteger(parsed?.port) ? parsed : undefined;
  } catch { return undefined; }
}

export function clearState(paths: DaemonPaths): void { rmSync(paths.state, { force: true }); }

/** True when a process with this pid exists (signal 0 probes without delivering). */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Live daemon state, or undefined (stale state files are removed). */
export function runningDaemon(paths: DaemonPaths): DaemonState | undefined {
  const state = readState(paths);
  if (!state) return undefined;
  if (isAlive(state.pid)) return state;
  clearState(paths);
  return undefined;
}

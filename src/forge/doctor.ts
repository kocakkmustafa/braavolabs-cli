/**
 * `braavo doctor` (BR-P1-002, roadmap §5.2: "doctor API host fingerprint,
 * keychain/config permission, sandbox, CLI vendor, MCP ve relay'i kontrol
 * eder").
 *
 * Deliberately does NOT require authentication: the most common reason to run
 * doctor is that authentication itself is what broke.
 */
import { statSync, existsSync } from "node:fs";
import { classifyApiHost, CONFIG_PATH, CONFIG_DIR, type Config } from "./config";
import { loadMcpConfig } from "./mcp";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** Local config file permissions. It holds a bearer token and a refresh token. */
function checkConfigPermissions(): Check {
  if (!existsSync(CONFIG_PATH)) {
    return { name: "config", status: "warn", detail: `${CONFIG_PATH} does not exist yet — run: braavo init` };
  }
  const mode = statSync(CONFIG_PATH).mode & 0o777;
  // Group/other readability on a file containing a refresh token is a real
  // finding on a shared machine, not a style preference.
  if (mode & 0o077) {
    return {
      name: "config permissions",
      status: "fail",
      detail: `${CONFIG_PATH} is mode ${mode.toString(8)} — it holds a refresh token. Fix: chmod 600 ${CONFIG_PATH}`,
    };
  }
  return { name: "config permissions", status: "ok", detail: `${mode.toString(8)} (owner-only)` };
}

function checkApiHost(cfg: Config): Check {
  const c = classifyApiHost(cfg.apiUrl);
  if (c.kind === "invalid") {
    return { name: "api host", status: "fail", detail: `${cfg.apiUrl} is unusable (${c.reason})` };
  }
  if (c.kind === "official") return { name: "api host", status: "ok", detail: `${c.origin} (official)` };
  if (c.kind === "loopback") return { name: "api host", status: "ok", detail: `${c.origin} (loopback/dev)` };
  if (!c.https) {
    return { name: "api host", status: "fail", detail: `${c.origin} is plaintext HTTP — credentials would cross the network in the clear` };
  }
  return {
    name: "api host",
    status: cfg.allowCustomHost ? "warn" : "fail",
    detail: cfg.allowCustomHost
      ? `${c.origin} (custom host, explicitly trusted via --allow-custom-host)`
      : `${c.origin} is not an official host and has NOT been trusted — credentials will be refused`,
  };
}

function checkCredentials(cfg: Config): Check {
  if (!cfg.token) return { name: "credentials", status: "warn", detail: "not logged in — run: braavo login" };
  // Report presence only. Never print, prefix or fingerprint the token itself:
  // doctor output is the single most likely thing to be pasted into an issue.
  return {
    name: "credentials",
    status: "ok",
    detail: `access token present${cfg.refreshToken ? " (+ refresh token)" : " (no refresh token — you will be logged out at expiry)"}`,
  };
}

async function checkApiReachable(cfg: Config, fetchImpl?: typeof fetch): Promise<Check> {
  const f = fetchImpl ?? globalThis.fetch;
  try {
    const res = await f(`${cfg.apiUrl}/health`, { method: "GET" });
    return res.ok
      ? { name: "api reachable", status: "ok", detail: `${cfg.apiUrl}/health → ${res.status}` }
      : { name: "api reachable", status: "fail", detail: `${cfg.apiUrl}/health → ${res.status}` };
  } catch (e) {
    return { name: "api reachable", status: "fail", detail: `${cfg.apiUrl} unreachable: ${(e as Error).message}` };
  }
}

function checkMcpServers(): Check {
  const n = Object.keys(loadMcpConfig()).length;
  return n
    ? { name: "mcp servers", status: "ok", detail: `${n} registered — inspect with: braavo mcp list` }
    : { name: "mcp servers", status: "warn", detail: "none registered" };
}

function checkSandbox(): Check {
  // Governed local execution depends on an OS sandbox. macOS ships
  // sandbox-exec; Linux relies on bubblewrap. Reporting honestly matters more
  // than claiming coverage — an unsandboxed host should say so.
  const platform = process.platform;
  if (platform === "darwin") return { name: "sandbox", status: "ok", detail: "darwin — sandbox-exec available" };
  if (platform === "linux") {
    return existsSync("/usr/bin/bwrap")
      ? { name: "sandbox", status: "ok", detail: "linux — bubblewrap present" }
      : { name: "sandbox", status: "warn", detail: "linux — bubblewrap (bwrap) NOT found; local execution is unsandboxed" };
  }
  return { name: "sandbox", status: "warn", detail: `${platform} — no supported sandbox; local execution is unsandboxed` };
}

export async function runDoctor(cfg: Config, fetchImpl?: typeof fetch): Promise<Check[]> {
  return [
    { name: "config dir", status: existsSync(CONFIG_DIR) ? "ok" : "warn", detail: CONFIG_DIR },
    checkConfigPermissions(),
    checkApiHost(cfg),
    checkCredentials(cfg),
    await checkApiReachable(cfg, fetchImpl),
    checkMcpServers(),
    checkSandbox(),
  ];
}

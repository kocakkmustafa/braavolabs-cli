import { withRequestScope } from "./request-scope";
import { t, numberText } from "./locale";
/**
 * `braavo doctor` (BR-P1-002, roadmap §5.2: "doctor API host fingerprint,
 * keychain/config permission, sandbox, CLI vendor, MCP ve relay'i kontrol
 * eder").
 *
 * Deliberately does NOT require authentication: the most common reason to run
 * doctor is that authentication itself is what broke.
 */
import { statSync, existsSync } from "node:fs";
import { classifyApiHost, apiHostReasonText, CONFIG_PATH, CONFIG_DIR, type Config } from "./config";
import { loadMcpConfig } from "./mcp";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

// Diagnostics retain their English machine contract. Only this authored metadata
// is translated in the human renderer; paths, hosts and transport errors are values.
const humanText = new WeakMap<Check, { source: string; values: unknown[] }>();
function check(name: string, status: Check["status"], source: string, ...values: unknown[]): Check {
  const result = { name, status, detail: source.replace(/\{(\d+)\}/g, (_match, i) => String(values[Number(i)] ?? "")) };
  humanText.set(result, { source, values });
  return result;
}
export function humanDoctorCheck(result: Check): Check {
  const text = humanText.get(result);
  return { ...result, name: t(result.name), detail: text ? t(text.source, ...text.values.map((value, i) => text.source === "{0} is unusable ({1})" && i === 1 ? apiHostReasonText(String(value)) : typeof value === "number" ? numberText(value) : value)) : result.detail };
}

/** Local config file permissions. It holds a bearer token and a refresh token. */
function checkConfigPermissions(): Check {
  if (!existsSync(CONFIG_PATH)) {
    return check("config", "warn", "{0} does not exist yet — run: braavo init", CONFIG_PATH);
  }
  const mode = statSync(CONFIG_PATH).mode & 0o777;
  // Group/other readability on a file containing a refresh token is a real
  // finding on a shared machine, not a style preference.
  if (mode & 0o077) {
    return check("config permissions", "fail", "{0} is mode {1} — it holds a refresh token. Fix: chmod 600 {0}", CONFIG_PATH, mode.toString(8));
  }
  return check("config permissions", "ok", "{0} (owner-only)", mode.toString(8));
}

function checkApiHost(cfg: Config): Check {
  const c = classifyApiHost(cfg.apiUrl);
  if (c.kind === "invalid") {
    return check("api host", "fail", "{0} is unusable ({1})", cfg.apiUrl, c.reason);
  }
  if (c.kind === "official") return check("api host", "ok", "{0} (official)", c.origin);
  if (c.kind === "loopback") return check("api host", "ok", "{0} (loopback/dev)", c.origin);
  if (!c.https) {
    return check("api host", "fail", "{0} is plaintext HTTP — credentials would cross the network in the clear", c.origin);
  }
  return check("api host", cfg.allowCustomHost ? "warn" : "fail", cfg.allowCustomHost
    ? "{0} (custom host, explicitly trusted via --allow-custom-host)"
    : "{0} is not an official host and has NOT been trusted — credentials will be refused", c.origin);
}

function checkCredentials(cfg: Config): Check {
  if (!cfg.token) return check("credentials", "warn", "not logged in — run: braavo login");
  // Report presence only. Never print, prefix or fingerprint the token itself:
  // doctor output is the single most likely thing to be pasted into an issue.
  return check("credentials", "ok", cfg.refreshToken ? "access token present (+ refresh token)" : "access token present (no refresh token — you will be logged out at expiry)");
}

async function checkApiReachable(cfg: Config, fetchImpl?: typeof fetch): Promise<Check> {
  const f = fetchImpl ?? globalThis.fetch;
  try {
    const res = await withRequestScope({}, async scope => {
      const response = await scope.wait(f(`${cfg.apiUrl}/health`, { method: "GET", signal: scope.signal }));
      // The health check needs only headers. Release the unused response body
      // within the same deadline rather than leaving a socket/body outstanding.
      await scope.wait(Promise.resolve(response.body?.cancel()));
      return response;
    });
    return check("api reachable", res.ok ? "ok" : "fail", "{0}/health → {1}", cfg.apiUrl, String(res.status));
  } catch (e) {
    return check("api reachable", "fail", "{0} unreachable: {1}", cfg.apiUrl, (e as Error).message);
  }
}

function checkMcpServers(): Check {
  const n = Object.keys(loadMcpConfig()).length;
  return n
    ? check("mcp servers", "ok", "{0} registered — inspect with: braavo mcp list", n)
    : check("mcp servers", "warn", "none registered");
}

function checkSandbox(): Check {
  // Governed local execution depends on an OS sandbox. macOS ships
  // sandbox-exec; Linux relies on bubblewrap. Reporting honestly matters more
  // than claiming coverage — an unsandboxed host should say so.
  const platform = process.platform;
  if (platform === "darwin") return check("sandbox", "ok", "darwin — sandbox-exec available");
  if (platform === "linux") {
    return existsSync("/usr/bin/bwrap")
      ? check("sandbox", "ok", "linux — bubblewrap present")
      : check("sandbox", "warn", "linux — bubblewrap (bwrap) NOT found; local execution is unsandboxed");
  }
  return check("sandbox", "warn", "{0} — no supported sandbox; local execution is unsandboxed", platform);
}

export async function runDoctor(cfg: Config, fetchImpl?: typeof fetch): Promise<Check[]> {
  return [
    check("config dir", existsSync(CONFIG_DIR) ? "ok" : "warn", "{0}", CONFIG_DIR),
    checkConfigPermissions(),
    checkApiHost(cfg),
    checkCredentials(cfg),
    await checkApiReachable(cfg, fetchImpl),
    checkMcpServers(),
    checkSandbox(),
  ];
}

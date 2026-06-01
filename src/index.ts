#!/usr/bin/env node
/**
 * braavo — Braavolabs CLI (Pillar 7).
 *
 * Dep-free: Node 20+ global fetch + built-ins only. Terminal control of the
 * same surface the web/mobile use — log in (BYOK token), list/trigger runs,
 * steer a live run, and inspect external connections. Token lives in
 * ~/.braavo/config.json; a 401 transparently refreshes once and retries.
 *
 * For self-hosters: `braavo login --api https://your-host/api/v1 --token <jwt>`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CONFIG_DIR = join(homedir(), ".braavo");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_API = process.env.BRAAVO_API_URL ?? "https://braavolabs.com/api/v1";

interface Config {
  apiUrl: string;
  token?: string;
  refreshToken?: string;
}

function loadConfig(): Config {
  try {
    return { apiUrl: DEFAULT_API, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { apiUrl: DEFAULT_API };
  }
}

function saveConfig(c: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

// ── arg parsing: braavo <cmd> [positionals...] [--flag value] ──
const argv = process.argv.slice(2);
const cmd = argv[0];
const positionals: string[] = [];
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  } else {
    positionals.push(a);
  }
}

async function apiFetch(
  path: string,
  opts: { method?: string; body?: unknown; cfg: Config; auth?: boolean },
): Promise<any> {
  const { cfg } = opts;
  const authed = opts.auth !== false;
  const doFetch = (tok?: string) =>
    fetch(`${cfg.apiUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

  let res = await doFetch(authed ? cfg.token : undefined);

  // Transparent single refresh on 401 (mirrors web/mobile).
  if (res.status === 401 && authed && cfg.refreshToken && !path.startsWith("/auth/")) {
    const r = await fetch(`${cfg.apiUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: cfg.refreshToken }),
    });
    if (r.ok) {
      const d = (await r.json()) as { token: string; refreshToken?: string };
      cfg.token = d.token;
      if (d.refreshToken) cfg.refreshToken = d.refreshToken;
      saveConfig(cfg);
      res = await doFetch(cfg.token);
    }
  }

  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    die(`API ${res.status}: ${b.error ?? b.message ?? res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}

function requireAuth(cfg: Config): void {
  if (!cfg.token) die("Not logged in. Run: braavo login");
}

const HELP = `braavo — Braavolabs CLI

Usage:
  braavo login [--email <e> --password <p> | --token <jwt>] [--api <url>]
  braavo whoami
  braavo runs
  braavo run <pipelineId>
  braavo steer <runId> <message...>
  braavo connections
  braavo logout

Config: ~/.braavo/config.json
Env:    BRAAVO_API_URL overrides the default API base.`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (flags.api) {
    cfg.apiUrl = flags.api;
    saveConfig(cfg);
  }

  switch (cmd) {
    case "login": {
      if (flags.token) {
        cfg.token = flags.token;
        saveConfig(cfg);
        ok("Token saved.");
        return;
      }
      const email = flags.email ?? (await prompt("Email: "));
      const password = flags.password ?? (await prompt("Password: "));
      const d = await apiFetch("/auth/login", { method: "POST", body: { email, password }, cfg, auth: false });
      cfg.token = d.token;
      cfg.refreshToken = d.refreshToken;
      saveConfig(cfg);
      ok(`Logged in as ${d.user?.email ?? email} · ${cfg.apiUrl}`);
      return;
    }

    case "logout": {
      try {
        rmSync(CONFIG_PATH);
      } catch {
        /* already gone */
      }
      ok("Logged out.");
      return;
    }

    case "whoami": {
      requireAuth(cfg);
      const d = await apiFetch("/users/me", { cfg });
      console.log(`${d.email}  ·  ${d.tenant?.name ?? "?"} (${d.tenant?.plan ?? "?"})`);
      return;
    }

    case "runs": {
      requireAuth(cfg);
      const d = await apiFetch("/dashboard/runs?limit=20", { cfg });
      const runs: any[] = d.runs ?? [];
      if (!runs.length) {
        console.log("No runs yet.");
        return;
      }
      for (const r of runs) {
        console.log(`${String(r.status ?? "").padEnd(10)}  ${r.id}  ${r.pipelineId ?? ""}`);
      }
      return;
    }

    case "run": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) die("usage: braavo run <pipelineId>");
      const d = await apiFetch(`/pipelines/${id}/run`, { method: "POST", body: { input: {} }, cfg });
      ok(`Run started: ${d.id}`);
      return;
    }

    case "steer": {
      requireAuth(cfg);
      const id = positionals[0];
      const message = positionals.slice(1).join(" ");
      if (!id || !message) die("usage: braavo steer <runId> <message...>");
      await apiFetch(`/runs/${id}/steer`, { method: "POST", body: { content: message }, cfg });
      ok("Steering sent — the agent picks it up on its next turn.");
      return;
    }

    case "connections": {
      requireAuth(cfg);
      const d = await apiFetch("/external-connections", { cfg });
      const list: any[] = Array.isArray(d) ? d : [];
      if (!list.length) {
        console.log("No connections.");
        return;
      }
      for (const c of list) {
        console.log(`${String(c.status ?? "").padEnd(8)}  ${String(c.platform ?? "").padEnd(7)}  ${c.label}  ${c.baseUrl}`);
      }
      return;
    }

    default: {
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
    }
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));

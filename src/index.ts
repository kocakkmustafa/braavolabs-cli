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
  opts: { method?: string; body?: unknown; cfg: Config; auth?: boolean; raw?: boolean },
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

  // raw mode: hand the caller status + parsed body so it can branch on codes
  // (e.g. 409 CHECKPOINT_PENDING retries) instead of dying on any non-2xx.
  if (opts.raw) {
    const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { status: res.status, statusText: res.statusText, body };
  }

  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    die(`API ${res.status}: ${b.error ?? b.message ?? res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  braavo handoffs [--open]
  braavo handoff <runId> [--reason <text>]
  braavo continue <runId> --provider <P> [--model <m>] [--base-url <u>]
  braavo connections
  braavo logout

Handoff — hand a live run to a different AI provider (cross-model handoff):
  handoffs            list this tenant's handoff ledger (--open = OPEN only)
  handoff <runId>     request a handoff; freezes a checkpoint, opens the ledger
  continue <runId>    claim the OPEN handoff and resume on --provider (e.g. OLLAMA)

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

    case "handoffs": {
      requireAuth(cfg);
      const openOnly = flags.open === "true";
      const path = openOnly ? "/handoffs?status=OPEN" : "/handoffs";
      const d = await apiFetch(path, { cfg });
      const list: any[] = d.handoffs ?? [];
      if (!list.length) {
        console.log(openOnly ? "No open handoffs." : "No handoffs yet.");
        return;
      }
      for (const h of list) {
        const to = h.toProvider ? `→${h.toProvider}` : "";
        console.log(
          `${String(h.status ?? "").padEnd(9)}  ${h.id}  run=${h.runId}  from=${h.fromProvider ?? "?"}${to}  ${h.reason ?? ""}`,
        );
      }
      return;
    }

    case "handoff": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) die("usage: braavo handoff <runId> [--reason <text>]");
      const body: Record<string, unknown> = {};
      if (flags.reason && flags.reason !== "true") body.reason = flags.reason;
      const d = await apiFetch(`/runs/${id}/handoff`, { method: "POST", body, cfg });
      ok(`Handoff opened: ${d.handoffId}  (run ${d.status})`);
      if (d.checkpointPending) {
        console.log("  Checkpoint is freezing at the next turn boundary — then run: braavo continue " + id + " --provider <P>");
      } else {
        console.log("  Ready to claim. Run: braavo continue " + id + " --provider <P>");
      }
      return;
    }

    case "continue": {
      requireAuth(cfg);
      const id = positionals[0];
      const provider = flags.provider && flags.provider !== "true" ? flags.provider : "";
      if (!id || !provider) die("usage: braavo continue <runId> --provider <P> [--model <m>] [--base-url <u>]");
      const body: Record<string, unknown> = { provider };
      if (flags.model && flags.model !== "true") body.model = flags.model;
      if (flags["base-url"] && flags["base-url"] !== "true") body.baseUrl = flags["base-url"];

      // The takeover checkpoint may still be freezing on the live loop's next
      // turn boundary — the API answers 409 CHECKPOINT_PENDING until it lands.
      // Retry a few times with a short pause before giving up (plan §2.3a-3).
      const MAX_ATTEMPTS = 5;
      for (let attempt = 1; ; attempt++) {
        const r = await apiFetch(`/runs/${id}/continue`, { method: "POST", body, cfg, raw: true });
        if (r.status < 400) {
          ok(`Handoff claimed: ${r.body.handoffId}  →  ${r.body.toProvider}/${r.body.toModel}  (run ${r.body.status})`);
          return;
        }
        const errMsg = r.body?.error ?? r.body?.message ?? r.statusText;
        if (r.status === 409 && attempt < MAX_ATTEMPTS) {
          console.log(`  Checkpoint still freezing (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in 2s…`);
          await sleep(2000);
          continue;
        }
        die(`API ${r.status}: ${errMsg}`);
      }
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

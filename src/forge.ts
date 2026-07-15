#!/usr/bin/env node
/**
 * forge — Braavolabs vibe-coding host (Pillar 7, terminal-noir).
 *
 * A second bin alongside `braavo`. Where braavo steers pipeline runs, forge is
 * the multi-model "council" surface: ask a question across several models
 * (compare), run the cheapest-capable-first cascade, inspect routing savings,
 * and manage LOCAL BYOK keys. Reuses braavo's config + single-401-refresh
 * patterns; token/defaults live in ~/.forge/config.json.
 *
 * ai morghulis · ai dohaeris.
 */
import { createInterface } from "node:readline";
import { Config, loadConfig, saveConfig, clearConfig } from "./forge/config";
import { makeUi, Ui } from "./forge/ui";
import {
  ApiError,
  login,
  startCompare,
  pollCompare,
  cascade,
  savings,
} from "./forge/client";
import { makeKeyStore } from "./forge/keys";
import {
  resolveOllamaHost,
  resolveOllamaModel,
  listOllamaModels,
  ollamaChat,
  OllamaUnreachableError,
} from "./forge/local";
import {
  DIRECT_PROVIDERS,
  DIRECT_DEFAULT_MODEL,
  DirectApiError,
  directChat,
  isDirectProvider,
} from "./forge/direct";
import {
  SPAWN_VENDORS,
  VENDOR_SPECS,
  findBinary,
  spawnVendor,
  probeVendor,
  isSpawnVendor,
  type SpawnVendor,
  type VendorStatus,
} from "./forge/spawn";
import { collectRepoContext, prependRepoContext } from "./forge/repo";
import {
  SUGGESTION_NOTE,
  defaultRunCmd,
  runFix,
  type AskFn,
  type FixOutcome,
} from "./forge/fix";
import {
  loadMcpConfig,
  saveMcpConfig,
  addMcpServer,
  removeMcpServer,
  parseMcpAdd,
  listServerTools,
  callServerTool,
  defaultMcpSpawn,
  type McpConfig,
  type McpTool,
  type McpCallResult,
} from "./forge/mcp";

// ── arg parsing: forge <cmd> [positionals...] [--flag value | --flag] ─────────
export interface ParsedArgs {
  cmd: string | undefined;
  positionals: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
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
  return { cmd, positionals, flags };
}

const flag = (flags: Record<string, string>, key: string): string | undefined =>
  flags[key] !== undefined && flags[key] !== "true" ? flags[key] : undefined;

// ── formatting helpers (money / tokens) ──────────────────────────────────────
function usd(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0";
  return v >= 1 || v === 0 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}
function tokens(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "0";
}

/** Extract a genuine savings figure from compare findings, or null. Never fabricated. */
export function extractSaved(findings: any): { usd: number; tokens: number } | null {
  const mm = findings?.multiModel ?? findings;
  const su = mm?.savedUsd ?? findings?.savedUsd;
  const st = mm?.savedTokens ?? findings?.savedTokens;
  if (typeof su === "number" && Number.isFinite(su)) {
    return { usd: su, tokens: typeof st === "number" ? st : 0 };
  }
  return null;
}

// ── renderers (pure: ui in, string[] out — unit-tested) ───────────────────────
export function renderCompareLines(ui: Ui, session: any): string[] {
  const out: string[] = [];
  const findings = session?.findings ?? {};
  const mm = findings.multiModel ?? {};

  // per-model answers may arrive as a record {model: answer|obj} or an array.
  const perModel = mm.perModel ?? {};
  const entries: Array<[string, any]> = Array.isArray(perModel)
    ? perModel.map((e: any, i: number) => [String(e?.model ?? e?.provider ?? `model ${i + 1}`), e])
    : Object.entries(perModel);

  for (const [model, val] of entries) {
    const answer = typeof val === "string" ? val : (val?.answer ?? val?.text ?? "");
    out.push(ui.primary(`── ${model} ──`));
    if (answer) out.push(String(answer));
    out.push("");
  }

  const synthesis = mm.finalAnswer ?? mm.consensus ?? findings.summary;
  if (synthesis) {
    out.push(ui.primary("── synthesis ──"));
    out.push(String(synthesis));
  }

  const saved = extractSaved(findings);
  if (saved) {
    out.push(ui.ember(`≈ saved ${usd(saved.usd)} · ${tokens(saved.tokens)} tokens`));
  }
  return out;
}

export function renderCascadeLines(ui: Ui, res: any): string[] {
  const out: string[] = [];
  out.push(String(res?.answer ?? ""));
  out.push("");
  const conf = typeof res?.confidence === "number" ? `${Math.round(res.confidence * 100)}%` : "?";
  const esc = res?.escalated ? "escalated" : "no escalation";
  out.push(
    ui.steel(
      `${res?.provider ?? "?"}/${res?.model ?? "?"} · tier=${res?.tier ?? "?"} · confidence=${conf} · ${esc} · ${usd(res?.totalCostUsd)}`,
    ),
  );
  const attempts: any[] = Array.isArray(res?.attempts) ? res.attempts : [];
  if (attempts.length > 1) {
    for (const a of attempts) {
      out.push(ui.dim(`  ↳ ${a?.provider}/${a?.model} tier=${a?.tier} conf=${Math.round((a?.confidence ?? 0) * 100)}% ${usd(a?.costUsd)}`));
    }
  }
  if (res?.stoppedReason) out.push(ui.dim(`  stopped: ${res.stoppedReason}`));
  return out;
}

export function renderSavingsTable(ui: Ui, data: any): string[] {
  const r = data?.report ?? {};
  const b = r.breakdown ?? {};
  const days = data?.period?.days ?? "?";
  const pct = typeof r.savedPct === "number" ? ` (${Math.round(r.savedPct)}%)` : "";
  const row = (label: string, value: string, accent = false): string =>
    `${ui.steel(label.padEnd(16))}${accent ? ui.primary(value) : value}`;

  const out: string[] = [];
  out.push(row("period", `${days} days`));
  out.push(row("actual", usd(r.actualUsd)));
  out.push(row("baseline", usd(r.baselineUsd)));
  out.push(row("saved", `${usd(r.savedUsd)}${pct}`, true));
  out.push(row("saved tokens", tokens(r.savedTokens)));
  out.push(ui.primary("── breakdown ──"));
  out.push(row("cheap routing", usd(b.cheapRoutingUsd)));
  out.push(row("cache", usd(b.cacheUsd)));
  out.push(row("retrieval", usd(b.retrievalUsd)));
  if (data?.note) out.push(ui.dim(String(data.note)));
  return out;
}

export function renderModelsTable(
  ui: Ui,
  data: { ollamaHost: string; ollamaReachable: boolean; ollamaModels: string[]; keyProviders: string[] },
): string[] {
  const out: string[] = [];
  out.push(ui.primary("── local (Ollama) ──"));
  out.push(ui.steel(`  host: ${data.ollamaHost}`));
  if (!data.ollamaReachable) {
    out.push(ui.dim("  not reachable — is it running?"));
  } else if (!data.ollamaModels.length) {
    out.push(ui.dim("  no models installed — run: ollama pull <model>"));
  } else {
    for (const m of data.ollamaModels) out.push(`  ${ui.primary(m)}`);
  }
  out.push("");
  out.push(ui.primary("── direct (BYOK) ──"));
  for (const provider of DIRECT_PROVIDERS) {
    const has = data.keyProviders.includes(provider);
    const label = has ? ui.primary("key stored") : ui.dim("no key — forge keys add " + provider);
    out.push(`  ${provider.padEnd(10)} ${label}`);
  }
  return out;
}

// ── spawn (Lane-B) renderers ──────────────────────────────────────────────────
/** One-line, steel ToS-risk note shown before a spawn (suppressible via --quiet). */
export function spawnRiskLine(ui: Ui, vendor: SpawnVendor): string {
  return ui.steel(`· ${VENDOR_SPECS[vendor].risk}`);
}

/** Honest "not installed" message + the graceful API-key fallback (rule g). */
export function spawnFallbackLines(ui: Ui, vendor: SpawnVendor): string[] {
  return [
    ui.fail(`${vendor} CLI not found. Log in with the official ${vendor} binary first, or use API-key mode:`),
    `  ${ui.primary(VENDOR_SPECS[vendor].fallback)}`,
  ];
}

/** `spawn --list`: installed-or-not + version, per vendor. Never probes login state. */
export function renderSpawnList(ui: Ui, statuses: VendorStatus[]): string[] {
  const out: string[] = [];
  out.push(ui.primary("── spawn vendors (your own authenticated CLI) ──"));
  for (const s of statuses) {
    const state = s.installed
      ? ui.primary(`installed${s.version ? ` · ${s.version}` : ""}`)
      : ui.dim("not installed");
    out.push(`  ${s.vendor.padEnd(8)} ${state}`);
    out.push(`  ${" ".repeat(8)} ${ui.steel(s.risk)}`);
  }
  return out;
}

// ── fix (P-C4) renderers ──────────────────────────────────────────────────────
/** Suggestion-only output; green short-circuit prints an arc line and no model text. */
export function renderFixLines(ui: Ui, outcome: FixOutcome): string[] {
  if (outcome.green) {
    return [ui.primary("✓ tests already green")];
  }
  return [
    ui.steel(`· ${SUGGESTION_NOTE}`),
    ui.dim(`  (exit ${outcome.code} — forge never applies changes)`),
    "",
    String(outcome.suggestion ?? ""),
  ];
}

// ── mcp (P-C4) renderers ──────────────────────────────────────────────────────
export function renderMcpList(ui: Ui, cfg: McpConfig): string[] {
  const names = Object.keys(cfg).sort();
  if (!names.length) {
    return [ui.dim("No MCP servers. Add one: forge mcp add <name> -- <command> [args...]")];
  }
  const out = [ui.primary("── mcp servers ──")];
  for (const name of names) {
    const def = cfg[name];
    out.push(`  ${ui.primary(name.padEnd(16))} ${ui.steel(`${def.command} ${def.args.join(" ")}`.trim())}`);
  }
  return out;
}

export function renderMcpTools(ui: Ui, server: string, tools: McpTool[]): string[] {
  const out = [ui.primary(`── ${server} · tools (${tools.length}) ──`)];
  if (!tools.length) {
    out.push(ui.dim("  (server exposed no tools)"));
    return out;
  }
  const width = Math.min(28, Math.max(...tools.map((t) => t.name.length)));
  for (const t of tools) {
    const desc = (t.description ?? "").split("\n")[0];
    out.push(`  ${ui.primary(t.name.padEnd(width))}  ${ui.steel(desc)}`.trimEnd());
  }
  return out;
}

export function renderMcpCallResult(ui: Ui, result: McpCallResult): string[] {
  const texts = result.content.filter((c) => typeof c.text === "string").map((c) => String(c.text));
  const body = texts.length ? texts.join("\n") : "(no textual content)";
  if (result.isError) {
    return [ui.fail("tool reported an error:"), body];
  }
  return [body];
}

/**
 * Resolve the optional --repo context block. `enabled` is presence of --repo.
 * Dies with an honest error when --repo is set but cwd is not a git repo, so we
 * never silently drop the context the user asked for.
 */
function resolveRepoBlock(enabled: boolean, die: (msg: string) => never, ui: Ui): string | undefined {
  if (!enabled) return undefined;
  const res = collectRepoContext({ cwd: process.cwd() });
  if (!res.ok) die(res.error);
  if (res.truncated) console.error(ui.dim("· repo context exceeded 4KB — truncated"));
  return res.text;
}

// ── interactive helpers ───────────────────────────────────────────────────────
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}

/** Read a secret without echoing it to the terminal. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let primed = false;
    // Suppress echo of typed characters; still show the question once.
    (rl as any)._writeToOutput = (str: string) => {
      if (!primed) {
        process.stdout.write(str);
        primed = true;
      }
    };
    rl.question(question, (ans) => {
      rl.close();
      process.stdout.write("\n");
      resolve(ans.trim());
    });
  });
}

const HELP = (ui: Ui): string => {
  const p = (s: string) => ui.primary(s);
  return `${ui.bold("> forge")} — ${ui.ember("ai morghulis · ai dohaeris")}

${ui.steel("Usage")}
  ${p("forge login")}   --api <url> --token <jwt>   |  --email <e> --password <p>
  ${p("forge use")}     <companyId>                 set the default company
  ${p("forge ask")}     "<question>" [--company <id>] [--models a,b,c] [--repo]
  ${p("forge cascade")} "<question>" [--threshold <0-1>] [--second-opinion] [--budget <usd>]
  ${p("forge savings")} [--days <1-90>]
  ${p("forge keys")}    add <provider> [--key <secret>] | list | rm <provider>
  ${p("forge local")}   "<question>" [--model <name>] [--host <url>] [--repo]
  ${p("forge direct")}  <provider> "<question>" [--model <name>] [--repo]
  ${p("forge fix")}     --cmd "<test-command>" [--via local|direct|ask] [--provider <p>] [--repo]
  ${p("forge mcp")}     add <name> -- <command> [args...] | list | rm <name> | tools <name> | call <name> <tool> [--json '<args>']
  ${p("forge spawn")}   <claude|codex> [...args] [--dir <path>] [--quiet]  |  --list
  ${p("forge models")}  list local Ollama models + BYOK providers with a stored key
  ${p("forge logout")}

${ui.steel("ask")}      one question, several models, side-by-side (async compare + poll)
${ui.steel("cascade")}  cheapest-capable-first; escalates only on low confidence
${ui.steel("keys")}     LOCAL BYOK storage (macOS keychain / chmod-600 file) — never sent to the server
${ui.steel("local")}    serverless, keyless — talks straight to a local Ollama daemon
${ui.steel("direct")}   serverless BYOK — one-shot completion straight to ${DIRECT_PROVIDERS.join("/")}
${ui.steel("fix")}      runs YOUR test command; on failure asks a model for a fix (suggestion-only, never applied)
${ui.steel("mcp")}      dep-free Model Context Protocol stdio client — register servers, list & call their tools
${ui.steel("--repo")}   ask/local/direct/fix: prepend git branch + status + recent commits + diff --stat (≤4KB)
${ui.steel("spawn")}    runs YOUR own authenticated ${SPAWN_VENDORS.join("/")} CLI as a child — opaque passthrough, no vendor OAuth

Config: ~/.forge/config.json   ·   Env: FORGE_API_URL overrides the API base.
Ollama: OLLAMA_HOST overrides the local daemon base (default http://localhost:11434).`;
};

async function main(): Promise<void> {
  const ui = makeUi();
  // Function declarations (not const arrows) so control-flow analysis narrows
  // through the `never` guard sites below (e.g. `if (!x) die(...)`).
  function die(msg: string): never {
    console.error(ui.fail(msg));
    process.exit(1);
  }
  function requireAuth(cfg: Config): void {
    if (!cfg.token) die("Not logged in. Run: forge login");
  }

  const { cmd, positionals, flags } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (flag(flags, "api")) {
    cfg.apiUrl = flag(flags, "api")!;
    saveConfig(cfg);
  }

  switch (cmd) {
    case "login": {
      const token = flag(flags, "token");
      if (token) {
        cfg.token = token;
        saveConfig(cfg);
        ui.ok(`Token saved · ${cfg.apiUrl}`);
        return;
      }
      const email = flag(flags, "email") ?? (await prompt("Email: "));
      const password = flag(flags, "password") ?? (await promptHidden("Password: "));
      const d = await login(cfg, { email, password });
      cfg.token = d.token;
      cfg.refreshToken = d.refreshToken;
      saveConfig(cfg);
      ui.ok(`Logged in as ${d.user?.email ?? email} · ${d.tenant?.name ?? cfg.apiUrl}`);
      return;
    }

    case "logout": {
      clearConfig();
      ui.ok("Logged out.");
      return;
    }

    case "use": {
      const company = positionals[0];
      if (!company) die("usage: forge use <companyId>");
      cfg.defaultCompany = company;
      saveConfig(cfg);
      ui.ok(`Default company set: ${company}`);
      return;
    }

    case "ask": {
      requireAuth(cfg);
      let query = positionals.join(" ").trim();
      if (!query) die('usage: forge ask "<question>" [--company <id>] [--models a,b,c] [--repo]');
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const companyId = flag(flags, "company") ?? cfg.defaultCompany;
      if (!companyId) die("No company. Run: forge use <companyId>  (or pass --company <id>)");

      // --models a,b,c → count drives maxCandidates (the endpoint picks the
      // tenant's own configured providers; names aren't sent). Clamp 1..3.
      const modelsFlag = flag(flags, "models");
      let maxCandidates: number | undefined;
      if (modelsFlag) {
        const n = modelsFlag.split(",").map((s) => s.trim()).filter(Boolean).length;
        maxCandidates = Math.min(3, Math.max(1, n));
      }

      const n = maxCandidates ?? 3;
      const spin = ui.spinner(`asking ${n} faces…`);
      try {
        const stub = await startCompare(cfg, { companyId, query, maxCandidates });
        spin.update(`asking ${n} faces… (session ${stub.id})`);
        const session = await pollCompare(cfg, stub.id, {
          onTick: (status) => spin.update(`asking ${n} faces… (${status.toLowerCase()})`),
        });
        spin.stop();
        if (String(session.status) === "FAILED") {
          die(`Compare failed: ${session.error ?? "unknown error"}`);
        }
        for (const line of renderCompareLines(ui, session)) console.log(line);
      } catch (e) {
        spin.stop();
        throw e;
      }
      return;
    }

    case "cascade": {
      requireAuth(cfg);
      const promptText = positionals.join(" ").trim();
      if (!promptText) die('usage: forge cascade "<question>" [--threshold <0-1>] [--second-opinion] [--budget <usd>]');
      const params: Parameters<typeof cascade>[1] = { prompt: promptText };
      const threshold = flag(flags, "threshold");
      if (threshold) params.confidenceThreshold = Number(threshold);
      if (flags["second-opinion"] === "true") params.secondOpinion = true;
      const budget = flag(flags, "budget");
      if (budget) params.budgetUsdCap = Number(budget);

      const spin = ui.spinner("cascading…");
      try {
        const res = await cascade(cfg, params);
        spin.stop();
        for (const line of renderCascadeLines(ui, res)) console.log(line);
      } catch (e) {
        spin.stop();
        throw e;
      }
      return;
    }

    case "savings": {
      requireAuth(cfg);
      const daysFlag = flag(flags, "days");
      const days = daysFlag ? Number(daysFlag) : undefined;
      const data = await savings(cfg, { days });
      for (const line of renderSavingsTable(ui, data)) console.log(line);
      return;
    }

    case "local": {
      let query = positionals.join(" ").trim();
      if (!query) die('usage: forge local "<question>" [--model <name>] [--host <url>] [--repo]');
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const host = resolveOllamaHost(flag(flags, "host"));
      const spin = ui.spinner("asking local model…");
      try {
        const model = await resolveOllamaModel(host, flag(flags, "model"));
        spin.update(`asking ${model}…`);
        const res = await ollamaChat(host, model, query);
        spin.stop();
        console.log(res.content);
      } catch (e) {
        spin.stop();
        if (e instanceof OllamaUnreachableError) die(e.message);
        throw e;
      }
      return;
    }

    case "direct": {
      const provider = positionals[0];
      let query = positionals.slice(1).join(" ").trim();
      if (!provider || !query) die('usage: forge direct <provider> "<question>" [--model <name>] [--repo]');
      if (!isDirectProvider(provider)) {
        die(`Unknown provider "${provider}". Supported: ${DIRECT_PROVIDERS.join(", ")}`);
      }
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const store = makeKeyStore();
      const apiKey = store.get(provider);
      if (!apiKey) die(`no key stored — run: forge keys add ${provider}`);
      const model = flag(flags, "model") ?? DIRECT_DEFAULT_MODEL[provider];
      const spin = ui.spinner(`asking ${provider}/${model}…`);
      try {
        const res = await directChat(provider, apiKey, model, query);
        spin.stop();
        console.log(res.content);
      } catch (e) {
        spin.stop();
        if (e instanceof DirectApiError) die(`${e.provider} ${e.status}: ${e.message}`);
        throw e;
      }
      return;
    }

    case "models": {
      const host = resolveOllamaHost(flag(flags, "host"));
      let ollamaReachable = true;
      let ollamaModels: string[] = [];
      try {
        ollamaModels = await listOllamaModels(host);
      } catch (e) {
        if (e instanceof OllamaUnreachableError) ollamaReachable = false;
        else throw e;
      }
      const store = makeKeyStore();
      const keyProviders = store.list().map((k) => k.provider);
      for (const line of renderModelsTable(ui, { ollamaHost: host, ollamaReachable, ollamaModels, keyProviders })) {
        console.log(line);
      }
      return;
    }

    case "spawn": {
      // --list: report installed-or-not (+ version) for each vendor. No token peeking.
      if (flags["list"] === "true" || positionals[0] === "list") {
        const statuses = SPAWN_VENDORS.map((v) => probeVendor(v));
        for (const line of renderSpawnList(ui, statuses)) console.log(line);
        return;
      }
      const vendor = positionals[0];
      if (!vendor || !isSpawnVendor(vendor)) {
        die(`usage: forge spawn <${SPAWN_VENDORS.join("|")}> [...args]  |  forge spawn --list`);
      }
      // Everything after the vendor is passed VERBATIM to the child (arg array —
      // no shell, no injection). --dir carves out its own working directory but
      // is not forwarded to the vendor; every other token is.
      const passthrough: string[] = [];
      let cwd: string | undefined;
      let quiet = false;
      const rest = process.argv.slice(2);
      const vIdx = rest.indexOf(vendor);
      for (let i = vIdx + 1; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--dir") {
          cwd = rest[++i];
        } else if (a === "--quiet") {
          quiet = true;
        } else {
          passthrough.push(a);
        }
      }
      const binPath = findBinary(vendor);
      if (!binPath) {
        for (const line of spawnFallbackLines(ui, vendor)) console.error(line);
        process.exit(1);
      }
      if (!quiet) console.error(spawnRiskLine(ui, vendor));
      try {
        const code = await spawnVendor(binPath, passthrough, { cwd });
        process.exit(code); // own the child's exit code verbatim
      } catch {
        // Spawn itself failed (binary vanished / not executable) → graceful fallback.
        for (const line of spawnFallbackLines(ui, vendor)) console.error(line);
        process.exit(1);
      }
      return;
    }

    case "fix": {
      const testCmd = flag(flags, "cmd");
      if (!testCmd) {
        die('usage: forge fix --cmd "<test-command>" [--via local|direct|ask] [--provider <p>] [--repo]');
      }
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      const via = flag(flags, "via") ?? "ask";
      // Resolve the backend that turns a failure payload into a suggestion.
      // Only ever invoked when the command FAILS (cost honesty lives in runFix).
      let ask: AskFn;
      if (via === "local") {
        const host = resolveOllamaHost(flag(flags, "host"));
        ask = async (p) => {
          const model = await resolveOllamaModel(host, flag(flags, "model"));
          return (await ollamaChat(host, model, p)).content;
        };
      } else if (via === "direct") {
        const provider = flag(flags, "provider");
        if (!provider || !isDirectProvider(provider)) {
          die(`--via direct needs --provider <${DIRECT_PROVIDERS.join("|")}>`);
        }
        const store = makeKeyStore();
        const apiKey = store.get(provider);
        if (!apiKey) die(`no key stored — run: forge keys add ${provider}`);
        const model = flag(flags, "model") ?? DIRECT_DEFAULT_MODEL[provider];
        ask = async (p) => (await directChat(provider, apiKey, model, p)).content;
      } else if (via === "ask") {
        requireAuth(cfg);
        ask = async (p) => String((await cascade(cfg, { prompt: p }))?.answer ?? "");
      } else {
        die(`unknown --via "${via}". Use: local | direct | ask`);
      }

      const spin = ui.spinner(`running: ${testCmd}`);
      try {
        const outcome = await runFix(testCmd, { run: defaultRunCmd, ask, repoBlock });
        spin.stop();
        for (const line of renderFixLines(ui, outcome)) console.log(line);
        if (!outcome.green) process.exitCode = outcome.code;
      } catch (e) {
        spin.stop();
        if (e instanceof DirectApiError) die(`${e.provider} ${e.status}: ${e.message}`);
        if (e instanceof OllamaUnreachableError) die(e.message);
        throw e;
      }
      return;
    }

    case "mcp": {
      const sub = positionals[0];
      switch (sub) {
        case "add": {
          // Parse from raw argv — the "--" separator is deliberately handled here
          // (parseArgs treats "--" as a flag), so the server command is verbatim.
          const afterAdd = process.argv.slice(2).slice(2); // tokens after "mcp add"
          const parsed = parseMcpAdd(afterAdd);
          if ("error" in parsed) die(parsed.error);
          const next = addMcpServer(loadMcpConfig(), parsed.name, parsed.command, parsed.args);
          saveMcpConfig(next);
          ui.ok(`Added MCP server "${parsed.name}" → ${parsed.command} ${parsed.args.join(" ")}`.trim());
          return;
        }
        case "list": {
          for (const line of renderMcpList(ui, loadMcpConfig())) console.log(line);
          return;
        }
        case "rm": {
          const name = positionals[1];
          if (!name) die("usage: forge mcp rm <name>");
          const conf = loadMcpConfig();
          if (!conf[name]) die(`no such MCP server: ${name}`);
          saveMcpConfig(removeMcpServer(conf, name));
          ui.ok(`Removed MCP server "${name}".`);
          return;
        }
        case "tools": {
          const name = positionals[1];
          if (!name) die("usage: forge mcp tools <name>");
          const def = loadMcpConfig()[name];
          if (!def) die(`no such MCP server: ${name}  (add it: forge mcp add ${name} -- <command>)`);
          const timeoutMs = flag(flags, "timeout") ? Number(flag(flags, "timeout")) : undefined;
          const spin = ui.spinner(`${name}: initializing…`);
          try {
            const tools = await listServerTools(def, defaultMcpSpawn, {
              timeoutMs,
              onStderr: (c) => process.stderr.write(ui.steel(c)),
            });
            spin.stop();
            for (const line of renderMcpTools(ui, name, tools)) console.log(line);
          } catch (e) {
            spin.stop();
            throw e;
          }
          return;
        }
        case "call": {
          const name = positionals[1];
          const tool = positionals[2];
          if (!name || !tool) die("usage: forge mcp call <name> <tool> [--json '<args>'] [--timeout <ms>]");
          const def = loadMcpConfig()[name];
          if (!def) die(`no such MCP server: ${name}`);
          let toolArgs: Record<string, unknown> = {};
          const jsonFlag = flag(flags, "json");
          if (jsonFlag) {
            try {
              toolArgs = JSON.parse(jsonFlag);
            } catch {
              die(`--json is not valid JSON: ${jsonFlag}`);
            }
          }
          const timeoutMs = flag(flags, "timeout") ? Number(flag(flags, "timeout")) : undefined;
          const spin = ui.spinner(`${name}: calling ${tool}…`);
          try {
            const result = await callServerTool(def, tool, toolArgs, defaultMcpSpawn, {
              timeoutMs,
              onStderr: (c) => process.stderr.write(ui.steel(c)),
            });
            spin.stop();
            for (const line of renderMcpCallResult(ui, result)) console.log(line);
            if (result.isError) process.exitCode = 1;
          } catch (e) {
            spin.stop();
            throw e;
          }
          return;
        }
        default:
          die("usage: forge mcp add <name> -- <command> [args...] | list | rm <name> | tools <name> | call <name> <tool> [--json '<args>']");
      }
      return;
    }

    case "keys": {
      const sub = positionals[0];
      const store = makeKeyStore();
      switch (sub) {
        case "add": {
          const provider = positionals[1];
          if (!provider) die("usage: forge keys add <provider> [--key <secret>]");
          const secret = flag(flags, "key") ?? process.env.FORGE_KEY ?? (await promptHidden(`${provider} key: `));
          if (!secret) die("No key provided.");
          store.add(provider, secret);
          if (!store.secure) {
            ui.warn("Stored in ~/.forge/keys.json (chmod 600) — no OS keychain on this platform.");
          }
          // Show only a masked fingerprint; never echo the key.
          const shown = store.list().find((k) => k.provider === provider);
          ui.ok(`Stored ${provider} key ${shown?.masked ?? ""}`.trim());
          return;
        }
        case "list": {
          const entries = store.list();
          if (!entries.length) {
            ui.info("No keys stored.");
            return;
          }
          for (const e of entries) console.log(`${ui.primary(e.provider.padEnd(12))} ${ui.steel(e.masked)}`);
          if (!store.secure) ui.warn("Keys are in a plaintext file (chmod 600) — no OS keychain on this platform.");
          return;
        }
        case "rm": {
          const provider = positionals[1];
          if (!provider) die("usage: forge keys rm <provider>");
          store.remove(provider);
          ui.ok(`Removed ${provider} key.`);
          return;
        }
        default:
          die("usage: forge keys add <provider> | list | rm <provider>");
      }
      return;
    }

    default: {
      console.log(HELP(ui));
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
    }
  }
}

// Only run when invoked as the bin — importing this module (tests) is side-effect-free.
if (require.main === module) {
  main().catch((e) => {
    const ui = makeUi();
    console.error(ui.fail(e instanceof ApiError ? `API ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}

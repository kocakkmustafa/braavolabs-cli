#!/usr/bin/env node
/**
 * braavo — Braavolabs CLI (Pillar 7, terminal-noir).
 *
 * The single terminal surface for Braavolabs. Two families of commands live
 * side by side:
 *   • council   — ask a question across several models (compare), run the
 *                 cheapest-capable-first cascade, inspect routing savings, manage
 *                 LOCAL BYOK keys, serverless local/direct modes, safe-spawn,
 *                 suggest-a-fix, and a dep-free MCP stdio client.
 *   • pipelines — list/trigger runs, steer a live run, hand a run across provider
 *                 boundaries, and inspect external connections.
 * Near-dep-free: Node 20+ global fetch + built-ins only, except `zod` —
 * pulled in solely by the opt-in `spawn --bridge` companion relay (see
 * forge/relay-protocol.ts) to validate the sealed relay contract; every
 * other command stays on built-ins alone. Token/defaults live in
 * ~/.braavo/config.json; a 401 transparently refreshes once and retries.
 *
 * ai morghulis · ai dohaeris.
 */
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { Config, loadConfig, saveConfig, clearConfig, classifyApiHost } from "./forge/config";
import { makeUi, Ui } from "./forge/ui";
import {
  ApiError,
  apiFetch,
  login,
  logout,
  startCompare,
  pollCompare,
  cascade,
  savings,
  mediaPreview,
  mediaGenerate,
  mediaCatalog,
  mediaKeyPut,
  mediaKeyDelete,
} from "./forge/client";
import {
  IMAGE_MODELS,
  TTS_PROVIDERS,
  parseSize,
  estimateUsd,
  renderMediaPreview,
  renderImageResult,
  decodeAudio,
} from "./forge/media";
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
  spawnVendorBridged,
  makeChildRef,
  makeSpawnBridgeHandlers,
  probeVendor,
  isSpawnVendor,
  type SpawnVendor,
  type VendorStatus,
} from "./forge/spawn";
import { createRelayTransport } from "./forge/relay-transport";
import { RelayBridge } from "./forge/relay-bridge";
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

// ── arg parsing: braavo <cmd> [positionals...] [--flag value | --flag] ────────
export interface ParsedArgs {
  cmd: string | undefined;
  positionals: string[];
  // Bare boolean flags (`--quiet`) are stored as the boolean `true`; value
  // flags (`--cmd foo`) as the string. Keeping them distinct is what lets a
  // value that happens to be the literal string "true" (e.g. `--cmd true`,
  // running the `true` command) survive — see `flag()` / `has()`.
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true; // bare boolean flag
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

/** Value of a value-flag (`--k v` → "v"), or undefined for a bare/absent flag.
 * A value that is literally "true" (`--cmd true`) is returned as-is — only a
 * BARE `--k` (stored as boolean true) reads back as undefined. */
const flag = (flags: Record<string, string | boolean>, key: string): string | undefined =>
  typeof flags[key] === "string" ? (flags[key] as string) : undefined;

/** True when a boolean flag is present, bare (`--list`) or as `--list true`. */
const has = (flags: Record<string, string | boolean>, key: string): boolean =>
  flags[key] === true || flags[key] === "true";

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
    const label = has ? ui.primary("key stored") : ui.dim("no key — braavo keys add " + provider);
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
    ui.dim(`  (exit ${outcome.code} — braavo never applies changes)`),
    "",
    String(outcome.suggestion ?? ""),
  ];
}

// ── mcp (P-C4) renderers ──────────────────────────────────────────────────────
export function renderMcpList(ui: Ui, cfg: McpConfig): string[] {
  const names = Object.keys(cfg).sort();
  if (!names.length) {
    return [ui.dim("No MCP servers. Add one: braavo mcp add <name> -- <command> [args...]")];
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
  return `${ui.bold("> braavo")} — ${ui.ember("ai morghulis · ai dohaeris")}

${ui.steel("Council")}
  ${p("braavo login")}   --api <url> --token <jwt>   |  --email <e> --password <p>
  ${p("braavo use")}     <companyId>                 set the default company
  ${p("braavo ask")}     "<question>" [--company <id>] [--models a,b,c] [--repo]
  ${p("braavo cascade")} "<question>" [--threshold <0-1>] [--second-opinion] [--budget <usd>]
  ${p("braavo savings")} [--days <1-90>]
  ${p("braavo keys")}    add <provider> [--key <secret>] | list | rm <provider>
  ${p("braavo local")}   "<question>" [--model <name>] [--host <url>] [--repo]
  ${p("braavo direct")}  <provider> "<question>" [--model <name>] [--repo]
  ${p("braavo fix")}     --cmd "<test-command>" [--via local|direct|ask] [--provider <p>] [--repo]
  ${p("braavo mcp")}     add <name> -- <command> [args...] | list | rm <name> | tools <name> | call <name> <tool> [--json '<args>']
  ${p("braavo spawn")}   <claude|codex> [...args] [--dir <path>] [--quiet] [--bridge]  |  --list
  ${p("braavo models")}  list local Ollama models + BYOK providers with a stored key
  ${p("braavo logout")}

${ui.steel("Pipelines")}
  ${p("braavo whoami")}
  ${p("braavo runs")}
  ${p("braavo run")}       <pipelineId>
  ${p("braavo steer")}     <runId> <message...>
  ${p("braavo handoffs")}  [--open]
  ${p("braavo handoff")}   <runId> [--reason <text>]
  ${p("braavo continue")}  <runId> --provider <P> [--model <m>] [--base-url <u>]
  ${p("braavo connections")}

${ui.steel("ask")}      one question, several models, side-by-side (async compare + poll)
${ui.steel("cascade")}  cheapest-capable-first; escalates only on low confidence
${ui.steel("keys")}     LOCAL BYOK storage (macOS keychain / chmod-600 file) — never sent to the server
${ui.steel("local")}    serverless, keyless — talks straight to a local Ollama daemon
${ui.steel("direct")}   serverless BYOK — one-shot completion straight to ${DIRECT_PROVIDERS.join("/")}
${ui.steel("fix")}      runs YOUR test command; on failure asks a model for a fix (suggestion-only, never applied)
${ui.steel("mcp")}      dep-free Model Context Protocol stdio client — register servers, list & call their tools
${ui.steel("--repo")}   ask/local/direct/fix: prepend git branch + status + recent commits + diff --stat (≤4KB)
${ui.steel("spawn")}    runs YOUR own authenticated ${SPAWN_VENDORS.join("/")} CLI as a child — opaque passthrough, no vendor OAuth
${ui.steel("steer")}    send a real-time message to a live run; agent picks it up on its next turn
${ui.steel("handoff")}  hand a live run to a different AI provider (freeze checkpoint → continue on --provider)

Config: ~/.braavo/config.json   ·   Env: BRAAVO_API_URL overrides the API base.
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
    if (!cfg.token) die("Not logged in. Run: braavo login");
  }

  const { cmd, positionals, flags } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (flag(flags, "api")) {
    // BR-P0-004 — changing the API host is a trust decision, so it is made
    // HERE, once, and persisted next to the host it applies to. A later --api
    // pointing at a DIFFERENT unknown host is a fresh decision and must be
    // opted into again; apiFetch enforces this on every call.
    cfg.apiUrl = flag(flags, "api")!;
    cfg.allowCustomHost = flags["allow-custom-host"] === true ? true : undefined;
    const c = classifyApiHost(cfg.apiUrl);
    if (c.kind === "custom") {
      // Name the exact origin BEFORE any credential is sent, so the user can
      // see where their password would go. `origin` deliberately omits path
      // and query, which can carry a token.
      ui.warn(
        `API host is not an official Braavolabs address: ${c.origin}` +
          (cfg.allowCustomHost
            ? " — allowed by --allow-custom-host."
            : " — credentials will be refused. Re-run with --allow-custom-host if you self-host."),
      );
    }
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
      // Best-effort server-side refresh-token revocation before clearing local
      // creds, so the token can't be reused (audit C3). Never blocks logout.
      if (cfg.token) {
        try {
          await logout(cfg);
        } catch {
          /* offline / expired — local clear below still logs the user out */
        }
      }
      clearConfig();
      ui.ok("Logged out.");
      return;
    }

    case "use": {
      const company = positionals[0];
      if (!company) die("usage: braavo use <companyId>");
      cfg.defaultCompany = company;
      saveConfig(cfg);
      ui.ok(`Default company set: ${company}`);
      return;
    }

    case "ask": {
      requireAuth(cfg);
      let query = positionals.join(" ").trim();
      if (!query) die('usage: braavo ask "<question>" [--company <id>] [--models a,b,c] [--repo]');
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const companyId = flag(flags, "company") ?? cfg.defaultCompany;
      if (!companyId) die("No company. Run: braavo use <companyId>  (or pass --company <id>)");

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
      if (!promptText) die('usage: braavo cascade "<question>" [--threshold <0-1>] [--second-opinion] [--budget <usd>]');
      const params: Parameters<typeof cascade>[1] = { prompt: promptText };
      const threshold = flag(flags, "threshold");
      if (threshold) params.confidenceThreshold = Number(threshold);
      if (has(flags, "second-opinion")) params.secondOpinion = true;
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

    case "media-key": {
      // braavo media-key <add|list|rm> — manage tenant-scoped media BYOK keys
      // (server-side, encrypted). Separate from `braavo keys` (direct-lane local
      // keychain) because media generation bills the server-stored key.
      requireAuth(cfg);
      const sub = positionals[0];
      if (sub === "list") {
        const cat = await mediaCatalog(cfg);
        console.log(ui.primary("── media provider keys ──"));
        for (const p of cat?.providers ?? []) {
          console.log(p?.configured ? `  ${ui.primary(p.provider)} ${ui.dim(p.keyMasked ?? "")}` : `  ${ui.dim(p.provider + " — no key")}`);
        }
        return;
      }
      const provider = (positionals[1] ?? "").toUpperCase();
      if (!["FAL", "GOOGLE_TTS", "ELEVENLABS"].includes(provider)) {
        die("usage: braavo media-key add <FAL|GOOGLE_TTS|ELEVENLABS> <secret>  |  braavo media-key rm <provider>  |  braavo media-key list");
      }
      if (sub === "add") {
        const secret = positionals[2];
        if (!secret) die(`usage: braavo media-key add ${provider} <secret>`);
        const r = await mediaKeyPut(cfg, provider, secret);
        console.log(ui.primary(`✓ ${provider} media key stored ${ui.dim(r?.keyMasked ?? "")}`));
      } else if (sub === "rm") {
        await mediaKeyDelete(cfg, provider);
        console.log(ui.primary(`✓ ${provider} media key removed`));
      } else {
        die("usage: braavo media-key <add|list|rm> …");
      }
      return;
    }

    case "image": {
      requireAuth(cfg);
      const prompt = positionals.join(" ").trim();
      if (!prompt) die('usage: braavo image "<prompt>" [--model fal-ai/flux/schnell|dev] [--n 1] [--size 1024x1024] [--yes]');
      const model = flag(flags, "model") ?? IMAGE_MODELS[0];
      if (!(IMAGE_MODELS as readonly string[]).includes(model)) die(`--model must be one of: ${IMAGE_MODELS.join(", ")}`);
      const n = Number(flag(flags, "n") ?? 1);
      if (!Number.isInteger(n) || n < 1 || n > 4) die("--n must be an integer 1..4");
      let size: { width: number; height: number };
      try {
        size = parseSize(flag(flags, "size"));
      } catch (e) {
        die((e as Error).message);
        return;
      }
      const body = { kind: "image", model, prompt, n, width: size.width, height: size.height };
      const preview = await mediaPreview(cfg, body);
      const optedIn = has(flags, "yes");
      for (const line of renderMediaPreview(ui, preview?.estimate, !!preview?.keyConfigured, optedIn)) console.log(line);
      if (!optedIn) return;
      const spin = ui.spinner("generating image…");
      const res = await mediaGenerate(cfg, { ...body, acknowledgedCostUsd: estimateUsd(preview?.estimate) });
      spin.stop();
      if (res.status === 402) die(res.body?.message ?? "no FAL media key — run: braavo media-key add FAL <secret>");
      if (res.status === 400 && res.body?.code === "COST_ACK_REQUIRED") {
        for (const line of renderMediaPreview(ui, res.body?.estimate, true, false)) console.log(line);
        die("cost changed since preview — re-run to acknowledge the new estimate");
      }
      if (res.status < 200 || res.status >= 300) die(`generate failed (${res.status}): ${res.body?.message ?? res.statusText}`);
      for (const line of renderImageResult(ui, res.body?.result)) console.log(line);
      return;
    }

    case "voice": {
      requireAuth(cfg);
      const text = positionals.join(" ").trim();
      if (!text) die('usage: braavo voice "<text>" [--provider GOOGLE_TTS|ELEVENLABS] [--voice <name>] [--model <id>] [--out voice.mp3] [--yes]');
      const provider = (flag(flags, "provider") ?? TTS_PROVIDERS[0]).toUpperCase();
      if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) die(`--provider must be one of: ${TTS_PROVIDERS.join(", ")}`);
      const voice = flag(flags, "voice");
      const model = flag(flags, "model");
      const body: Record<string, unknown> = { kind: "tts", provider, text };
      if (voice) body.voice = voice;
      if (model) body.model = model;
      const preview = await mediaPreview(cfg, body);
      const optedIn = has(flags, "yes");
      for (const line of renderMediaPreview(ui, preview?.estimate, !!preview?.keyConfigured, optedIn)) console.log(line);
      if (!optedIn) return;
      const spin = ui.spinner("synthesizing…");
      const res = await mediaGenerate(cfg, { ...body, acknowledgedCostUsd: estimateUsd(preview?.estimate) });
      spin.stop();
      if (res.status === 402) die(res.body?.message ?? `no ${provider} media key — run: braavo media-key add ${provider} <secret>`);
      if (res.status === 400 && res.body?.code === "COST_ACK_REQUIRED") {
        for (const line of renderMediaPreview(ui, res.body?.estimate, true, false)) console.log(line);
        die("cost changed since preview — re-run to acknowledge the new estimate");
      }
      if (res.status < 200 || res.status >= 300) die(`synthesis failed (${res.status}): ${res.body?.message ?? res.statusText}`);
      const audioB64 = res.body?.result?.audioBase64;
      if (!audioB64) die("no audio in response");
      const out = flag(flags, "out") ?? "voice.mp3";
      writeFileSync(out, decodeAudio(audioB64));
      console.log(ui.primary("── saved ──"));
      console.log(ui.steel(`  ${out} ${ui.dim(`(${res.body?.result?.chars ?? text.length} chars · ${res.body?.result?.mime ?? "audio/mpeg"})`)}`));
      return;
    }

    case "local": {
      let query = positionals.join(" ").trim();
      if (!query) die('usage: braavo local "<question>" [--model <name>] [--host <url>] [--repo]');
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
      if (!provider || !query) die('usage: braavo direct <provider> "<question>" [--model <name>] [--repo]');
      if (!isDirectProvider(provider)) {
        die(`Unknown provider "${provider}". Supported: ${DIRECT_PROVIDERS.join(", ")}`);
      }
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const store = makeKeyStore();
      const apiKey = store.get(provider);
      if (!apiKey) die(`no key stored — run: braavo keys add ${provider}`);
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
      if (has(flags, "list") || positionals[0] === "list") {
        const statuses = SPAWN_VENDORS.map((v) => probeVendor(v));
        for (const line of renderSpawnList(ui, statuses)) console.log(line);
        return;
      }
      const vendor = positionals[0];
      if (!vendor || !isSpawnVendor(vendor)) {
        die(`usage: braavo spawn <${SPAWN_VENDORS.join("|")}> [...args]  |  braavo spawn --list`);
      }
      // Everything after the vendor is passed VERBATIM to the child (arg array —
      // no shell, no injection). --dir/--quiet/--bridge carve out their own
      // meaning and are not forwarded to the vendor; every other token is.
      const passthrough: string[] = [];
      let cwd: string | undefined;
      let quiet = false;
      let bridged = false;
      const rest = process.argv.slice(2);
      const vIdx = rest.indexOf(vendor);
      for (let i = vIdx + 1; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--dir") {
          cwd = rest[++i];
        } else if (a === "--quiet") {
          quiet = true;
        } else if (a === "--bridge") {
          bridged = true;
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

      if (bridged) {
        // OPT-IN companion-relay mode (Companion channel Dilim 2b — see
        // spawn.ts's spawnVendorBridged doc comment). Needs the same bearer
        // token every other authed command needs, to register the session
        // with the relay; the default (bridge-less) spawn above needs no
        // auth at all, since it never talks to braavolabs's own API.
        requireAuth(cfg);
        const childRef = makeChildRef();
        const handlers = makeSpawnBridgeHandlers(childRef);
        const transport = createRelayTransport({ cfg });
        const bridge = new RelayBridge(transport, handlers);
        try {
          const code = await spawnVendorBridged(binPath, passthrough, { cwd, bridge, childRef, label: vendor });
          process.exit(code); // own the child's exit code verbatim
        } catch {
          for (const line of spawnFallbackLines(ui, vendor)) console.error(line);
          process.exit(1);
        }
        return;
      }

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
        die('usage: braavo fix --cmd "<test-command>" [--via local|direct|ask] [--provider <p>] [--repo]');
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
        if (!apiKey) die(`no key stored — run: braavo keys add ${provider}`);
        const model = flag(flags, "model") ?? DIRECT_DEFAULT_MODEL[provider];
        ask = async (p) => (await directChat(provider, apiKey, model, p)).content;
      } else if (via === "ask") {
        // Cost-honesty: defer the auth requirement into the ask closure, which
        // runFix only invokes when the command is RED. A green (exit-0) command
        // spends nothing and must not demand a login (finding C-CLI-2).
        ask = async (p) => {
          requireAuth(cfg);
          return String((await cascade(cfg, { prompt: p }))?.answer ?? "");
        };
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
          if (!name) die("usage: braavo mcp rm <name>");
          const conf = loadMcpConfig();
          if (!conf[name]) die(`no such MCP server: ${name}`);
          saveMcpConfig(removeMcpServer(conf, name));
          ui.ok(`Removed MCP server "${name}".`);
          return;
        }
        case "tools": {
          const name = positionals[1];
          if (!name) die("usage: braavo mcp tools <name>");
          const def = loadMcpConfig()[name];
          if (!def) die(`no such MCP server: ${name}  (add it: braavo mcp add ${name} -- <command>)`);
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
          if (!name || !tool) die("usage: braavo mcp call <name> <tool> [--json '<args>'] [--timeout <ms>]");
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
          die("usage: braavo mcp add <name> -- <command> [args...] | list | rm <name> | tools <name> | call <name> <tool> [--json '<args>']");
      }
      return;
    }

    case "keys": {
      const sub = positionals[0];
      const store = makeKeyStore();
      switch (sub) {
        case "add": {
          const provider = positionals[1];
          if (!provider) die("usage: braavo keys add <provider> [--key <secret>]");
          const secret = flag(flags, "key") ?? process.env.BRAAVO_KEY ?? (await promptHidden(`${provider} key: `));
          if (!secret) die("No key provided.");
          store.add(provider, secret);
          if (!store.secure) {
            ui.warn("Stored in ~/.braavo/keys.json (chmod 600) — no OS keychain on this platform.");
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
          if (!provider) die("usage: braavo keys rm <provider>");
          store.remove(provider);
          ui.ok(`Removed ${provider} key.`);
          return;
        }
        default:
          die("usage: braavo keys add <provider> | list | rm <provider>");
      }
      return;
    }

    // ── pipelines (control the same surface the web/mobile use) ────────────────
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
      ui.ok(`Run started: ${d.id}`);
      return;
    }

    case "steer": {
      requireAuth(cfg);
      const id = positionals[0];
      const message = positionals.slice(1).join(" ");
      if (!id || !message) die("usage: braavo steer <runId> <message...>");
      await apiFetch(`/runs/${id}/steer`, { method: "POST", body: { content: message }, cfg });
      ui.ok("Steering sent — the agent picks it up on its next turn.");
      return;
    }

    case "handoffs": {
      requireAuth(cfg);
      const openOnly = has(flags, "open");
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
      const reason = flag(flags, "reason");
      if (reason) body.reason = reason;
      const d = await apiFetch(`/runs/${id}/handoff`, { method: "POST", body, cfg });
      ui.ok(`Handoff opened: ${d.handoffId}  (run ${d.status})`);
      if (d.checkpointPending) {
        console.log(`  Checkpoint is freezing at the next turn boundary — then run: braavo continue ${id} --provider <P>`);
      } else {
        console.log(`  Ready to claim. Run: braavo continue ${id} --provider <P>`);
      }
      return;
    }

    case "continue": {
      requireAuth(cfg);
      const id = positionals[0];
      const provider = flag(flags, "provider");
      if (!id || !provider) die("usage: braavo continue <runId> --provider <P> [--model <m>] [--base-url <u>]");
      const body: Record<string, unknown> = { provider };
      const model = flag(flags, "model");
      if (model) body.model = model;
      const baseUrl = flag(flags, "base-url");
      if (baseUrl) body.baseUrl = baseUrl;

      // The takeover checkpoint may still be freezing on the live loop's next
      // turn boundary — the API answers 409 CHECKPOINT_PENDING until it lands.
      // Retry a few times with a short pause before giving up.
      const MAX_ATTEMPTS = 5;
      for (let attempt = 1; ; attempt++) {
        const r = await apiFetch(`/runs/${id}/continue`, { method: "POST", body, cfg, raw: true });
        if (r.status < 400) {
          ui.ok(`Handoff claimed: ${r.body.handoffId}  →  ${r.body.toProvider}/${r.body.toModel}  (run ${r.body.status})`);
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

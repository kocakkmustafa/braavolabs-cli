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
 * Near-dep-free: Node 24.22.0+ global fetch + built-ins only, except `zod` —
 * pulled in solely by the opt-in `spawn --bridge` companion relay (see
 * forge/relay-protocol.ts) to validate the sealed relay contract; every
 * other command stays on built-ins alone. Token/defaults live in
 * ~/.braavo/config.json; a 401 transparently refreshes once and retries.
 *
 * ai morghulis · ai dohaeris.
 */
import { t, getLocale, setLocale, localeArgs, numberText, moneyText, dateText, statusText, dayText } from "./forge/locale";
import { renderHelp } from "./forge/help";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { Config, loadConfig, saveConfig, clearConfig, captureConfigOwner, commitLoginIfCurrent, classifyApiHost, CONFIG_DIR, CONFIG_PATH, UntrustedHostError } from "./forge/config";
import { parseApprovalDecision } from "./forge/approvalDecision";
import { EXIT, type ExitCode } from "./forge/exit-codes";
import { emit, requireConfirmation, ConfirmationRequiredError } from "./forge/output";
import { runDoctor, humanDoctorCheck } from "./forge/doctor";
import { verifyEvidenceChain, humanChainReason } from "./forge/audit";
import { makeUi, Ui } from "./forge/ui";
import {
  ApiError,
  SessionChangedError,
  apiFetch,
  invalidateSession,
  login,
  logout,
  startCompare,
  pollCompare,
  pollRun,
  cancelCompare,
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
import {
  assertMonitorUrl,
  checkMonitor,
  everyText,
  isDue,
  makeMonitorStore,
  newMonitorId,
  notifyOf,
  parseEvery,
  parseNotify,
  summaryPrompt,
  type CheckOutcome,
  type MonitorDef,
} from "./forge/monitor";
import { daemonPaths, ensureToken, runningDaemon, writeState, clearState } from "./daemon/lifecycle";
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
function usd(n: unknown): string { return moneyText(n); }
function tokens(n: unknown): string { return numberText(n); }

/** Extract a genuine savings figure from compare findings, or null. Never fabricated. */
export function extractSaved(findings: any): { usd: number; tokens?: number } | null {
  const mm = findings?.multiModel ?? findings;
  const su = mm?.savedUsd ?? findings?.savedUsd;
  const st = mm?.savedTokens ?? findings?.savedTokens;
  if (typeof su === "number" && Number.isFinite(su)) {
    return { usd: su, tokens: typeof st === "number" && Number.isFinite(st) ? st : undefined };
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
    out.push(ui.primary(`── ${t("synthesis")} ──`));
    out.push(String(synthesis));
  }

  const saved = extractSaved(findings);
  if (saved) {
    out.push(ui.ember(t("≈ saved {0} · tokens: {1}", usd(saved.usd), tokens(saved.tokens))));
  }
  return out;
}

export function renderCascadeLines(ui: Ui, res: any): string[] {
  const out: string[] = [];
  out.push(String(res?.answer ?? ""));
  out.push("");
  const conf = typeof res?.confidence === "number" ? numberText(res.confidence, { style: "percent", maximumFractionDigits: 0 }) : "?";
  const esc = t(res?.escalated ? "escalated" : "no escalation");
  out.push(
    ui.steel(
      `${res?.provider ?? "?"}/${res?.model ?? "?"} · ${t("tier")}=${res?.tier ?? "?"} · ${t("confidence")}=${conf} · ${esc} · ${usd(res?.totalCostUsd)}`,
    ),
  );
  const attempts: any[] = Array.isArray(res?.attempts) ? res.attempts : [];
  if (attempts.length > 1) {
    for (const a of attempts) {
      out.push(ui.dim(`  ↳ ${a?.provider}/${a?.model} ${t("tier")}=${a?.tier} ${t("confidence")}=${numberText(a?.confidence, { style: "percent", maximumFractionDigits: 0 })} ${usd(a?.costUsd)}`));
    }
  }
  if (res?.stoppedReason) out.push(ui.dim(`  ${t("stopped: {0}", res.stoppedReason)}`));
  return out;
}

export function renderSavingsTable(ui: Ui, data: any): string[] {
  const r = data?.report ?? {};
  const b = r.breakdown ?? {};
  const days = data?.period?.days ?? "?";
  const pct = typeof r.savedPct === "number" ? ` (${numberText(r.savedPct / 100, { style: "percent", maximumFractionDigits: 0 })})` : "";
  const row = (label: string, value: string, accent = false): string =>
    `${ui.steel(label.padEnd(16))}${accent ? ui.primary(value) : value}`;

  const out: string[] = [];
  out.push(row(t("period"), dayText(days)));
  out.push(row(t("actual"), usd(r.actualUsd)));
  out.push(row(t("baseline"), usd(r.baselineUsd)));
  out.push(row(t("saved"), `${usd(r.savedUsd)}${pct}`, true));
  out.push(row(t("saved tokens"), tokens(r.savedTokens)));
  out.push(ui.primary(`── ${t("breakdown")} ──`));
  out.push(row(t("cheap routing"), usd(b.cheapRoutingUsd)));
  out.push(row(t("cache"), usd(b.cacheUsd)));
  out.push(row(t("retrieval"), usd(b.retrievalUsd)));
  if (data?.note) out.push(ui.dim(String(data.note)));
  return out;
}

export function renderModelsTable(
  ui: Ui,
  data: { ollamaHost: string; ollamaReachable: boolean; ollamaModels: string[]; keyProviders: string[] },
): string[] {
  const out: string[] = [];
  out.push(ui.primary(`── ${t("local (Ollama)")} ──`));
  out.push(ui.steel(`  ${t("host: {0}", data.ollamaHost)}`));
  if (!data.ollamaReachable) {
    out.push(ui.dim(`  ${t("not reachable — is it running?")}`));
  } else if (!data.ollamaModels.length) {
    out.push(ui.dim(`  ${t("no models installed — run: ollama pull <model>")}`));
  } else {
    for (const m of data.ollamaModels) out.push(`  ${ui.primary(m)}`);
  }
  out.push("");
  out.push(ui.primary(`── ${t("direct (BYOK)")} ──`));
  for (const provider of DIRECT_PROVIDERS) {
    const has = data.keyProviders.includes(provider);
    const label = has ? ui.primary(t("key stored")) : ui.dim(t("no key — braavo keys add {0}", provider));
    out.push(`  ${provider.padEnd(10)} ${label}`);
  }
  return out;
}

// ── spawn (Lane-B) renderers ──────────────────────────────────────────────────
/** One-line, steel ToS-risk note shown before a spawn (suppressible via --quiet). */
export function spawnRiskLine(ui: Ui, vendor: SpawnVendor): string {
  return ui.steel(`· ${t("Official CLI; your account and the provider terms apply.")}`);
}

/** Honest "not installed" message + the graceful API-key fallback (rule g). */
export function spawnFallbackLines(ui: Ui, vendor: SpawnVendor): string[] {
  return [
    ui.fail(t("{0} CLI not found. Log in with the official {1} binary first, or use API-key mode:", vendor, vendor)),
    `  ${ui.primary(VENDOR_SPECS[vendor].fallback)}`,
  ];
}

/** `spawn --list`: installed-or-not + version, per vendor. Never probes login state. */
export function renderSpawnList(ui: Ui, statuses: VendorStatus[]): string[] {
  const out: string[] = [];
  out.push(ui.primary(`── ${t("spawn vendors (your own authenticated CLI)")} ──`));
  for (const s of statuses) {
    const state = s.installed
      ? ui.primary(t("installed{0}", s.version ? ` · ${s.version}` : ""))
      : ui.dim(t("not installed"));
    out.push(`  ${s.vendor.padEnd(8)} ${state}`);
    out.push(`  ${" ".repeat(8)} ${ui.steel(t("Official CLI; your account and the provider terms apply."))}`);
  }
  return out;
}

// ── fix (P-C4) renderers ──────────────────────────────────────────────────────
/** Suggestion-only output; green short-circuit prints an arc line and no model text. */
export function renderFixLines(ui: Ui, outcome: FixOutcome): string[] {
  if (outcome.green) {
    return [ui.primary(t("✓ tests already green"))];
  }
  return [
    ui.steel(`· ${t(SUGGESTION_NOTE)}`),
    ui.dim(`  ${t("(exit {0} — braavo never applies changes)", outcome.code)}`),
    "",
    String(outcome.suggestion ?? ""),
  ];
}

// ── mcp (P-C4) renderers ──────────────────────────────────────────────────────
export function renderMcpList(ui: Ui, cfg: McpConfig): string[] {
  const names = Object.keys(cfg).sort();
  if (!names.length) {
    return [ui.dim(t("No MCP servers. Add one: braavo mcp add <name> -- <command> [args...]"))];
  }
  const out = [ui.primary(`── ${t("mcp servers")} ──`)];
  for (const name of names) {
    const def = cfg[name];
    out.push(`  ${ui.primary(name.padEnd(16))} ${ui.steel(`${def.command} ${def.args.join(" ")}`.trim())}`);
  }
  return out;
}

export function renderMcpTools(ui: Ui, server: string, tools: McpTool[]): string[] {
  const out = [ui.primary(`── ${t("{0} · tools ({1})", server, numberText(tools.length))} ──`)];
  if (!tools.length) {
    out.push(ui.dim(`  ${t("(server exposed no tools)")}`));
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
  const body = texts.length ? texts.join("\n") : t("(no textual content)");
  if (result.isError) {
    return [ui.fail(t("tool reported an error:")), body];
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
  if (res.truncated) ui.warn(t("repo context exceeded 4KB — truncated"));
  return res.text;
}

// ── interactive helpers ───────────────────────────────────────────────────────
class CommandInterruptedError extends Error {}

/** Ctrl-C stops the local wait; remote mutations require their explicit command. */
async function interruptible<T>(message: () => string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new CommandInterruptedError(message()));
  process.once("SIGINT", interrupt);
  try { return await action(controller.signal); }
  finally { process.removeListener("SIGINT", interrupt); }
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

const HELP = (ui: Ui): string => renderHelp(ui);

async function main(): Promise<void> {
  const language = localeArgs(process.argv.slice(2));
  setLocale(language.locale);
  const ui = makeUi();
  const errorUi = makeUi({ tty: Boolean(process.stderr.isTTY) });
  // Function declarations (not const arrows) so control-flow analysis narrows
  // through the `never` guard sites below (e.g. `if (!x) die(...)`).
  function die(msg: string, code: ExitCode = EXIT.GENERAL): never {
    console.error(ui.fail(msg));
    process.exit(code);
  }
  function usage(msg: string): never {
    return die(msg.startsWith("usage: ") ? t("Usage: {0}", msg.slice(7)) : msg, EXIT.USAGE);
  }
  function requireAuth(cfg: Config): void {
    if (!cfg.token) die(t("Not logged in. Run: braavo login"), EXIT.AUTH);
  }

  const { cmd, positionals, flags } = parseArgs(language.argv);
  if (language.missing) usage(t("--lang requires a language code."));
  if (language.unsupported) console.error(ui.fail(t("Unsupported language {0}; using en.", language.unsupported)));
  if (Object.keys(flags).some(key => key.startsWith("reasoning-effort="))) usage(t("Use --reasoning-effort low|medium|high (separate flag and value)"));
  const effort = flag(flags, "reasoning-effort");
  if (flags["reasoning-effort"] !== undefined) {
    if (cmd !== "ask" || flags.models === undefined) usage(t("--reasoning-effort requires ask with --models PROVIDER/model,..."));
    if (effort !== "low" && effort !== "medium" && effort !== "high") usage(t("--reasoning-effort requires low, medium or high"));
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log((require("../package.json") as { version: string }).version);
    return;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || (flags.help === true && (cmd !== "spawn" || positionals.length === 0) && (language.argv.indexOf("--") < 0 || language.argv.indexOf("--help") < language.argv.indexOf("--")))) {
    console.log(renderHelp(ui, flags.help === true ? cmd : undefined));
    return;
  }
  const cfg = loadConfig();
  const requestedApi = flag(flags, "api");
  const allowCustomHost = flags["allow-custom-host"] === true;
  if (requestedApi || allowCustomHost) {
    // BR-P0-004 — changing the API host is a trust decision, so it is made
    // HERE, once, and persisted next to the host it applies to. A later --api
    // pointing at a DIFFERENT unknown host is a fresh decision and must be
    // opted into again; apiFetch enforces this on every call.
    // A retry can opt into the URL already selected by config/defaults without
    // spelling --api again. An explicit --api still resets previous consent.
    if (requestedApi) cfg.apiUrl = requestedApi;
    cfg.allowCustomHost = allowCustomHost ? true : undefined;
    const c = classifyApiHost(cfg.apiUrl);
    if (c.kind === "custom") {
      // Name the exact origin BEFORE any credential is sent, so the user can
      // see where their password would go. `origin` deliberately omits path
      // and query, which can carry a token.
      ui.warn(
        t("API host is not an official Braavolabs address: {0}", c.origin) +
          (!c.https
            ? t(" — plaintext HTTP; credentials will be refused. Use https://.")
            : cfg.allowCustomHost
            ? t(" — allowed by --allow-custom-host.")
            : t(" — credentials will be refused. Re-run with --allow-custom-host if you self-host.")),
      );
    }
    saveConfig(cfg);
  }

  switch (cmd) {
    case "login": {
      const token = flag(flags, "token");
      if (token) {
        invalidateSession(cfg);
        cfg.token = token;
        cfg.refreshToken = undefined;
        saveConfig(cfg);
        ui.ok(t("Token saved · {0}", cfg.apiUrl));
        return;
      }
      const owner = captureConfigOwner(cfg);
      const email = flag(flags, "email") ?? (await prompt(t("Email: ")));
      const password = flag(flags, "password") ?? (await promptHidden(t("Password: ")));
      if (captureConfigOwner(cfg).nonce !== owner.nonce) throw new SessionChangedError();
      const d = await login(cfg, { email, password });
      if (!commitLoginIfCurrent(cfg, { token: d.token, refreshToken: d.refreshToken }, owner)) {
        throw new SessionChangedError();
      }
      invalidateSession(cfg);
      ui.ok(t("Logged in as {0} · {1}", d.user?.email ?? email, d.tenant?.name ?? cfg.apiUrl));
      return;
    }

    case "logout": {
      // Clear locally before awaiting best-effort server-side revocation.
      const departing = { ...cfg };
      invalidateSession(cfg);
      cfg.token = undefined;
      cfg.refreshToken = undefined;
      clearConfig();
      if (departing.token || departing.refreshToken) {
        try {
          await logout(departing);
        } catch {
          /* offline / expired — local credentials are already cleared */
        }
      }
      ui.ok(t("Logged out."));
      return;
    }

    case "use": {
      const company = positionals[0];
      if (!company) usage("usage: braavo use <companyId>");
      cfg.defaultCompany = company;
      saveConfig(cfg);
      ui.ok(t("Default company set: {0}", company));
      return;
    }

    case "ask": {
      requireAuth(cfg);
      let query = positionals.join(" ").trim();
      if (!query) usage('usage: braavo ask "<question>" [--company <id>] [--models PROVIDER/model,...] [--repo]');
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const companyId = flag(flags, "company") ?? cfg.defaultCompany;
      if (!companyId) usage(t("No company. Run: braavo use <companyId>  (or pass --company <id>)"));

      // Explicit pairs prevent ambiguous aliases and silent provider substitution.
      const modelsFlag = flag(flags, "models");
      let selections: NonNullable<Parameters<typeof startCompare>[1]["selections"]> | undefined;
      if (flags.models !== undefined) {
        selections = (modelsFlag ?? "").split(",").map(value => {
          const separator = value.trim().indexOf("/");
          if (separator <= 0 || separator === value.trim().length - 1) usage(t("--models requires PROVIDER/model pairs, e.g. OPENAI/gpt-4o"));
          return { provider: value.trim().slice(0, separator).toUpperCase(), model: value.trim().slice(separator + 1) };
        });
        if (selections.length > 3 || new Set(selections.map(s => JSON.stringify(s))).size !== selections.length) usage(t("--models requires 1..3 distinct PROVIDER/model pairs"));
        if (effort === "low" || effort === "medium" || effort === "high") {
          selections = selections.map(selection => ({...selection, reasoningEffort: effort}));
        }
      }
      const n = selections?.length ?? 3;
      const spin = ui.spinner(t("asking models ({0})…", numberText(n)));
      try {
        let sessionId: string | undefined;
        const session = await interruptible(() => sessionId
          ? t("Stopped waiting. Research may still be running; cancel explicitly: {0}", `braavo cancel ${sessionId} --yes`)
          : t("Stopped waiting. The compare request may have started; inspect research sessions before retrying."), async signal => {
          const stub = await startCompare(cfg, { companyId, query, selections }, { signal });
          sessionId = stub.id;
          spin.update(`${t("asking models ({0})…", numberText(n))} (${stub.id})`);
          return pollCompare(cfg, stub.id, {
            signal,
            onTick: (status) => spin.update(`${t("asking models ({0})…", numberText(n))} (${statusText(status)})`),
          });
        });
        spin.stop();
        if (String(session.status) !== "COMPLETED") {
          throw new ApiError(502, `${t(session.status === "CANCELLED" ? "Compare cancelled" : "Compare failed")}${session.error ? `: ${session.error}` : ""}`);
        }
        for (const line of renderCompareLines(ui, session)) console.log(line);
      } catch (e) {
        spin.stop();
        throw e;
      }
      return;
    }

    case "cancel": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo cancel <researchId> --yes [--json]");
      requireConfirmation(flags, t("cancel research session {0}", id));
      const result = await cancelCompare(cfg, id);
      emit(flags, { id, action: "cancel", result }, () => `${statusText(result.status)}  ${id}`);
      return;
    }

    case "cascade": {
      requireAuth(cfg);
      const promptText = positionals.join(" ").trim();
      if (!promptText) usage('usage: braavo cascade "<question>" [--threshold <0-1>] [--second-opinion] [--budget <usd>]');
      const params: Parameters<typeof cascade>[1] = { prompt: promptText };
      const threshold = flag(flags, "threshold");
      if (threshold) params.confidenceThreshold = Number(threshold);
      if (has(flags, "second-opinion")) params.secondOpinion = true;
      const budget = flag(flags, "budget");
      if (budget) params.budgetUsdCap = Number(budget);

      const spin = ui.spinner(t("cascading…"));
      try {
        const res = await interruptible(() => t("Local waiting has a deadline. Remote work may continue after cancellation or timeout."), signal => cascade(cfg, params, { signal }));
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
        console.log(ui.primary(`── ${t("media provider keys")} ──`));
        for (const p of cat?.providers ?? []) {
          console.log(p?.configured ? `  ${ui.primary(p.provider)} ${ui.dim(p.keyMasked ?? "")}` : `  ${ui.dim(`${p.provider} — ${t("no key")}`)}`);
        }
        return;
      }
      const provider = (positionals[1] ?? "").toUpperCase();
      if (!["FAL", "GOOGLE_TTS", "ELEVENLABS"].includes(provider)) {
        usage("usage: braavo media-key add <FAL|GOOGLE_TTS|ELEVENLABS> <secret>  |  braavo media-key rm <provider>  |  braavo media-key list");
      }
      if (sub === "add") {
        const secret = positionals[2];
        if (!secret) usage(`usage: braavo media-key add ${provider} <secret>`);
        const r = await mediaKeyPut(cfg, provider, secret);
        console.log(ui.primary(`✓ ${t("Stored {0} key {1}", provider, ui.dim(r?.keyMasked ?? ""))}`));
      } else if (sub === "rm") {
        await mediaKeyDelete(cfg, provider);
        console.log(ui.primary(`✓ ${t("Removed {0} key.", provider)}`));
      } else {
        usage("usage: braavo media-key <add|list|rm> …");
      }
      return;
    }

    case "image": {
      requireAuth(cfg);
      const prompt = positionals.join(" ").trim();
      if (!prompt) usage('usage: braavo image "<prompt>" [--model fal-ai/flux/schnell|dev] [--n 1] [--size 1024x1024] [--yes]');
      const model = flag(flags, "model") ?? IMAGE_MODELS[0];
      if (!(IMAGE_MODELS as readonly string[]).includes(model)) usage(t("--model must be one of: {0}", IMAGE_MODELS.join(", ")));
      const n = Number(flag(flags, "n") ?? 1);
      if (!Number.isInteger(n) || n < 1 || n > 4) usage(t("--n must be an integer 1..4"));
      let size: { width: number; height: number };
      try {
        size = parseSize(flag(flags, "size"));
      } catch (e) {
        usage((e as Error).message);
        return;
      }
      const body = { kind: "image", model, prompt, n, width: size.width, height: size.height };
      const preview = await mediaPreview(cfg, body);
      const optedIn = has(flags, "yes");
      for (const line of renderMediaPreview(ui, preview?.estimate, !!preview?.keyConfigured, optedIn)) console.log(line);
      if (!optedIn) return;
      const spin = ui.spinner(t("generating image…"));
      const res = await mediaGenerate(cfg, { ...body, acknowledgedCostUsd: estimateUsd(preview?.estimate) });
      spin.stop();
      if (res.status === 402) die(res.body?.message ?? t("No {0} media key — run: braavo media-key add {0} <secret>", "FAL"));
      if (res.status === 400 && res.body?.code === "COST_ACK_REQUIRED") {
        for (const line of renderMediaPreview(ui, res.body?.estimate, true, false)) console.log(line);
        die(t("cost changed since preview — re-run to acknowledge the new estimate"));
      }
      if (res.status < 200 || res.status >= 300) die(t("generation failed ({0}): {1}", res.status, res.body?.message ?? res.statusText));
      for (const line of renderImageResult(ui, res.body?.result)) console.log(line);
      return;
    }

    case "voice": {
      requireAuth(cfg);
      const text = positionals.join(" ").trim();
      if (!text) usage('usage: braavo voice "<text>" [--provider GOOGLE_TTS|ELEVENLABS] [--voice <name>] [--model <id>] [--out voice.mp3] [--yes]');
      const provider = (flag(flags, "provider") ?? TTS_PROVIDERS[0]).toUpperCase();
      if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) usage(t("--provider must be one of: {0}", TTS_PROVIDERS.join(", ")));
      const voice = flag(flags, "voice");
      const model = flag(flags, "model");
      const body: Record<string, unknown> = { kind: "tts", provider, text };
      if (voice) body.voice = voice;
      if (model) body.model = model;
      const preview = await mediaPreview(cfg, body);
      const optedIn = has(flags, "yes");
      for (const line of renderMediaPreview(ui, preview?.estimate, !!preview?.keyConfigured, optedIn)) console.log(line);
      if (!optedIn) return;
      const spin = ui.spinner(t("synthesizing…"));
      const res = await mediaGenerate(cfg, { ...body, acknowledgedCostUsd: estimateUsd(preview?.estimate) });
      spin.stop();
      if (res.status === 402) die(res.body?.message ?? t("No {0} media key — run: braavo media-key add {0} <secret>", provider));
      if (res.status === 400 && res.body?.code === "COST_ACK_REQUIRED") {
        for (const line of renderMediaPreview(ui, res.body?.estimate, true, false)) console.log(line);
        die(t("cost changed since preview — re-run to acknowledge the new estimate"));
      }
      if (res.status < 200 || res.status >= 300) die(t("generation failed ({0}): {1}", res.status, res.body?.message ?? res.statusText));
      const audioB64 = res.body?.result?.audioBase64;
      if (!audioB64) die(t("no audio in response"));
      const out = flag(flags, "out") ?? "voice.mp3";
      writeFileSync(out, decodeAudio(audioB64));
      console.log(ui.primary(`── ${t("saved")} ──`));
      console.log(ui.steel(`  ${out} ${ui.dim(`(${t("chars")}: ${numberText(res.body?.result?.chars ?? text.length)} · ${res.body?.result?.mime ?? "audio/mpeg"})`)}`));
      return;
    }

    case "local": {
      let query = positionals.join(" ").trim();
      if (!query) usage('usage: braavo local "<question>" [--model <name>] [--host <url>] [--repo]');
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const host = resolveOllamaHost(flag(flags, "host"));
      const spin = ui.spinner(t("asking local model…"));
      try {
        const res = await interruptible(() => t("Local waiting has a deadline. Remote work may continue after cancellation or timeout."), async signal => {
          const model = await resolveOllamaModel(host, flag(flags, "model"), { signal });
          spin.update(t("asking {0}…", model));
          return ollamaChat(host, model, query, { signal });
        });
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
      if (!provider || !query) usage('usage: braavo direct <provider> "<question>" [--model <name>] [--repo]');
      if (!isDirectProvider(provider)) {
        usage(t("Unknown provider {0}. Supported: {1}", provider, DIRECT_PROVIDERS.join(", ")));
      }
      const repoBlock = resolveRepoBlock(flags.repo !== undefined, die, ui);
      if (repoBlock) query = prependRepoContext(repoBlock, query);
      const store = makeKeyStore();
      const apiKey = store.get(provider);
      if (!apiKey) die(t("no key — braavo keys add {0}", provider));
      const model = flag(flags, "model") ?? DIRECT_DEFAULT_MODEL[provider];
      const spin = ui.spinner(t("asking {0}…", `${provider}/${model}`));
      try {
        const res = await interruptible(() => t("Local waiting has a deadline. Remote work may continue after cancellation or timeout."), signal => directChat(provider, apiKey, model, query, { signal }));
        spin.stop();
        console.log(res.content);
      } catch (e) {
        spin.stop();
        if (e instanceof DirectApiError) die(`${e.provider} ${e.status}: ${e.message}`);
        throw e;
      }
      return;
    }

    case "setup": {
      // FK-10: everything runs on the user's own keys or local models (K3), so the first run must
      // say plainly what is there and what to do next. Reads key names only, never values.
      const { detectUserModels } = await import("./daemon/chat");
      const { suggestModel } = await import("./core/templates");
      const host = resolveOllamaHost(flag(flags, "host"));
      const live = runningDaemon(daemonPaths());
      const keyNames = makeKeyStore().list().map(k => k.provider);
      const user = await detectUserModels(keyNames, { ollamaHost: host });
      const suggestions = Object.fromEntries((["strong", "mid", "light", "analysis"] as const).map(tier => [tier, suggestModel(tier, user)]));
      const usable = Object.values(suggestions).some(x => x.status === "ok");
      const data = { daemon: live ?? null, keys: keyNames, local: user.local, suggestions, usable };
      emit(flags, data, () => {
        const ok = (b: boolean) => (b ? "✓" : "–");
        const out = [
          `${ok(Boolean(live))} ${live ? t("Daemon running · pid {0} · port {1}", live.pid, live.port) : `${t("Daemon is not running.")} braavo daemon start`}`,
          `${ok(keyNames.length > 0)} ${keyNames.length ? t("Keys: {0}", keyNames.join(", ")) : t("No keys yet: braavo keys add <provider>")}`,
          ...(["OLLAMA", "LMSTUDIO"] as const).map(p => `${ok(user.local[p].length > 0)} ${user.local[p].length ? t("Local models ({0}): {1}", p === "OLLAMA" ? "Ollama" : "LM Studio", user.local[p].slice(0, 6).join(", ")) : t("{0} is not reachable or has no models", p === "OLLAMA" ? "Ollama" : "LM Studio")}`),
          "", t("Suggested models"),
          ...Object.entries(suggestions).map(([tier, x]) => `  ${tier.padEnd(9)} ${x.status === "ok" ? `${x.provider}/${x.model}` : x.status === "model-required" ? `${x.provider}/? (--model)` : "—"}`),
          "",
          usable ? t("Next: {0}", live ? 'braavo company init "<name>" --watch <urls>' : "braavo daemon start") : t("No usable model yet. Add a key or pull a local model: {0}", "braavo models pull qwen3:8b"),
        ];
        return out.join("\n");
      });
      return;
    }

    case "skills": {
      // Plan 5.3: SKILL.md skills for agents. Reads the folders directly (no daemon needed);
      // the working directory counts as a project for this call.
      const { SkillRegistry, SkillError } = await import("./daemon/skills");
      const registry = new SkillRegistry(`${CONFIG_DIR}/skills`, `${CONFIG_DIR}/skills.json`);
      const action = positionals[0] ?? "list";
      const skillsUsage = "usage: braavo skills [list] | show <name> | add-dir <path> | rm-dir <path> [--json]";
      try {
        if (action === "list") {
          const skills = registry.list([process.cwd()]);
          emit(flags, { skills, projects: registry.config().projects }, () => skills.length
            ? skills.map(s => `${s.name.padEnd(28)} ${s.source.padEnd(8)} ${s.description.replace(/\s+/g, " ").slice(0, 100)}`).join("\n")
            : t("No skills yet. Put a folder with SKILL.md in {0}, or run: braavo skills add-dir <project>", `${CONFIG_DIR}/skills`));
          return;
        }
        if (action === "show") {
          const skill = positionals[1] ? registry.get(positionals[1], [process.cwd()]) : null;
          if (!skill) die(t("No such skill: {0}", positionals[1] ?? ""));
          emit(flags, skill, () => [`${skill!.name} · ${skill!.source} · ${skill!.dir}`, skill!.description, ...(skill!.files.length ? [`files: ${skill!.files.join(", ")}`] : []), "", skill!.body].join("\n"));
          return;
        }
        if (action === "add-dir" || action === "rm-dir") {
          if (!positionals[1]) usage(skillsUsage);
          const cfg = action === "add-dir" ? registry.addProject(positionals[1]) : registry.removeProject(positionals[1]);
          emit(flags, cfg, () => t("Skill folders: {0}", cfg.projects.join(", ") || "—"));
          return;
        }
      } catch (error) {
        if (error instanceof SkillError) die(error.message);
        throw error;
      }
      usage(skillsUsage);
      return;
    }

    case "models": {
      if (positionals[0] === "pull") {
        // Pull a model into the local Ollama (POST /api/pull, streamed progress). Local only; no account.
        const name = positionals[1];
        if (!name || !/^[A-Za-z0-9._:/-]{1,200}$/.test(name)) usage("usage: braavo models pull <name> [--host <url>]");
        const pullHost = resolveOllamaHost(flag(flags, "host"));
        console.error(t("Pulling {0}…", name));
        let res: Response;
        try { res = await fetch(`${pullHost}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, stream: true }) }); }
        catch { die(t("{0} is not reachable or has no models", `Ollama (${pullHost})`)); }
        if (!res!.ok || !res!.body) die(`Ollama: ${res!.status}`);
        let buffer = ""; let last = ""; let failed: string | undefined;
        for await (const chunk of res!.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += Buffer.from(chunk).toString("utf8");
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
            let ev: { status?: string; completed?: number; total?: number; error?: string };
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.error) failed = ev.error;
            const pct = ev.total ? ` ${Math.floor(((ev.completed ?? 0) / ev.total) * 100)}%` : "";
            const text = `${ev.status ?? ""}${pct}`;
            if (text && text !== last && process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${text}`);
            last = text;
          }
        }
        if (process.stderr.isTTY) process.stderr.write("\n");
        if (failed) die(`Ollama: ${failed.slice(0, 200)}`);
        console.log(t("Pulled {0}", name));
        return;
      }
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
        usage(`usage: braavo spawn <${SPAWN_VENDORS.join("|")}> [...args]  |  braavo spawn --list`);
      }
      // Everything after the vendor is passed VERBATIM to the child (arg array —
      // no shell, no injection). --dir/--quiet/--bridge carve out their own
      // meaning and are not forwarded to the vendor; every other token is.
      const passthrough: string[] = [];
      let cwd: string | undefined;
      let quiet = false;
      let bridged = false;
      const rest = language.argv;
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
        for (const line of spawnFallbackLines(errorUi, vendor)) console.error(line);
        process.exit(1);
      }
      if (!quiet) console.error(spawnRiskLine(errorUi, vendor));

      if (bridged) {
        // OPT-IN companion-relay mode (Companion channel Dilim 2b — see
        // spawn.ts's spawnVendorBridged doc comment). Needs the same bearer
        // token every other authed command needs, to register the session
        // with the relay; the default (bridge-less) spawn above needs no
        // auth at all, since it never talks to braavolabs's own API.
        requireAuth(cfg);
        const childRef = makeChildRef();
        const handlers = makeSpawnBridgeHandlers(childRef);
        // zod + the relay contract load only on this opt-in path (and `daemon run --relay`).
        const { createRelayTransport } = await import("./forge/relay-transport");
        const { RelayBridge } = await import("./forge/relay-bridge");
        const transport = createRelayTransport({ cfg });
        const bridge = new RelayBridge(transport, handlers, { onOutputDropped: () => ui.warn(t("Companion output omitted: relay is slower than the local program. Local output is unchanged.")) });
        try {
          const code = await spawnVendorBridged(binPath, passthrough, { cwd, bridge, childRef, label: vendor });
          process.exit(code); // own the child's exit code verbatim
        } catch {
          for (const line of spawnFallbackLines(errorUi, vendor)) console.error(line);
          process.exit(1);
        }
        return;
      }

      try {
        const code = await spawnVendor(binPath, passthrough, { cwd });
        process.exit(code); // own the child's exit code verbatim
      } catch {
        // Spawn itself failed (binary vanished / not executable) → graceful fallback.
        for (const line of spawnFallbackLines(errorUi, vendor)) console.error(line);
        process.exit(1);
      }
      return;
    }

    case "fix": {
      const testCmd = flag(flags, "cmd");
      if (!testCmd) {
        usage('usage: braavo fix --cmd "<test-command>" [--via local|direct|ask] [--provider <p>] [--repo]');
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
          usage(t("--via direct needs --provider <{0}>", DIRECT_PROVIDERS.join("|")));
        }
        const store = makeKeyStore();
        const apiKey = store.get(provider);
        if (!apiKey) die(t("no key — braavo keys add {0}", provider));
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
        usage(t("Unknown --via {0}. Use: local | direct | ask", via));
      }

      const spin = ui.spinner(t("running: {0}", testCmd));
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
          const afterAdd = language.argv.slice(2); // tokens after "mcp add"
          const parsed = parseMcpAdd(afterAdd);
          if ("error" in parsed) usage(parsed.error);
          const next = addMcpServer(loadMcpConfig(), parsed.name, parsed.command, parsed.args);
          saveMcpConfig(next);
          ui.ok(`${t("Added MCP server {0}", parsed.name)} → ${parsed.command} ${parsed.args.join(" ")}`.trim());
          return;
        }
        case "list": {
          for (const line of renderMcpList(ui, loadMcpConfig())) console.log(line);
          return;
        }
        case "rm": {
          const name = positionals[1];
          if (!name) usage("usage: braavo mcp rm <name>");
          const conf = loadMcpConfig();
          if (!conf[name]) die(t("No such MCP server: {0}", name));
          saveMcpConfig(removeMcpServer(conf, name));
          ui.ok(t("Removed MCP server {0}.", name));
          return;
        }
        case "serve": {
          // Plan 5.2: this computer's company as an MCP server (stdio) for Claude Code, Codex, Cursor.
          // stdout carries JSON-RPC only; the daemon is looked up per call, so it may start later.
          const { serveMcp } = await import("./forge/mcp-server");
          const { DaemonClient } = await import("./forge/daemon-client");
          const paths = daemonPaths();
          const version = (require("../package.json") as { version: string }).version;
          await serveMcp(process.stdin, process.stdout, {
            version,
            daemon: () => {
              const live = runningDaemon(paths);
              if (!live) throw new Error("The Braavolabs daemon is not running. Start it: braavo daemon start");
              // The header labels memory edits made through MCP (provenance, not access control).
              const tagged: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "X-Braavo-Client": "mcp" } });
              return new DaemonClient({ port: live.port, token: ensureToken(paths) }, tagged);
            },
          });
          return;
        }
        case "tools": {
          const name = positionals[1];
          if (!name) usage("usage: braavo mcp tools <name>");
          const def = loadMcpConfig()[name];
          if (!def) die(`${t("No such MCP server: {0}", name)}  (braavo mcp add ${name} -- <command>)`);
          const timeoutMs = flag(flags, "timeout") ? Number(flag(flags, "timeout")) : undefined;
          const spin = ui.spinner(t("{0}: initializing…", name));
          try {
            const tools = await listServerTools(def, defaultMcpSpawn, {
              timeoutMs,
              onStderr: (c) => process.stderr.write(errorUi.steel(c)),
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
          if (!name || !tool) usage("usage: braavo mcp call <name> <tool> [--json '<args>'] [--timeout <ms>]");
          const def = loadMcpConfig()[name];
          if (!def) die(t("No such MCP server: {0}", name));
          let toolArgs: Record<string, unknown> = {};
          const jsonFlag = flag(flags, "json");
          if (jsonFlag) {
            try {
              toolArgs = JSON.parse(jsonFlag);
            } catch {
              usage(t("Invalid --json argument."));
            }
          }
          const timeoutMs = flag(flags, "timeout") ? Number(flag(flags, "timeout")) : undefined;
          const spin = ui.spinner(t("{0}: calling {1}…", name, tool));
          try {
            const result = await callServerTool(def, tool, toolArgs, defaultMcpSpawn, {
              timeoutMs,
              onStderr: (c) => process.stderr.write(errorUi.steel(c)),
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
          usage("usage: braavo mcp add <name> -- <command> [args...] | list | rm <name> | tools <name> | call <name> <tool> [--json '<args>']");
      }
      return;
    }

    case "github": {
      // Plan 5.4: sign in with the Braavolabs GitHub App (OAuth device flow) for repository
      // triggers. The token stays in the OS keychain; nothing goes to a Braavolabs server.
      const gh = await import("./daemon/github");
      const keys = makeKeyStore();
      const ghFetch = fetch as unknown as import("./daemon/github").FetchLike;
      const save = (auth: import("./daemon/github").GithubAuth) => keys.add(gh.GITHUB_TOKEN_KEY, JSON.stringify(auth));
      const sub = positionals[0] ?? "status";
      if (sub === "login") {
        const clientId = gh.githubClientId();
        const code = await gh.startDeviceFlow(clientId, ghFetch).catch((error: Error) => die(error.message));
        ui.info(t("Open {0} and enter the code: {1}", code.verification_uri, code.user_code));
        const auth = await gh.finishDeviceFlow(clientId, code, ghFetch).catch((error: Error) => die(error.message));
        auth.login = await gh.whoAmI(auth.access, ghFetch);
        save(auth);
        if (!keys.secure) ui.warn(t("Stored in ~/.braavo/keys.json (chmod 600) — no OS keychain on this platform."));
        emit(flags, { signedIn: true, login: auth.login ?? null }, () => t("Signed in to GitHub as {0}", auth.login ?? "?"));
        return;
      }
      if (sub === "logout") {
        try { keys.remove(gh.GITHUB_TOKEN_KEY); } catch { /* already gone */ }
        emit(flags, { signedIn: false }, () => t("Signed out of GitHub."));
        return;
      }
      if (sub === "status") {
        const token = await gh.currentToken(() => keys.get(gh.GITHUB_TOKEN_KEY), save, gh.githubClientId(), ghFetch);
        const login = token ? await gh.whoAmI(token, ghFetch) : undefined;
        emit(flags, { signedIn: !!login, login: login ?? null }, () => (login ? t("Signed in to GitHub as {0}", login) : t("Not signed in to GitHub. Run: braavo github login")));
        return;
      }
      usage("usage: braavo github login | logout | status");
    }
    case "slack": {
      // Plan 5.4: the user's own Slack app (Socket Mode). Both tokens go to the OS keychain;
      // they are read from a hidden prompt or the environment, never from flags (shell history).
      const sl = await import("./daemon/slack");
      const keys = makeKeyStore();
      const slFetch = fetch as unknown as import("./daemon/github").FetchLike;
      const sub = positionals[0] ?? "status";
      if (sub === "connect") {
        const bot = (process.env.BRAAVO_SLACK_BOT_TOKEN ?? (await promptHidden(t("Slack bot token (xoxb-…): ")))).trim();
        const app = (process.env.BRAAVO_SLACK_APP_TOKEN ?? (await promptHidden(t("Slack app token (xapp-…): ")))).trim();
        if (!bot.startsWith("xoxb-") || !app.startsWith("xapp-")) usage("usage: braavo slack connect  (bot token xoxb-…, app-level token xapp-… with connections:write)");
        const who = await sl.slackAuthTest(bot, slFetch).catch((error: Error) => die(error.message));
        keys.add(sl.SLACK_BOT_KEY, bot);
        keys.add(sl.SLACK_APP_KEY, app);
        if (!keys.secure) ui.warn(t("Stored in ~/.braavo/keys.json (chmod 600) — no OS keychain on this platform."));
        emit(flags, { connected: true, team: who.team, bot: who.user }, () => t("Connected to Slack: {0}", `${who.team} · @${who.user}`));
        return;
      }
      if (sub === "disconnect") {
        for (const k of [sl.SLACK_BOT_KEY, sl.SLACK_APP_KEY]) try { keys.remove(k); } catch { /* already gone */ }
        emit(flags, { connected: false }, () => t("Disconnected from Slack."));
        return;
      }
      if (sub === "status") {
        const bot = keys.get(sl.SLACK_BOT_KEY);
        const who = bot ? await sl.slackAuthTest(bot, slFetch).catch(() => undefined) : undefined;
        emit(flags, { connected: !!who, team: who?.team ?? null, bot: who?.user ?? null }, () => (who ? t("Connected to Slack: {0}", `${who.team} · @${who.user}`) : t("Not connected to Slack. Run: braavo slack connect")));
        return;
      }
      usage("usage: braavo slack connect | disconnect | status");
    }
    case "keys": {
      const sub = positionals[0];
      const store = makeKeyStore();
      switch (sub) {
        case "add": {
          const provider = positionals[1];
          if (!provider) usage("usage: braavo keys add <provider> [--key <secret>]");
          const secret = flag(flags, "key") ?? process.env.BRAAVO_KEY ?? (await promptHidden(t("{0} key: ", provider)));
          if (!secret) usage(t("No key provided."));
          store.add(provider, secret);
          if (!store.secure) {
            ui.warn(t("Stored in ~/.braavo/keys.json (chmod 600) — no OS keychain on this platform."));
          }
          // Show only a masked fingerprint; never echo the key.
          const shown = store.list().find((k) => k.provider === provider);
          ui.ok(t("Stored {0} key {1}", provider, shown?.masked ?? "").trim());
          return;
        }
        case "list": {
          const entries = store.list();
          if (!entries.length) {
            ui.info(t("No keys stored."));
            return;
          }
          for (const e of entries) console.log(`${ui.primary(e.provider.padEnd(12))} ${ui.steel(e.masked)}`);
          if (!store.secure) ui.warn(t("Keys are in a plaintext file (chmod 600) — no OS keychain on this platform."));
          return;
        }
        case "rm": {
          const provider = positionals[1];
          if (!provider) usage("usage: braavo keys rm <provider>");
          store.remove(provider);
          ui.ok(t("Removed {0} key.", provider));
          return;
        }
        default:
          usage("usage: braavo keys add <provider> | list | rm <provider>");
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
        console.log(t("No runs yet."));
        return;
      }
      for (const r of runs) {
        console.log(`${statusText(r.status).padEnd(10)}  ${r.id}  ${r.pipelineId ?? ""}${r.createdAt ? `  ${dateText(r.createdAt)}` : ""}`);
      }
      return;
    }

    case "run": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo run <pipelineId> --yes [--json]");
      requireConfirmation(flags, t("start run for pipeline {0}", id));
      const d = await apiFetch(`/pipelines/${encodeURIComponent(id)}/run`, { method: "POST", body: { input: {} }, cfg });
      if (typeof d?.id !== "string" || !d.id.trim()) {
        throw new ApiError(502, t("Invalid run response; inspect recent runs before retrying."));
      }
      if (flags.json) emit(flags, d, () => "");
      else ui.ok(t("Run started: {0}", d.id));
      return;
    }

    case "steer": {
      requireAuth(cfg);
      const id = positionals[0];
      const message = positionals.slice(1).join(" ");
      if (!id || !message) usage("usage: braavo steer <runId> <message...>");
      requireConfirmation(flags, t("steer run {0}", id));
      await apiFetch(`/runs/${id}/steer`, { method: "POST", body: { content: message }, cfg });
      ui.ok(t("Steering sent — the agent picks it up on its next turn."));
      return;
    }

    case "handoffs": {
      requireAuth(cfg);
      const openOnly = has(flags, "open");
      const path = openOnly ? "/handoffs?status=OPEN" : "/handoffs";
      const d = await apiFetch(path, { cfg });
      const list: any[] = d.handoffs ?? [];
      if (!list.length) {
        console.log(t(openOnly ? "No open handoffs." : "No handoffs yet."));
        return;
      }
      for (const h of list) {
        const to = h.toProvider ? `→${h.toProvider}` : "";
        console.log(
          `${statusText(h.status).padEnd(9)}  ${h.id}  run=${h.runId}  from=${h.fromProvider ?? "?"}${to}  ${h.reason ?? ""}`,
        );
      }
      return;
    }

    case "handoff": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo handoff <runId> [--reason <text>]");
      requireConfirmation(flags, t("open handoff for run {0}", id));
      const body: Record<string, unknown> = {};
      const reason = flag(flags, "reason");
      if (reason) body.reason = reason;
      const d = await apiFetch(`/runs/${id}/handoff`, { method: "POST", body, cfg });
      ui.ok(`${t("Handoff opened")}: ${d.handoffId}  (${statusText(d.status)})`);
      if (d.checkpointPending) {
        console.log(`  ${t("Checkpoint is freezing at the next turn boundary — then run: {0}", `braavo continue ${id} --provider <P>`)}`);
      } else {
        console.log(`  ${t("Ready to claim. Run: {0}", `braavo continue ${id} --provider <P>`)}`);
      }
      return;
    }

    case "continue": {
      requireAuth(cfg);
      const id = positionals[0];
      const provider = flag(flags, "provider");
      if (!id || !provider) usage("usage: braavo continue <runId> --provider <P> [--model <m>] [--base-url <u>]");
      requireConfirmation(flags, t("continue run {0} with provider {1}", id, provider));
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
        if (r.status >= 200 && r.status < 300) {
          if (r.body?.success !== true || ["handoffId", "toProvider", "toModel", "status"].some(key =>
            typeof r.body?.[key] !== "string" || !r.body[key].trim())) {
            throw new ApiError(502, t("Invalid handoff response; inspect the run before retrying."));
          }
          ui.ok(`${t("Handoff claimed")}: ${r.body.handoffId}  →  ${r.body.toProvider}/${r.body.toModel}  (${statusText(r.body.status)})`);
          return;
        }
        const errMsg = r.body?.error ?? r.body?.message ?? r.statusText;
        // Current servers expose this legacy message without a machine code.
        // Other conflicts must not trigger repeated mutations or report freezing.
        const pending = r.body?.code === "CHECKPOINT_PENDING" || r.body?.error ===
          "Checkpoint not frozen yet — the live loop hasn't reached a turn boundary. Retry shortly.";
        if (r.status === 409 && pending && attempt < MAX_ATTEMPTS) {
          console.log(`  ${t("Checkpoint still freezing (attempt {0}/{1}) — retrying in 2s…", numberText(attempt), numberText(MAX_ATTEMPTS))}`);
          await sleep(2000);
          continue;
        }
        throw new ApiError(r.status, errMsg);
      }
    }

    case "connections": {
      requireAuth(cfg);
      const d = await apiFetch("/external-connections", { cfg });
      const list: any[] = Array.isArray(d) ? d : [];
      if (!list.length) {
        console.log(t("No connections."));
        return;
      }
      for (const c of list) {
        console.log(`${statusText(c.status).padEnd(8)}  ${String(c.platform ?? "").padEnd(7)}  ${c.label}  ${c.baseUrl}`);
      }
      return;
    }

    // ── roadmap §5.2 contract commands (BR-P1-002) ────────────────────────
    //
    // Every mutating command here goes through requireConfirmation, so the
    // default in a non-TTY (i.e. every CI job) is to refuse rather than act.

    case "doctor": {
      // Local health only — deliberately does NOT require auth, because the
      // most common reason to run doctor is that auth is what's broken.
      const checks = await runDoctor(cfg);
      const failed = checks.filter((c) => c.status === "fail");
      emit(flags, { checks, ok: failed.length === 0 }, () =>
        checks
          .map((c) => { const human = humanDoctorCheck(c); return `${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${human.name.padEnd(22)} ${human.detail}`; })
          .join("\n"),
      );
      if (failed.length) process.exitCode = EXIT.GENERAL;
      return;
    }

    case "init": {
      const api = flag(flags, "api") ?? cfg.apiUrl;
      const c: Config = { ...cfg, apiUrl: api };
      saveConfig(c);
      emit(flags, { apiUrl: c.apiUrl, configPath: CONFIG_PATH }, () =>
        t("Initialised. API {0}\nConfig {1}\nNext: braavo login", c.apiUrl, CONFIG_PATH),
      );
      return;
    }

    case "watch": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo watch <runId> [--json]");
      const terminal = new Set(["COMPLETED", "FAILED", "STOPPED", "CANCELLED"]);
      const result = await interruptible(
        () => t("Stopped watching {0}. The run may still be running; stop explicitly: {1}", id, `braavo stop ${id} --yes`),
        signal => pollRun(cfg, id, {
          signal,
          onTick: status => { if (!flags.json && !terminal.has(status)) console.log(`${statusText(status)}  ${id}`); },
        }),
      );
      emit(flags, { id, status: result.status, terminal: true }, () => `${statusText(result.status)}  ${id}`);
      if (result.status !== "COMPLETED") process.exitCode = EXIT.GENERAL;
      return;
    }

    case "monitor": {
      // Model-free page monitor (AI-company preflight prototype). Local only:
      // no account, no server round-trip; --summarize asks a local Ollama model.
      const store = makeMonitorStore();
      const sub = positionals[0];
      const outcomeText = (kind: string) => kind === "first" ? t("first snapshot saved") : kind === "changed" ? t("changed") : kind === "no-change" ? t("no change") : kind === "failed" ? t("check failed") : kind;
      switch (sub) {
        case "add": {
          const raw = positionals[1];
          if (!raw) usage("usage: braavo monitor add <url> [--every 6h] [--notify price,plans,promo,release,text] [--label <text>]");
          let url: string;
          try { url = assertMonitorUrl(raw); } catch (e) { usage((e as Error).message); }
          const everyMinutes = parseEvery(flag(flags, "every"));
          if (everyMinutes === undefined) usage(t("--every must look like 30m, 6h or 1d (minimum 15m)."));
          // --price is kept as a shorthand for --notify price.
          const notify = parseNotify(flags.price === true && flag(flags, "notify") === undefined ? "price" : flag(flags, "notify"));
          if (!notify) usage(t("--notify takes a comma list of: price, plans, promo, release, text."));
          const defs = store.list();
          const def: MonitorDef = { id: newMonitorId(url, defs), url, label: flag(flags, "label"), notify, everyMinutes, createdAt: new Date().toISOString() };
          store.save([...defs, def]);
          if (flags.json) emit(flags, def, () => "");
          else ui.ok(`${t("Added monitor {0} · every {1}", def.id, everyText(def.everyMinutes))} · ${notify.join(",")}`);
          return;
        }
        case "list": {
          const defs = store.list();
          emit(flags, defs.map(def => ({ ...def, lastCheck: store.readState(def.id).state ?? null })), () => {
            if (!defs.length) return t("No monitors. Add one: braavo monitor add <url>");
            return defs.map(def => {
              const state = store.readState(def.id).state;
              return `${ui.bold(def.id)}  ${notifyOf(def).join(",")}  ${everyText(def.everyMinutes)}  ${def.url}${state ? ui.dim(`  ${dateText(state.checkedAt)}`) : ""}`;
            }).join("\n");
          });
          return;
        }
        case "rm": {
          const id = positionals[1];
          if (!id) usage("usage: braavo monitor rm <id>");
          const defs = store.list();
          if (!defs.some(def => def.id === id)) die(t("No such monitor: {0}", id));
          store.save(defs.filter(def => def.id !== id));
          store.remove(id);
          ui.ok(t("Removed monitor {0}.", id));
          return;
        }
        case "log": {
          const id = positionals[1];
          if (!id) usage("usage: braavo monitor log <id>");
          if (!store.list().some(def => def.id === id)) die(t("No such monitor: {0}", id));
          const entries = store.readLedger(id).slice(-50);
          emit(flags, entries, () => entries.map(entry => `${dateText(entry.at)}  ${outcomeText(entry.outcome)}${entry.note ? `  ${entry.note}` : ""}`).join("\n"));
          return;
        }
        case "check": {
          const id = positionals[1];
          const all = store.list();
          const selected = id ? all.filter(def => def.id === id) : all;
          if (id && !selected.length) die(t("No such monitor: {0}", id));
          if (!selected.length) { emit(flags, [], () => t("No monitors. Add one: braavo monitor add <url>")); return; }
          const now = new Date();
          const results: Array<CheckOutcome | { id: string; kind: "not-due" | "failed"; error?: string }> = [];
          for (const def of selected) {
            if (flags.due === true && !isDue(def, store.readState(def.id).state, now)) { results.push({ id: def.id, kind: "not-due" }); continue; }
            try {
              results.push(await interruptible(() => t("Local waiting has a deadline. Remote work may continue after cancellation or timeout."), signal => checkMonitor(def, { store, signal, now })));
            } catch (e) {
              results.push({ id: def.id, kind: "failed", error: (e as Error).message });
              process.exitCode = EXIT.GENERAL;
            }
          }
          const summaries: Record<string, string> = {};
          if (flags.summarize === true) {
            const changed = results.filter((r): r is CheckOutcome => r.kind === "changed");
            if (changed.length) {
              const host = resolveOllamaHost(flag(flags, "host"));
              try {
                const model = await resolveOllamaModel(host, flag(flags, "model"));
                for (const outcome of changed) {
                  const def = selected.find(d => d.id === outcome.id)!;
                  const spin = flags.json ? undefined : ui.spinner(t("summarizing with {0}…", model));
                  const res = await interruptible(() => t("Local waiting has a deadline. Remote work may continue after cancellation or timeout."), signal => ollamaChat(host, model, summaryPrompt(def, outcome), { signal }));
                  spin?.stop();
                  summaries[outcome.id] = res.content;
                }
              } catch (e) {
                if (e instanceof OllamaUnreachableError) die(e.message);
                throw e;
              }
            }
          }
          emit(flags, results.map(r => ({ ...r, summary: summaries[r.id] })), () => results.map(r => {
            const head = `${ui.bold(r.id)}  ${r.kind === "not-due" ? t("not due") : outcomeText(r.kind)}`;
            if (r.kind === "failed") return `${head}  ${"error" in r ? r.error : ""}`;
            if (r.kind !== "changed" || !("added" in r)) return head;
            const lines = [head];
            for (const change of r.changes) {
              if (change.kind === "price") lines.push(`  ${t("prices: {0} → {1}", r.previousPrices.join(", ") || "—", r.prices.join(", ") || "—")}`);
              else if (change.kind === "plans") lines.push(`  ${t("plans: +{0} −{1}", change.added.join(", ") || "—", change.removed.join(", ") || "—")}`);
              else if (change.kind === "promo") lines.push(`  ${t("promotion: {0}", [...change.added.map(v => `+${v}`), ...change.removed.map(v => `−${v}`)].join(" · "))}`);
              else if (change.kind === "release") lines.push(`  ${t("new release: {0}", change.added.join(", "))}`);
            }
            for (const line of r.added.slice(0, 5)) lines.push(ui.dim(`  + ${line.slice(0, 160)}`));
            for (const line of r.removed.slice(0, 5)) lines.push(ui.dim(`  - ${line.slice(0, 160)}`));
            if (summaries[r.id]) lines.push("", summaries[r.id]);
            return lines.join("\n");
          }).join("\n"));
          return;
        }
        default:
          usage("usage: braavo monitor add <url> [--every 6h] [--notify price,plans,promo,release,text] [--label <text>] | list | rm <id> | check [<id>] [--due] [--summarize [--model <name>] [--host <url>]] | log <id>");
      }
      return;
    }

    case "code": {
      // Our own coding agent (plan 3.2; FK-1–FK-3) on the user's own key or local model: reads and
      // edits files under --dir, shows every change as a diff, asks before writing, `undo` restores.
      const { join, resolve } = await import("node:path");
      const { loadHooks, runCoder, undoSession } = await import("./daemon/coder");
      const checkpointDir = join(CONFIG_DIR, "checkpoints");
      if (positionals[0] === "undo") {
        const restored = undoSession(checkpointDir, flag(flags, "session"));
        emit(flags, { restored }, () => (restored.length ? t("Reverted {0} file(s): {1}", restored.length, restored.join(", ")) : t("Nothing to undo.")));
        return;
      }
      const codeUsage = "usage: braavo code <task> [--dir <path>] [--model PROVIDER/model] [--effort low|medium|high] [--plan] [--yes] [--allow-web <domain,...>] [--review-model PROVIDER/model] [--project-hooks] [--shell] [--max-turns <n>] | undo";
      const task = positionals.join(" ").trim();
      if (!task) usage(codeUsage);
      const { parseModelFlag } = await import("./forge/daemon-client");
      const { detectUserModels } = await import("./daemon/chat");
      const { suggestModel } = await import("./core/templates");
      const { prepareCall } = await import("./daemon/provider");
      const keys = makeKeyStore();
      const modelFlag = flag(flags, "model");
      let target = modelFlag ? parseModelFlag(modelFlag) : undefined;
      if (modelFlag && !target) usage(codeUsage);
      if (!target) {
        const s = suggestModel("strong", await detectUserModels(keys.list().map(e => e.provider)));
        if (s.status !== "ok") die(t("No usable model. Add a key (braavo keys add <provider>) or pull a local model."));
        target = { provider: s.provider, model: s.model };
      }
      const call = prepareCall({ ...target!, effort: flag(flags, "effort") }, { keys, maxTokens: 16_000 });
      if (!call.ok) die(call.message);
      // FK-9: optional second model that reviews every diff before it is applied.
      const reviewFlag = flag(flags, "review-model");
      const reviewTarget = reviewFlag ? parseModelFlag(reviewFlag) : undefined;
      if (reviewFlag && !reviewTarget) usage(codeUsage);
      const reviewer = reviewTarget ? prepareCall(reviewTarget, { keys, maxTokens: 400 }) : undefined;
      if (reviewer && !reviewer.ok) die(reviewer.message);
      const root = resolve(flag(flags, "dir") ?? process.cwd());
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const color = (code: number, text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
      const paint = (diff: string) => diff.split("\n").map(l => (l.startsWith("+") && !l.startsWith("+++") ? color(32, l) : l.startsWith("-") && !l.startsWith("---") ? color(31, l) : l.startsWith("@@") ? color(36, l) : l)).join("\n");
      let applyAll = has(flags, "yes"); let warned = false;
      const approve = async (change: { diff: string; review?: { verdict: string; reason: string } }): Promise<boolean> => {
        console.log(`\n${paint(change.diff)}`);
        if (change.review) console.log(color(change.review.verdict === "ok" ? 32 : 33, `review: ${change.review.verdict} · ${change.review.reason}`));
        // A risky review always asks a human, even with --yes; without a terminal it is refused.
        const risky = change.review?.verdict === "risky";
        if (applyAll && !risky) return true;
        if (!interactive) { if (!warned) { warned = true; console.error(t("Writes need confirmation: run in a terminal or pass --yes.")); } return false; }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(r => rl.question(`${t("Apply this change? [y]es / [n]o / [a]ll")} `, r));
        rl.close();
        if (/^a/i.test(answer.trim())) { applyAll = !risky || applyAll; return true; }
        return /^y/i.test(answer.trim());
      };
      // FK-15: sandboxed commands; each one is asked in the terminal, --yes never covers them.
      let warnedShell = false;
      const approveCommand = async (command: string): Promise<boolean> => {
        if (!interactive) { if (!warnedShell) { warnedShell = true; console.error(t("Commands need confirmation in a terminal.")); } return false; }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(r => rl.question(`\n$ ${command}\n${t("Run this command in the sandbox? [y]es / [n]o")} `, r));
        rl.close();
        return /^y/i.test(answer.trim());
      };
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      const sessionId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      console.error(`${target!.provider}/${target!.model} · ${root}${has(flags, "plan") ? " · plan" : ""}`);
      const result = await runCoder({
        web: { allow: (flag(flags, "allow-web") ?? "").split(",").map(d => d.trim().toLowerCase().replace(/^\*\./, "")).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) },
        reviewer: reviewer?.ok ? reviewer : undefined,
        shell: has(flags, "shell") ? { approve: approveCommand } : undefined,
        hooks: loadHooks([join(CONFIG_DIR, "hooks.json"), ...(has(flags, "project-hooks") ? [join(root, ".braavo", "hooks.json")] : [])]),
        root, task, call, plan: has(flags, "plan"), maxTurns: Math.min(Number(flag(flags, "max-turns")) || 25, 100), approve, checkpointDir, sessionId, signal: controller.signal,
        onEvent: ev => {
          if (ev.type === "text") process.stdout.write(ev.text);
          else if (ev.type === "tool") console.error(color(2, `· ${ev.name} ${ev.summary}`));
        },
      });
      process.stdout.write("\n");
      if (!has(flags, "plan")) console.error(t("Changes: {0} file(s) · undo: braavo code undo", result.changes.length));
      return;
    }

    case "company": {
      // Local company on the daemon (Şirket / Company, founder decisions K1–K3): hire the starter
      // agents, show the org panel, tune agents, add watch routines. Cloud companies stay under `agent`/`use`.
      const paths = daemonPaths();
      const live = runningDaemon(paths);
      if (!live) die(t("The daemon is not running. Start it: braavo daemon start"));
      const { DaemonClient, DaemonRequestError, parseModelFlag } = await import("./forge/daemon-client");
      const client = new DaemonClient({ port: live!.port, token: ensureToken(paths) });
      const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        try { return await client.json<T>(method, path, body); }
        catch (error) { if (error instanceof DaemonRequestError) die(error.message); throw error; }
      };
      const sub = positionals[0] ?? "show";
      const companyUsage = "usage: braavo company init <name> [--mission <text>] [--templates all|id,...] [--watch <urls>|@file] [--release-watch <urls>|@file] [--timezone <tz>] | show | tui | hire [...] | set <agent> [--model PROVIDER/model] [--effort low|medium|high|default] [--pause|--resume] | watch <name> --urls <urls>|@file [--every 6h] | run <routine> | findings [--role <role>] | prices [--url <url>] | budget <usd|none> | set <agent> --budget <usd|none> | set <agent> --skills <a,b>|none | task add <title> --agent <name> [--body <text>] [--priority <n>] | task list [--status OPEN|RUNNING|DONE|FAILED|CANCELLED] | task show|run|cancel|reopen <id> | hire-cli <claude-code|codex|gemini> --workdir <path> [--name <n>] [--approvals ask|edits|readonly] [--reports-to <agent>] | approvals | approve <id> [--deny] | goal add <title> [--body <text>] [--manager <agent>] [--run] | goal list | goal show|run <id> | trigger add rss|web <url> --agent <a> [--every 30m] | trigger add files <folder> --agent <a> [--pattern *.pdf] [--title <t>] [--body <b>] | trigger add github <owner/repo> --agent <a> [--events issues,pull_request,release,workflow_run] [--webhook] [--every 5m] | trigger add slack --agent <a> [--events mention,dm] [--channels C0123ABCD,...] | trigger list | trigger check|on|off|rm <id> | set <agent> --workdir <path> --approvals ask|edits|readonly | memory [list|search <words> [--scope <scope>]|cat <path>|edit <path> --text <text>|@file|core <agent> --text <text>|@file|embed <ollama-model>|off] [--company <id>] [--json]";
      /** Comma list or @file (every http(s) URL in it, e.g. a KAYNAKLAR.md), deduplicated, at most 20. */
      const urlList = async (value: string | undefined): Promise<string[]> => {
        if (!value) return [];
        let text = value;
        if (value.startsWith("@")) { const { readFileSync } = await import("node:fs"); text = readFileSync(value.slice(1), "utf8"); }
        const found = text.match(/https?:\/\/[^\s<>()"'`\]|,]+/g) ?? [];
        return [...new Set(found.map(u => u.replace(/[.;:]+$/, "")))].slice(0, 20);
      };
      const tz = flag(flags, "timezone");
      const lang = getLocale() === "tr" ? "tr" : "en";
      const pickCompany = async (): Promise<string> => {
        const explicit = flag(flags, "company");
        if (explicit) return explicit;
        const { companies } = await call<{ companies: Array<{ id: string }> }>("GET", "/companies");
        if (!companies.length) die(t("No company yet. Create one: braavo company init <name>"));
        if (companies.length > 1) die(t("Several companies; pass --company <id>."));
        return companies[0].id;
      };
      const hireBody = async () => {
        const templates = flag(flags, "templates");
        const urls: Record<string, string[]> = {};
        const watch = await urlList(flag(flags, "watch")); if (watch.length) urls["market-analyst/watch-competitors"] = watch;
        const release = await urlList(flag(flags, "release-watch")); if (release.length) urls["release-tracker/watch-releases"] = release;
        return { templates: !templates || templates === "all" ? "all" : templates.split(",").map(x => x.trim()), urls, ...(tz ? { timezone: tz } : {}), locale: lang };
      };
      const reportHire = (r: { agents: Array<{ id: string; name: string }>; skipped: string[]; needsSetup: Array<{ agentId: string; reason: string; provider?: string }>; needsUrls: string[] }) => {
        const lines = [t("Hired {0} agents", r.agents.length)];
        const nameOf = (id: string) => r.agents.find(a => a.id === id)?.name ?? id;
        if (r.needsSetup.length) lines.push(t("Needs setup: {0}", r.needsSetup.map(n => `${nameOf(n.agentId)} (${n.reason}${n.provider ? ` ${n.provider}` : ""})`).join(", ")));
        if (r.needsUrls.length) lines.push(t("Needs URLs for: {0} (pass --watch or --release-watch)", r.needsUrls.join(", ")));
        return lines.join("\n");
      };
      const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" }) : "—");

      if (sub === "init") {
        const name = positionals.slice(1).join(" ").trim();
        if (!name) usage(companyUsage);
        const { company } = await call<{ company: { id: string; name: string } }>("POST", "/companies", { name, mission: flag(flags, "mission") });
        const result = await call<any>("POST", `/companies/${company.id}/hire`, await hireBody());
        emit(flags, { company, ...result }, () => `${t("Company created: {0}", `${company.name} (${company.id})`)}\n${reportHire(result)}`);
        return;
      }
      const companyId = await pickCompany();
      if (sub === "tui") {
        // The company panel in the terminal: agents, budgets and tasks, refreshed every few seconds.
        if (!process.stdin.isTTY || !process.stdout.isTTY) die(t("This view needs an interactive terminal."));
        const { runCompanyTui } = await import("./forge/company-tui");
        const money = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}/month`);
        await runCompanyTui({
          input: process.stdin, output: process.stdout,
          load: async () => ({
            panel: await client.json<any>("GET", `/companies/${companyId}/panel`),
            tasks: (await client.json<{ tasks: any[] }>("GET", `/companies/${companyId}/tasks`)).tasks,
          }),
          act: async (action) => {
            switch (action.type) {
              case "pause": case "resume": {
                const { agent } = await client.json<{ agent: { name: string } }>("PATCH", `/agents/${action.agentId}`, { status: action.type === "pause" ? "paused" : "idle" });
                return t("Agent updated: {0}", agent.name);
              }
              case "agent-budget":
                await client.json("PATCH", `/agents/${action.agentId}`, { budgetUsdMonthly: action.usd });
                return t("Budget set: {0}", money(action.usd));
              case "company-budget":
                await client.json("PATCH", `/companies/${companyId}`, { monthlyBudgetUsd: action.usd });
                return t("Budget set: {0}", money(action.usd));
              case "task-add": {
                const { task } = await client.json<{ task: { title: string } }>("POST", `/companies/${companyId}/tasks`, { title: action.title, assignee: action.agentId });
                return t("Task added: {0}", task.title);
              }
              case "task-run": {
                const { task } = await client.json<{ task: { title: string; status: string; note: string | null } }>("POST", `/tasks/${action.taskId}/run`);
                return `${task.title}: ${statusText(task.status)}${task.note ? ` · ${task.note}` : ""}`;
              }
              case "task-cancel": case "task-reopen": {
                const { task } = await client.json<{ task: { title: string; status: string } }>("PATCH", `/tasks/${action.taskId}`, { status: action.type === "task-cancel" ? "CANCELLED" : "OPEN" });
                return `${task.title}: ${statusText(task.status)}`;
              }
              default: return "";
            }
          },
        });
        return;
      }
      if (sub === "hire-cli") {
        // Plan 3.1: your own Claude Code, Codex or Gemini CLI as an employee, over ACP.
        const engine = positionals[1];
        const workdir = flag(flags, "workdir");
        if (!engine || !workdir) usage(companyUsage);
        const { resolve } = await import("node:path");
        const manager = flag(flags, "reports-to");
        const managerId = manager ? (await call<any>("GET", `/companies/${companyId}/panel`)).agents.find((a: any) => a.id === manager || a.name.toLowerCase() === manager.toLowerCase() || a.role === manager)?.id : undefined;
        const { agent } = await call<{ agent: any }>("POST", `/companies/${companyId}/workers`, {
          engine, workdir: resolve(workdir!), name: flag(flags, "name"), role: flag(flags, "role"), approvalPolicy: flag(flags, "approvals") ?? "ask",
          ...(managerId ? { reportsToAgentId: managerId } : {}),
        });
        emit(flags, agent, () => t("CLI employee hired: {0}", `${agent.name} · ${agent.engine} · ${agent.workdir} · ${agent.approval_policy}`));
        return;
      }
      if (sub === "goal") {
        // Plan 4.5: a goal for the manager, who plans, hands steps to the team and re-plans when stuck.
        const action = positionals[1] ?? "list";
        const findGoal = async (ref: string | undefined) => {
          if (!ref) usage(companyUsage);
          const { goals } = await call<{ goals: any[] }>("GET", `/companies/${companyId}/goals`);
          const g = goals.find(x => x.id === ref || x.id.startsWith(ref!));
          if (!g) die(t("Agent or routine not found: {0}", ref!));
          return g;
        };
        if (action === "add") {
          const title = positionals.slice(2).join(" ").trim();
          if (!title) usage(companyUsage);
          const { goal } = await call<{ goal: any }>("POST", `/companies/${companyId}/goals`, { title, body: flag(flags, "body"), manager: flag(flags, "manager") });
          if (has(flags, "run")) await call("POST", `/goals/${goal.id}/run`);
          emit(flags, goal, () => `${t("Goal added: {0}", goal.title)}  ${goal.id}${has(flags, "run") ? `\n${t("Goal started: {0}", goal.id)}` : ""}`);
          return;
        }
        if (action === "list") {
          const { goals } = await call<{ goals: any[] }>("GET", `/companies/${companyId}/goals`);
          emit(flags, goals, () => goals.length ? goals.map(g => `${g.id.slice(0, 11)}  ${String(g.status).padEnd(8)} ${String(g.title).slice(0, 70)}${g.ledger ? ` · ${g.ledger.progress.length}/${g.ledger.plan.length}` : ""}${g.note ? ` · ${String(g.note).slice(0, 80)}` : ""}`).join("\n") : t("No goals yet."));
          return;
        }
        if (action === "show") {
          const g = await findGoal(positionals[2]);
          const { goal } = await call<{ goal: any }>("GET", `/goals/${g.id}`);
          const { ledgerMarkdown, emptyLedger } = await import("./daemon/ledger");
          emit(flags, goal, () => ledgerMarkdown(goal, goal.ledger ?? emptyLedger(), goal.result).trimEnd() + (goal.note ? `\n\n${goal.note}` : ""));
          return;
        }
        if (action === "run") {
          const g = await findGoal(positionals[2]);
          await call("POST", `/goals/${g.id}/run`);
          emit(flags, { id: g.id, running: true }, () => t("Goal started: {0}", g.title));
          return;
        }
        usage(companyUsage);
      }
      if (sub === "trigger") {
        // Plan 5.4: rss <url> | web <url> | files <folder> | github <owner/repo> | slack → a task for --agent when something new happens.
        const action = positionals[1] ?? "list";
        if (action === "add") {
          const kind = positionals[2]; const target = positionals[3];
          if (!kind || (!target && kind !== "slack") || !flag(flags, "agent")) usage(companyUsage);
          const { resolve } = await import("node:path");
          const every = flag(flags, "every");
          const minutes = every ? (/^(\d+)h$/.exec(every) ? Number(/^(\d+)h$/.exec(every)![1]) * 60 : Number(every.replace(/m$/, ""))) : undefined;
          const { trigger, webhook } = await call<{ trigger: any; webhook?: { path: string; secret: string } }>("POST", `/companies/${companyId}/triggers`, {
            kind, agent: flag(flags, "agent"), name: flag(flags, "name"), title: flag(flags, "title"), body: flag(flags, "body"),
            ...(kind === "files" ? { path: resolve(target!), pattern: flag(flags, "pattern") }
              : kind === "slack" ? { ...(flag(flags, "events") ? { events: flag(flags, "events") } : {}), ...(flag(flags, "channels") ? { channels: flag(flags, "channels") } : {}) }
              : kind === "github" ? { repo: target, ...(flag(flags, "events") ? { events: flag(flags, "events") } : {}), mode: has(flags, "webhook") ? "webhook" : "poll", ...(minutes ? { everyMinutes: minutes } : {}) }
              : { url: target, ...(minutes ? { everyMinutes: minutes } : {}) }),
          });
          const port = runningDaemon(daemonPaths())?.port;
          emit(flags, webhook ? { ...trigger, webhook } : trigger, () => [
            t("Trigger added: {0}", `${trigger.name}  ${trigger.id}`),
            ...(webhook ? [t("Webhook address on this computer: {0}", `http://127.0.0.1:${port ?? "<port>"}${webhook.path}`), t("Webhook secret (shown once): {0}", webhook.secret)] : []),
          ].join("\n"));
          return;
        }
        if (action === "list") {
          const { triggers } = await call<{ triggers: any[] }>("GET", `/companies/${companyId}/triggers`);
          emit(flags, triggers, () => triggers.length ? triggers.map(x => `${x.id.slice(0, 11)}  ${x.kind.padEnd(5)} ${x.enabled ? "on " : "off"} ${String(x.name).slice(0, 70)}${x.last_fired_at ? ` · ${when(x.last_fired_at)}` : ""}${x.note ? ` · ${String(x.note).slice(0, 80)}` : ""}`).join("\n") : t("No triggers yet."));
          return;
        }
        const ref = positionals[2];
        if (!ref) usage(companyUsage);
        const { triggers } = await call<{ triggers: any[] }>("GET", `/companies/${companyId}/triggers`);
        const tr = triggers.find(x => x.id === ref || x.id.startsWith(ref!));
        if (!tr) die(t("Agent or routine not found: {0}", ref!));
        if (action === "check") { const r = await call<{ fired: number; note?: string }>("POST", `/triggers/${tr.id}/check`); emit(flags, r, () => `${tr.name}: ${r.fired}${r.note ? ` · ${r.note}` : ""}`); return; }
        if (action === "on" || action === "off") { await call("PATCH", `/triggers/${tr.id}`, { enabled: action === "on" }); emit(flags, { id: tr.id, enabled: action === "on" }, () => `${tr.name}: ${action}`); return; }
        if (action === "rm") { await call("DELETE", `/triggers/${tr.id}`); emit(flags, { id: tr.id, removed: true }, () => `${tr.name}: ✗`); return; }
        usage(companyUsage);
      }
      if (sub === "approvals") {
        const { approvals } = await call<{ approvals: Array<{ id: string; title: string; tool: string; paths: string[]; status: string; created_at: string }> }>("GET", `/companies/${companyId}/approvals?status=pending`);
        emit(flags, approvals, () => approvals.length ? approvals.map(a => `${a.id}  ${a.tool.padEnd(8)} ${a.title.slice(0, 80)}${a.paths.length ? ` · ${a.paths.join(", ").slice(0, 80)}` : ""}  ${when(a.created_at)}`).join("\n") : t("No approvals waiting."));
        return;
      }
      if (sub === "approve") {
        const ref = positionals[1];
        if (!ref) usage(companyUsage);
        const { approval } = await call<{ approval: { id: string; status: string; title: string } }>("POST", `/approvals/${encodeURIComponent(ref!)}`, { decision: has(flags, "deny") ? "reject" : "allow" });
        emit(flags, approval, () => t("Approval {0}: {1}", approval.title, statusText(approval.status)));
        return;
      }
      if (sub === "hire") {
        const result = await call<any>("POST", `/companies/${companyId}/hire`, await hireBody());
        emit(flags, result, () => reportHire(result));
        return;
      }
      const p = await call<any>("GET", `/companies/${companyId}/panel`);
      const findAgent = (key: string) => p.agents.find((a: any) => a.id === key || a.role === key || a.name.toLowerCase() === key.toLowerCase());
      const findRoutine = (key: string) => p.routines.find((r: any) => r.id === key || r.name.toLowerCase() === key.toLowerCase());
      if (sub === "show") {
        emit(flags, p, () => {
          const byId = new Map(p.agents.map((a: any) => [a.id, a]));
          const pct = (r: number | null) => (r === null || r === undefined ? "" : ` (${Math.round(r * 100)}%)`);
          const budget = p.company.monthlyBudgetUsd !== null ? ` / $${p.company.monthlyBudgetUsd.toFixed(2)}${pct(p.month.budgetRatio)}` : "";
          const out = [`${p.company.name} · ${t("{0} agents", p.agents.length)} · $${p.month.usd.toFixed(2)}${budget} · ${tokens(p.month.inputTokens)}/${tokens(p.month.outputTokens)} tokens`];
          if (p.month.unpricedCalls) out.push(t("{0} calls on unpriced models (set prices in ~/.braavo/prices.json)", p.month.unpricedCalls));
          const walk = (nodes: any[], prefix: string) => nodes.forEach((n, i) => {
            const a: any = byId.get(n.id); const lastNode = i === nodes.length - 1;
            // An agent in error has no usable model yet (K3: nothing is defaulted); its stored model is only a placeholder.
            const model = a.status === "error" ? "— (braavo setup)" : `${a.provider}/${a.model}`;
            const spend = a.budgetUsdMonthly !== null ? ` · $${a.month.usd.toFixed(2)}/$${a.budgetUsdMonthly.toFixed(2)}${pct(a.budgetRatio)}` : a.month.usd ? ` · $${a.month.usd.toFixed(2)}` : "";
            out.push(`${prefix}${lastNode ? "└─" : "├─"} ${a.name}  ${model} · ${a.effort ?? "default"} · ${a.status}${a.month.runs ? ` · ${a.month.runs}×` : ""}${spend}`);
            walk(n.children, `${prefix}${lastNode ? "   " : "│  "}`);
          });
          walk(p.tree, "");
          if (p.routines.length) {
            out.push("", t("Routines"));
            for (const r of p.routines) out.push(`  ${r.name} · ${(byId.get(r.agentId) as any)?.name ?? "?"} · ${t("next")} ${when(r.nextFireAt)}${r.last ? ` · ${t("last")} ${r.last.outcome}${r.last.note ? ` (${String(r.last.note).slice(0, 80)})` : ""}` : ""}`);
          }
          if (p.tasks && p.tasks.open + p.tasks.running + p.tasks.done + p.tasks.failed > 0) {
            out.push("", `${t("Tasks")} · ${p.tasks.open} open · ${p.tasks.running} running · ${p.tasks.done} done · ${p.tasks.failed} failed`);
            for (const tk of p.tasks.recent.slice(0, 5)) out.push(`  ${tk.id.slice(0, 11)}  ${tk.status.padEnd(9)} ${String(tk.title).slice(0, 60)}${tk.note ? ` · ${String(tk.note).slice(0, 60)}` : ""}`);
          }
          if (p.activity.length) {
            out.push("", t("Recent activity"));
            for (const a of p.activity.slice(0, 8)) out.push(`  ${when(a.at)}  ${a.verb}  ${a.summary}`);
          }
          return out.join("\n");
        });
        return;
      }
      if (sub === "set") {
        const agent = positionals[1] ? findAgent(positionals[1]) : undefined;
        if (!agent) die(t("Agent or routine not found: {0}", positionals[1] ?? ""));
        const body: Record<string, unknown> = {};
        const m = flag(flags, "model");
        if (m) { const parsed = parseModelFlag(m); if (!parsed) usage(companyUsage); Object.assign(body, parsed); }
        const effort = flag(flags, "effort");
        if (effort) body.effort = effort === "default" ? null : effort;
        if (has(flags, "pause")) body.status = "paused";
        if (has(flags, "resume")) body.status = "idle";
        const skillList = flag(flags, "skills");
        if (skillList !== undefined) {
          // Plan 5.3: replace the agent's skills (comma list, or none).
          const names = skillList === "none" ? [] : skillList.split(",").map(x => x.trim()).filter(Boolean);
          const { skills } = await call<{ skills: string[] }>("PUT", `/agents/${agent.id}/skills`, { skills: names });
          if (!Object.keys(body).length && flag(flags, "budget") === undefined) {
            emit(flags, { agent: agent.id, skills }, () => t("Agent updated: {0}", `${agent.name} · skills: ${skills.join(", ") || "—"}`));
            return;
          }
        }
        const workdirFlag = flag(flags, "workdir");
        if (workdirFlag !== undefined) { const { resolve } = await import("node:path"); body.workdir = resolve(workdirFlag); }
        const approvalsFlag = flag(flags, "approvals");
        if (approvalsFlag !== undefined) body.approvalPolicy = approvalsFlag;
        const agentBudget = flag(flags, "budget");
        if (agentBudget !== undefined) {
          const v = agentBudget === "none" ? null : Number(agentBudget);
          if (v !== null && (!Number.isFinite(v) || v < 0)) usage(companyUsage);
          body.budgetUsdMonthly = v;
        }
        const { agent: updated } = await call<{ agent: any }>("PATCH", `/agents/${agent.id}`, body);
        emit(flags, updated, () => t("Agent updated: {0}", `${updated.name} · ${updated.provider}/${updated.model} · ${updated.effort ?? "default"} · ${updated.status}`));
        return;
      }
      if (sub === "watch") {
        const name = positionals.slice(1).join(" ").trim();
        const urls = await urlList(flag(flags, "urls"));
        const analyst = p.agents.find((a: any) => a.role === "market-analyst");
        if (!name || !urls.length) usage(companyUsage);
        if (!analyst) die(t("Agent or routine not found: {0}", "market-analyst"));
        const every = flag(flags, "every") ?? "6h";
        const hours = /^(\d{1,3})h$/.exec(every)?.[1];
        if (!hours) usage(companyUsage);
        const { routine } = await call<{ routine: any }>("POST", `/companies/${companyId}/routines`, {
          agentId: analyst.id, name, prompt: "Summarise what changed on the watched pages and record new prices and plans.",
          rrule: `FREQ=HOURLY;INTERVAL=${hours}`, timezone: tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          preflight: { type: "web", urls, notify: ["price", "plans", "promo", "release"] }, delivery: "silent-unless-change",
        });
        emit(flags, routine, () => `${routine.name} · ${urls.length} URL · ${t("next")} ${when(routine.next_fire_at)}`);
        return;
      }
      if (sub === "run") {
        const routine = positionals[1] ? findRoutine(positionals.slice(1).join(" ")) : undefined;
        if (!routine) die(t("Agent or routine not found: {0}", positionals.slice(1).join(" ")));
        const result = await call<{ outcome: string; note?: string }>("POST", `/routines/${routine.id}/run`);
        emit(flags, result, () => `${routine.name}: ${result.outcome}${result.note ? ` · ${result.note}` : ""}`);
        return;
      }
      if (sub === "budget") {
        // Plan 2.9: company monthly budget in USD; 80% warns, 100% pauses every agent.
        const raw = positionals[1];
        if (!raw) usage(companyUsage);
        const v = raw === "none" ? null : Number(raw);
        if (v !== null && (!Number.isFinite(v) || v < 0)) usage(companyUsage);
        const { company } = await call<{ company: any }>("PATCH", `/companies/${companyId}`, { monthlyBudgetUsd: v });
        emit(flags, company, () => t("Budget set: {0}", v === null ? "—" : `$${v.toFixed(2)}/month`));
        return;
      }
      if (sub === "task") {
        // Plan 2.3: one-off work for one agent; the daemon runs open tasks one at a time.
        const action = positionals[1] ?? "list";
        const taskLine = (tk: any) => `${tk.id.slice(0, 11)}  ${String(tk.status).padEnd(9)} ${String(tk.title).slice(0, 70)}${tk.assignee_agent_id ? ` · ${(p.agents.find((a: any) => a.id === tk.assignee_agent_id) as any)?.name ?? "?"}` : ""}${tk.note ? ` · ${String(tk.note).slice(0, 80)}` : ""}`;
        const findTask = async (ref: string | undefined) => {
          if (!ref) usage(companyUsage);
          const { tasks } = await call<{ tasks: any[] }>("GET", `/companies/${companyId}/tasks`);
          const hit = tasks.find(tk => tk.id === ref || tk.id.startsWith(ref!));
          if (!hit) die(t("Agent or routine not found: {0}", ref!));
          return hit;
        };
        if (action === "add") {
          const title = positionals.slice(2).join(" ").trim();
          if (!title) usage(companyUsage);
          const priority = flag(flags, "priority");
          const { task } = await call<{ task: any }>("POST", `/companies/${companyId}/tasks`, {
            title, body: flag(flags, "body"), assignee: flag(flags, "agent") ?? null, ...(priority !== undefined ? { priority: Number(priority) } : {}),
          });
          emit(flags, task, () => t("Task added: {0}", taskLine(task)));
          return;
        }
        if (action === "list") {
          const status = flag(flags, "status");
          const { tasks } = await call<{ tasks: any[] }>("GET", `/companies/${companyId}/tasks${status ? `?status=${encodeURIComponent(status.toUpperCase())}` : ""}`);
          emit(flags, { tasks }, () => (tasks.length ? tasks.map(taskLine).join("\n") : t("No tasks yet.")));
          return;
        }
        if (action === "show") {
          const tk = await findTask(positionals[2]);
          // Plan 3.1: a CLI employee's run leaves structured events (tool calls, diffs, approvals, plan).
          const { events } = await call<{ events: Array<{ kind: string; data: any }> }>("GET", `/tasks/${tk.id}/events`);
          const eventLine = (e: { kind: string; data: any }) => {
            const d = e.data ?? {};
            switch (e.kind) {
              case "tool_call": return `  ▸ ${d.tool} · ${d.title}${d.paths?.length ? ` · ${d.paths.join(", ")}` : ""}`;
              case "tool_update": return d.status === "completed" || d.status === "failed" ? `    ${d.status}${d.text ? ` · ${String(d.text).split("\n")[0].slice(0, 100)}` : ""}` : "";
              case "diff": return `  ± ${d.path} (${d.oldText === null ? "new" : `${String(d.oldText).split("\n").length}→${String(d.newText).split("\n").length} lines`})`;
              case "permission": return `  ${d.decision === "allow" ? "✓" : "✗"} ${d.tool} · ${d.title} (${d.by})`;
              case "plan": return `  plan: ${(d.entries ?? []).map((x: any) => `${x.status === "completed" ? "✓" : "·"} ${x.content}`).join(" | ").slice(0, 300)}`;
              default: return "";
            }
          };
          emit(flags, { ...tk, events }, () => [taskLine(tk), tk.body ? `\n${tk.body}` : "", ...(events.length ? ["", ...events.map(eventLine).filter(Boolean)] : []), tk.result ? `\n${tk.result}` : ""].filter(Boolean).join("\n"));
          return;
        }
        if (action === "run") {
          const tk = await findTask(positionals[2]);
          const result = await call<{ outcome: string; note?: string; task: any }>("POST", `/tasks/${tk.id}/run`);
          emit(flags, result, () => `${taskLine(result.task)}${result.task.result ? `\n\n${result.task.result}` : ""}`);
          return;
        }
        if (action === "cancel" || action === "reopen") {
          const tk = await findTask(positionals[2]);
          const { task } = await call<{ task: any }>("PATCH", `/tasks/${tk.id}`, { status: action === "cancel" ? "CANCELLED" : "OPEN" });
          emit(flags, task, () => taskLine(task));
          return;
        }
        usage(companyUsage);
        return;
      }
      if (sub === "prices") {
        // FK-13: competitor price history recorded by the watch routines.
        const { prices } = await call<{ prices: Array<{ subject: string; value: string; valid_from: string; valid_to: string | null }> }>("GET", `/companies/${companyId}/prices${flag(flags, "url") ? `?url=${encodeURIComponent(flag(flags, "url")!)}` : ""}`);
        emit(flags, { prices }, () => {
          if (!prices.length) return t("No findings yet.");
          const out: string[] = []; let last = "";
          for (const f of prices) { if (f.subject !== last) { out.push(f.subject); last = f.subject; } out.push(`  ${when(f.valid_from)} → ${f.valid_to ? when(f.valid_to) : "…"}  ${f.value}`); }
          return out.join("\n");
        });
        return;
      }
      if (sub === "findings") {
        const { existsSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const role = flag(flags, "role") ?? "market-analyst";
        const file = join(CONFIG_DIR, "memory", companyId, "findings", `${role}.md`);
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        emit(flags, { file, text }, () => (text.trim() ? text.trim().split("\n").slice(-60).join("\n") : t("No findings yet.")));
        return;
      }
      if (sub === "memory") {
        // Plan 4.1–4.3: markdown notes under ~/.braavo/memory/<company> (git-versioned, searchable).
        const action = positionals[1] ?? "list";
        const base = `/companies/${companyId}/memory`;
        if (action === "list") {
          const r = await call<{ docs: Array<{ path: string; scope: string; bytes: number; updatedAt: string }>; agents: Array<{ name: string; core: string }> }>("GET", base);
          emit(flags, r, () => r.docs.length
            ? [t("Memory: {0}", `${CONFIG_DIR}/memory/${companyId}`), ...r.docs.map(d => `${d.path.padEnd(40)} ${d.scope.padEnd(24)} ${when(d.updatedAt)}`)].join("\n")
            : t("No notes yet. Start with: braavo company memory edit company.md --text <text>|@file"));
          return;
        }
        if (action === "embed") {
          // embed <ollama-model> | off — optional meaning search; keyword search stays when off or unreachable.
          const model = positionals[2];
          if (!model) usage(companyUsage);
          const { saveVectorSettings, loadVectorSettings } = await import("./daemon/vectors");
          const file = `${CONFIG_DIR}/memory-settings.json`;
          const settings = { ...loadVectorSettings(file), embedModel: model === "off" ? null : model! };
          saveVectorSettings(file, settings);
          emit(flags, settings, () => settings.embedModel ? t("Meaning search with {0}; keyword search is used while it is unavailable.", settings.embedModel) : t("Meaning search is off; memory search uses keywords."));
          return;
        }
        if (action === "search") {
          const q = positionals.slice(2).join(" ");
          if (!q) usage(companyUsage);
          const scope = flag(flags, "scope");
          const r = await call<{ hits: Array<{ path: string; heading: string; snippet: string }>; mode: string; note?: string }>("GET", `${base}?${new URLSearchParams({ q, ...(scope ? { scope } : {}) })}`);
          emit(flags, r, () => [...(r.hits.length ? r.hits.map(h => `${h.path}${h.heading ? ` · ${h.heading}` : ""}\n  ${h.snippet.replace(/\s+/g, " ")}`) : [t("No matches.")]), ...(r.note ? [r.note] : [])].join("\n"));
          return;
        }
        if (action === "cat") {
          const path = positionals[2];
          if (!path) usage(companyUsage);
          const r = await call<{ path: string; content: string }>("GET", `${base}?${new URLSearchParams({ path })}`);
          emit(flags, r, () => r.content.trimEnd());
          return;
        }
        if (action === "edit" || action === "core") {
          // edit <path> --text <text>|@file · core <agent> --text <text>|@file (the agent's core note, ≤2000 chars)
          let path = positionals[2];
          if (!path) usage(companyUsage);
          if (action === "core") {
            const r = await call<{ agents: Array<{ id: string; name: string; core: string }> }>("GET", base);
            const agent = r.agents.find(a => a.id === path || a.name.toLowerCase() === path!.toLowerCase() || a.core === `agents/${path}/core.md`);
            if (!agent) die(t("Agent or routine not found: {0}", path));
            path = agent!.core;
          }
          const raw = flag(flags, "text");
          if (raw === undefined) usage(companyUsage);
          let content = raw!;
          if (content.startsWith("@")) { const { readFileSync } = await import("node:fs"); content = readFileSync(content.slice(1), "utf8"); }
          const r = await call<{ doc: { path: string; bytes: number } }>("PUT", base, { path, content });
          emit(flags, r, () => t("Saved {0} ({1} bytes)", r.doc.path, r.doc.bytes));
          return;
        }
        usage(companyUsage);
      }
      usage(companyUsage);
      return;
    }

    case "chat": {
      // Multi-turn, streamed chat on the local daemon (plan 1.2; docs/DAEMON-CHAT.md). The daemon
      // holds the history and the user's own keys; this process only reads its loopback token.
      const paths = daemonPaths();
      const live = runningDaemon(paths);
      if (!live) die(t("The daemon is not running. Start it: braavo daemon start"));
      const { DaemonClient, DaemonRequestError, parseModelFlag } = await import("./forge/daemon-client");
      const client = new DaemonClient({ port: live!.port, token: ensureToken(paths) });
      const sub = positionals[0];
      const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
      if (sub === "list") {
        const { conversations } = await client.json<{ conversations: any[] }>("GET", "/conversations?limit=50");
        emit(flags, { conversations }, () => conversations.length
          ? conversations.map(c => `${c.id}  ${when(c.updatedAt)}  ${c.provider ?? "-"}/${c.model ?? "-"}  ${c.title || "—"}`).join("\n")
          : t("No conversations yet."));
        return;
      }
      if (sub === "show") {
        const id = positionals[1];
        if (!id) usage("usage: braavo chat show <conversationId> [--json]");
        const data = await client.json<{ conversation: any; messages: any[] }>("GET", `/conversations/${encodeURIComponent(id)}`);
        emit(flags, data, () => [`${data.conversation.title || data.conversation.id} · ${data.conversation.provider}/${data.conversation.model}`,
          ...data.messages.map(m => `\n${m.role === "user" ? "›" : "‹"} ${m.content}`)].join("\n"));
        return;
      }
      if (sub === "export") {
        const id = positionals[1];
        const format = flag(flags, "format") ?? "md";
        if (!id || (format !== "md" && format !== "json")) usage("usage: braavo chat export <conversationId> [--format md|json] [--out <file>]");
        const body = await client.text(`/conversations/${encodeURIComponent(id)}/export?format=${format}`);
        const out = flag(flags, "out");
        if (out) { const { writeFileSync } = await import("node:fs"); writeFileSync(out, body, { mode: 0o600 }); console.error(out); }
        else process.stdout.write(body);
        return;
      }
      if (sub === "search") {
        const q = positionals.slice(1).join(" ");
        if (!q) usage("usage: braavo chat search <text> [--json]");
        const { results } = await client.json<{ results: any[] }>("GET", `/search?q=${encodeURIComponent(q)}`);
        emit(flags, { results }, () => results.length ? results.map(r => `${r.conversationId}  ${when(r.at)}  ${r.role}: ${r.snippet}`).join("\n") : t("No matches."));
        return;
      }

      const modelFlag = flag(flags, "model");
      let chosen = modelFlag ? parseModelFlag(modelFlag) : undefined;
      if (modelFlag && !chosen) usage("usage: braavo chat [<message>] [--model PROVIDER/model] [--effort low|medium|high] [--continue <conversationId>|last]");
      const effort = flag(flags, "effort");
      let conversationId = flag(flags, "continue");
      if (conversationId === "last") conversationId = (await client.json<{ conversations: any[] }>("GET", "/conversations?limit=1")).conversations[0]?.id;
      const newConversation = async (): Promise<string> => {
        let model = chosen;
        if (!model) {
          const { suggestions } = await client.json<{ suggestions: Record<string, { status: string; provider?: string; model?: string }> }>("GET", "/models");
          const mid = suggestions.mid;
          if (mid?.status !== "ok") die(t("No usable model. Add a key (braavo keys add <provider>) or pull a local model."));
          model = { provider: mid.provider!, model: mid.model! };
        }
        return (await client.json<{ conversation: { id: string } }>("POST", "/conversations", { ...model, ...(effort ? { effort } : {}) })).conversation.id;
      };
      if (conversationId && (chosen || effort)) await client.json("PATCH", `/conversations/${encodeURIComponent(conversationId)}`, { ...(chosen ?? {}), ...(effort ? { effort } : {}) });

      // Plan 5.9: --speak (or /speak in the prompt) reads each answer aloud with the system voice.
      const { speak, speechCommand } = await import("./forge/speak");
      let speaking = has(flags, "speak");
      const voiceCommand = () => {
        const c = speechCommand();
        if (!c) { console.error(t("Speech is not available on this system (needs say, spd-say, espeak or PowerShell).")); speaking = false; }
        return c;
      };
      if (speaking) voiceCommand();
      const send = async (content: string): Promise<void> => {
        conversationId ??= await newConversation();
        const controller = new AbortController();
        const onInt = () => controller.abort();
        process.once("SIGINT", onInt);
        let ended = false;
        let answer = "";
        try {
          await client.turn(conversationId, content, ev => {
            if (ev.type === "delta") { answer += ev.text; process.stdout.write(ev.text); }
            else if (ev.type === "error") process.stderr.write(`\n${ev.error}\n`);
            else if (ev.type === "done") { ended = true; process.stdout.write(ev.stopReason === "aborted" ? ` ${t("(stopped)")}\n` : "\n"); }
          }, controller.signal);
          if (speaking && answer.trim() && !controller.signal.aborted) await speak(answer, { command: speechCommand(), signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) { if (!ended) process.stdout.write(` ${t("(stopped)")}\n`); return; }
          if (error instanceof DaemonRequestError) die(error.message);
          throw error;
        } finally {
          process.removeListener("SIGINT", onInt);
        }
      };

      const message = positionals.join(" ");
      if (message) { await send(message); if (!has(flags, "quiet")) console.error(`[${conversationId}]`); return; }
      if (!process.stdin.isTTY) {
        let piped = "";
        for await (const chunk of process.stdin) piped += chunk;
        if (!piped.trim()) usage("usage: braavo chat [<message>] [--model PROVIDER/model] [--effort low|medium|high] [--continue <conversationId>|last]");
        await send(piped);
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
      console.log(t("Chat on your computer · /new, /exit"));
      console.log(t("/speak reads answers aloud; dictate with your system's dictation (macOS: press Fn twice)."));
      rl.prompt();
      for await (const line of rl) {
        const text = line.trim();
        if (text === "/exit") break;
        if (text === "/new") { conversationId = undefined; rl.prompt(); continue; }
        if (text === "/speak" || text === "/speak on" || text === "/speak off") {
          speaking = text !== "/speak off" && (text === "/speak on" || !speaking) && Boolean(voiceCommand());
          console.error(speaking ? "/speak on" : "/speak off");
          rl.prompt(); continue;
        }
        // FK-4: the same slash commands the phone and desktop chat understand.
        const slashModel = /^\/model\s+(\S+)$/.exec(text);
        if (slashModel) {
          const m = parseModelFlag(slashModel[1]);
          if (!m) console.error("/model PROVIDER/model");
          else if (conversationId) { try { await client.json("PATCH", `/conversations/${encodeURIComponent(conversationId)}`, m); console.error(`${m.provider}/${m.model}`); } catch (e) { console.error((e as Error).message); } }
          else { chosen = m; console.error(`${m.provider}/${m.model}`); }
          rl.prompt(); continue;
        }
        if (text === "/export" || text.startsWith("/export ")) {
          if (conversationId) process.stdout.write(await client.text(`/conversations/${encodeURIComponent(conversationId)}/export?format=${text.endsWith("json") ? "json" : "md"}`));
          rl.prompt(); continue;
        }
        if (text) { rl.pause(); await send(text); rl.resume(); }
        rl.prompt();
      }
      rl.close();
      return;
    }

    case "daemon": {
      // Local daemon (AI company runtime): loopback API + scheduler. `run` stays in the
      // foreground (desktop sidecar, launchd/systemd); `start` detaches it.
      const paths = daemonPaths();
      const sub = positionals[0];
      const version = (require("../package.json") as { version: string }).version;
      if (sub === "run") {
        if (runningDaemon(paths)) die(t("Daemon running · pid {0} · port {1}", runningDaemon(paths)!.pid, runningDaemon(paths)!.port));
        const { DaemonStore } = await import("./daemon/store");
        const { Daemon } = await import("./daemon/server");
        const { runRoutine } = await import("./daemon/runner");
        process.umask(0o077); // every file the daemon creates (db, WAL, logs) is owner-only
        const token = ensureToken(paths);
        const store = new DaemonStore(paths.db);
        // Due routines call their agent's model with the local BYOK key (never logged or stored).
        const keys = makeKeyStore();
        const { ChatService } = await import("./daemon/chat");
        const { CompanyMemory } = await import("./daemon/memory");
        const vectors = await import("./daemon/vectors");
        // Plan 4.3: meaning search only when the user named an embedding model (memory-settings.json).
        const memory = new CompanyMemory(`${CONFIG_DIR}/memory`, store, {
          embedder: () => {
            const s = vectors.loadVectorSettings(`${CONFIG_DIR}/memory-settings.json`);
            return s.embedModel ? vectors.ollamaEmbedder(s.embedModel, { host: s.ollamaHost }) : null;
          },
        });
        const { SkillRegistry } = await import("./daemon/skills");
        const skills = new SkillRegistry(`${CONFIG_DIR}/skills`, `${CONFIG_DIR}/skills.json`);
        const browse = await import("./daemon/browse");
        const policyFile = `${CONFIG_DIR}/browser.json`;
        const browser = {
          policy: () => browse.loadPolicy(policyFile),
          setPolicy: (p: { allow: string[]; deny: string[] }) => browse.savePolicy(policyFile, p),
          read: (url: string) => browse.readPage(url, browse.loadPolicy(policyFile)),
        };
        let daemon: InstanceType<typeof Daemon> | undefined;
        const chat = new ChatService(store, { keys, keyProviders: () => keys.list().map(e => e.provider), memory, skills },
          conversationId => daemon?.emit({ type: "conversation.changed", conversationId }));
        // Findings reach the user as a macOS notification (osascript, argv only — no shell) and over the relay.
        let relayAudit: ((text: string) => void) | undefined;
        const notify = (title: string, body: string) => {
          if (process.platform === "darwin") {
            const q = (v: string) => `"${v.slice(0, 240).replace(/[\\"]/g, m => `\\${m}`)}"`;
            void import("node:child_process").then(cp => cp.execFile("osascript", ["-e", `display notification ${q(body)} with title ${q(title)}`], () => {}));
          }
          relayAudit?.(`${title}: ${body}`);
        };
        const { runTask } = await import("./daemon/tasks");
        const { loadPriceOverrides } = await import("./daemon/pricing");
        store.priceOverrides = loadPriceOverrides(`${CONFIG_DIR}/prices.json`);
                // Plan 3.1: CLI employees (the user's own Claude Code / Codex / Gemini CLI over ACP) and their approval queue.
        const { ApprovalCenter } = await import("./daemon/workers");
        const { loadAdapters } = await import("./daemon/acp");
        const approvals = new ApprovalCenter(store, { notify, onRequest: (approvalId, companyId) => daemon?.emit({ type: "approval.requested", approvalId, companyId }) });
        const worker = {
          keys, notify, memory, approvals, adapters: loadAdapters(`${CONFIG_DIR}/adapters.json`),
          context: (agent: { id: string }) => [memory.snapshot(agent.id), skills.promptFor(store.agentSkills(agent.id))].filter(Boolean).join("\n\n"),
          onEvent: (taskId: string, e: { kind: string }) => daemon?.emit({ type: "task.event", taskId, kind: e.kind }),
        };
        // Plan 4.5: goals run through the manager's ledger; steps go through the same task runner.
        const { runGoal } = await import("./daemon/ledger");
        const runTaskNow = (taskId: string) => runTask(store, taskId, { keys, notify, memory, skills, browser, worker });
        const goals = (goalId: string) => runGoal(store, goalId, {
          keys, memory, notify, runTask: runTaskNow, skills: id => store.agentSkills(id),
          onChange: id => { const g = store.getGoal(id); if (g) daemon?.emit({ type: "goal.changed", goalId: id, companyId: g.company_id }); },
        });
        // Plan 5.4: rss / web-change / folder triggers open tasks (staggered polls, folder watches).
        const { TriggerEngine } = await import("./daemon/triggers");
        // GitHub triggers: the user's token and each webhook secret live in the keychain (`braavo github login`).
        const gh = await import("./daemon/github");
        const ghFetch = fetch as unknown as import("./daemon/github").FetchLike;
        const github = {
          token: () => gh.currentToken(() => keys.get(gh.GITHUB_TOKEN_KEY), auth => keys.add(gh.GITHUB_TOKEN_KEY, JSON.stringify(auth)), gh.githubClientId(), ghFetch),
          secret: (id: string) => keys.get(gh.webhookSecretKey(id)),
          saveSecret: (id: string, secret: string) => keys.add(gh.webhookSecretKey(id), secret),
          removeSecret: (id: string) => keys.remove(gh.webhookSecretKey(id)),
          fetch: ghFetch,
        };
        // Slack triggers: the user's own Slack app over Socket Mode; tokens in the keychain (`braavo slack connect`).
        const sl = await import("./daemon/slack");
        let slackSocket: import("./daemon/slack").SlackSocket | undefined;
        const slack = {
          start: () => {
            slackSocket ??= new sl.SlackSocket({ appToken: () => keys.get(sl.SLACK_APP_KEY), fetch: ghFetch, log: line => console.error(line) }, m => { triggers.onSlack(m); });
            slackSocket.start();
          },
          stop: () => { slackSocket?.stop(); slackSocket = undefined; },
          status: () => (slackSocket ? `${slackSocket.status}${slackSocket.note ? ` (${slackSocket.note})` : ""}` : "off"),
        };
        const triggers = new TriggerEngine(store, { policy: browser.policy, notify, github, slack, onTask: (taskId, companyId) => daemon?.emit({ type: "task.changed", taskId, companyId }) });
        // A Slack-triggered task's answer goes back to its thread only after the user approves it.
        const replyToSlack = (taskId: string) => sl.replyAfterTask(taskId, {
          store, replyFor: id => triggers.slackReplyFor(id), ask: (agent, id, req) => approvals.ask(agent, id, req),
          botToken: () => keys.get(sl.SLACK_BOT_KEY), fetch: ghFetch, notify,
        });
        daemon = new Daemon({
          store, token, version, chat, memory, skills, browser, approvals, triggers, runGoal: goals,
          runRoutine: routineId => runRoutine(store, routineId, { keys, notify, memory, skills }),
          runTask: async taskId => {
            const result = await runTask(store, taskId, { keys, notify, memory, skills, browser, worker });
            void replyToSlack(taskId).catch(() => undefined);
            return result;
          },
        });
        const port = await daemon.listen(0);
        writeState(paths, { pid: process.pid, port, startedAt: new Date().toISOString(), version });
        // Plan 4.4: companies hired before consolidation existed get their nightly routine now.
        const { ensureConsolidationRoutine } = await import("./daemon/compaction");
        for (const company of store.listCompanies()) ensureConsolidationRoutine(store, company.id);
        triggers.start();
        daemon.startTicking();
        console.log(t("Daemon running · pid {0} · port {1}", process.pid, port));
        // Opt-in phone chat over the cloud relay (docs/DAEMON-CHAT.md §4); outbound connections only.
        let relayStop: (() => Promise<void>) | undefined;
        if (has(flags, "relay")) {
          requireAuth(cfg);
          const { RelayChat } = await import("./daemon/relay-chat");
          const { hostname } = await import("node:os");
          const { companyCommand } = await import("./daemon/company");
          const relayChat = new RelayChat(chat, store, {
            defaultModel: async () => {
              const mid = (await chat.models()).suggestions.mid;
              return mid.status === "ok" ? { provider: mid.provider, model: mid.model } : undefined;
            },
            company: (command, arg) => companyCommand(store, command, arg, {
              run: routineId => daemon!.runNow(routineId), canUse: p => chat.canUse(p), memoryRoot: `${CONFIG_DIR}/memory`,
            }),
          });
          const { createRelayTransport } = await import("./forge/relay-transport");
          const { RelayBridge } = await import("./forge/relay-bridge");
          const bridge = new RelayBridge(createRelayTransport({ cfg }), relayChat.handlers());
          relayChat.attach(bridge);
          relayAudit = text => { void bridge.emitAudit(text.slice(0, 4000)); };
          // Opt-in panel snapshot for the phone: on start and after company changes, at most every 10 s.
          const { panel, panelSnapshot } = await import("./daemon/company");
          let snapshotTimer: NodeJS.Timeout | undefined;
          const pushSnapshot = () => {
            if (snapshotTimer) return;
            snapshotTimer = setTimeout(() => {
              snapshotTimer = undefined;
              const company = store.listCompanies()[0];
              if (company) void bridge.emitPanelSnapshot(panelSnapshot(panel(store, company.id)));
            }, 10_000);
            snapshotTimer.unref?.();
          };
          daemon.onEvent(ev => { if (ev.type === "company.changed" || ev.type === "agent.status" || ev.type === "routine.executed") pushSnapshot(); });
          pushSnapshot();
          const label = `Braavo chat · ${hostname().replace(/\.local$/, "").slice(0, 60)}`;
          let stopped = false; let retry: NodeJS.Timeout | undefined;
          const connect = async (delayS: number): Promise<void> => {
            try { await bridge.start({ surface: "cli", label }); console.log(t("Relay chat on · {0}", label)); }
            catch {
              if (stopped) return;
              console.error(t("Relay unavailable; retrying in {0}s", delayS));
              retry = setTimeout(() => { void connect(Math.min(delayS * 2, 300)); }, delayS * 1000);
            }
          };
          void connect(30);
          relayStop = async () => { stopped = true; if (retry) clearTimeout(retry); await bridge.stop(); };
        }
        await new Promise<void>(resolve => {
          const stop = () => resolve();
          process.once("SIGTERM", stop); process.once("SIGINT", stop);
        });
        await relayStop?.();
        await daemon.close(); store.close(); clearState(paths);
        return;
      }
      if (sub === "start") {
        const live = runningDaemon(paths);
        if (live) { emit(flags, live, () => t("Daemon running · pid {0} · port {1}", live.pid, live.port)); return; }
        const { openSync, mkdirSync } = await import("node:fs");
        const { spawn } = await import("node:child_process");
        mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
        const log = openSync(paths.log, "a", 0o600);
        const child = spawn(process.execPath, [process.argv[1], "daemon", "run", ...(has(flags, "relay") ? ["--relay"] : [])], { detached: true, stdio: ["ignore", log, log] });
        child.unref();
        // Up to 15 s: a loaded machine can take several seconds to boot node and open SQLite.
        for (let i = 0; i < 150; i++) {
          const state = runningDaemon(paths);
          if (state) { emit(flags, state, () => t("Daemon running · pid {0} · port {1}", state.pid, state.port)); return; }
          await new Promise(r => setTimeout(r, 100));
        }
        die(t("Daemon did not start; see {0}", paths.log));
      }
      if (sub === "stop") {
        const live = runningDaemon(paths);
        if (!live) { emit(flags, { running: false }, () => t("Daemon is not running.")); return; }
        process.kill(live.pid, "SIGTERM");
        for (let i = 0; i < 50 && runningDaemon(paths); i++) await new Promise(r => setTimeout(r, 100));
        emit(flags, { running: false, pid: live.pid }, () => t("Daemon stopped."));
        return;
      }
      if (sub === "status") {
        const live = runningDaemon(paths);
        if (!live) { emit(flags, { running: false }, () => t("Daemon is not running.")); process.exitCode = EXIT.GENERAL; return; }
        let health: unknown = null;
        try {
          const res = await fetch(`http://127.0.0.1:${live.port}/v1/health`, { headers: { Authorization: `Bearer ${ensureToken(paths)}` }, signal: AbortSignal.timeout(3000) });
          health = await res.json();
        } catch { /* reported as unhealthy below */ }
        emit(flags, { running: true, ...live, health }, () => `${t("Daemon running · pid {0} · port {1}", live.pid, live.port)}${health ? "" : " · !"}`);
        return;
      }
      if (sub === "install" || sub === "uninstall") {
        // macOS LaunchAgent: start at login, restart after a crash. Other platforms run `daemon run` under their own service manager.
        if (process.platform !== "darwin") die(t("Daemon install is macOS-only for now; run `braavo daemon run` under your service manager."));
        const launchd = await import("./daemon/launchd");
        if (sub === "uninstall") {
          const removed = launchd.uninstall();
          emit(flags, { removed }, () => (removed ? t("Daemon LaunchAgent removed.") : t("Daemon LaunchAgent is not installed.")));
          return;
        }
        const { realpathSync } = await import("node:fs");
        const target = { node: launchd.stableNodePath(process.execPath), script: realpathSync(process.argv[1]), log: paths.log, relay: has(flags, "relay") };
        if (has(flags, "dry-run")) {
          const plan = launchd.planInstall(target);
          emit(flags, plan, () => `${plan.path}\n\n${plan.plist}`);
          return;
        }
        // A second `daemon run` would exit non-zero and launchd would keep restarting it.
        if (runningDaemon(paths)) die(t("Stop the running daemon first: braavo daemon stop"));
        const { plist: _plist, ...plan } = launchd.install(target);
        emit(flags, plan, () => t("Daemon LaunchAgent installed: {0}", plan.path));
        return;
      }
      usage("usage: braavo daemon run [--relay] | start [--relay] | stop | status | install [--relay] [--dry-run] | uninstall [--json]");
      return;
    }

    case "approve": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo approve <approvalId> [--deny] [--yes]");
      const decision = has(flags, "deny") ? "REJECTED" : "APPROVED";
      requireConfirmation(flags, getLocale() === "en" ? `${decision === "REJECTED" ? "deny" : "approve"} approval ${id}` : t(decision === "REJECTED" ? "reject action {0}" : "approve action {0}", id));
      const d = await apiFetch(`/approvals/${id}/decide`, {
        method: "POST",
        body: { decision, reason: flag(flags, "reason") ?? "via braavo cli" },
        cfg,
      });
      let outcome;
      try { outcome = parseApprovalDecision(d, decision); }
      catch (error) { throw new ApiError(502, (error as Error).message); }
      emit(flags, { id, decision, result: d }, () => outcome.claimFailed
        ? `${statusText("APPROVED")}  ${id} — ${t("approval recorded; handoff incomplete")}: ${outcome.error ?? "?"}. ${t("Check the run.")}`
        : `${statusText(decision)}  ${id}`);
      if (outcome.claimFailed) process.exitCode = EXIT.API;
      return;
    }

    case "pause": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo pause <runId> [--yes]");
      requireConfirmation(flags, t("pause run {0}", id));
      const d = await apiFetch(`/runs/${id}/pause`, { method: "POST", body: {}, cfg });
      emit(flags, { id, action: "pause", result: d }, () => t("Paused {0}", id));
      return;
    }

    case "stop": {
      requireAuth(cfg);
      const id = positionals[0];
      if (!id) usage("usage: braavo stop <runId> [--yes]");
      requireConfirmation(flags, t("stop run {0}", id));
      const d = await apiFetch(`/runs/${encodeURIComponent(id)}/stop`, { method: "POST", body: {}, cfg });
      if (d?.success !== true || d.status !== "CANCELLED") {
        throw new ApiError(502, t("Invalid stop response; inspect the run before retrying."));
      }
      emit(flags, { id, action: "stop", result: d }, () => t("Stopped {0}", id));
      return;
    }

    case "cost": {
      requireAuth(cfg);
      const days = flag(flags, "days") ?? "30";
      const [usage, savings] = await Promise.all([
        apiFetch("/billing/usage", { cfg }),
        apiFetch(`/billing/savings?days=${encodeURIComponent(days)}`, { cfg, raw: true }),
      ]);
      const data = { usage, savings: savings?.body ?? null, days: Number(days) };
      emit(flags, data, () => {
        const lines = [t("Usage ({0})", dayText(days))];
        for (const [k, v] of Object.entries(usage ?? {})) {
          if (typeof v === "object") continue;
          lines.push(`  ${k.padEnd(24)} ${typeof v === "number" ? numberText(v) : String(v)}`);
        }
        return lines.join("\n");
      });
      return;
    }

    case "policy": {
      requireAuth(cfg);
      const sub = positionals[0];
      if (sub !== "test") usage("usage: braavo policy test [--json]");
      // "policy test" = show the governance config and current risk posture the
      // engine would apply. Read-only by construction: it must be safe to run
      // against production while deciding whether an action is allowed.
      const [config, risks] = await Promise.all([
        apiFetch("/governance/config", { cfg }),
        apiFetch("/governance/risks", { cfg, raw: true }),
      ]);
      emit(flags, { config, risks: risks?.body ?? null }, () =>
        `${t("Governance config:")}\n${JSON.stringify(config, null, 2)}`,
      );
      return;
    }

    case "audit": {
      requireAuth(cfg);
      const sub = positionals[0];
      if (sub !== "verify") usage("usage: braavo audit verify [--run <runId>] [--json]");
      const runId = flag(flags, "run");
      const path = runId ? `/runs/${runId}` : "/dashboard/activity";
      const d = await apiFetch(path, { cfg });
      const anchorCount = flag(flags, "anchor-count");
      const anchorGenesis = flag(flags, "anchor-genesis");
      const anchorHead = flag(flags, "anchor-head");
      const anchorParts = [anchorCount, anchorGenesis, anchorHead];
      if (anchorParts.some(Boolean) && !anchorParts.every(Boolean)) {
        usage(t("audit anchors are all-or-none: --anchor-count, --anchor-genesis, and --anchor-head"));
      }
      const parsedCount = anchorCount === undefined ? undefined : Number(anchorCount);
      if (parsedCount !== undefined && (!Number.isSafeInteger(parsedCount) || parsedCount < 1)) {
        usage(t("--anchor-count must be a positive integer"));
      }
      const anchor = parsedCount === undefined ? undefined : {
        count: parsedCount,
        genesisHash: anchorGenesis!,
        headHash: anchorHead!,
      };
      const result = verifyEvidenceChain(d, anchor);
      emit(flags, result, () =>
        result.ok
          ? t("Evidence chain OK (verified records: {0})", numberText(result.checked))
          : `${t("Evidence chain FAILED")}${result.brokenAt ? ` ${result.brokenAt}` : ""}: ${humanChainReason(result)}`,
      );
      if (!result.ok) process.exitCode = EXIT.VERIFICATION_FAILED;
      return;
    }

    case "connect": {
      requireAuth(cfg);
      const d = await apiFetch("/external-connections", { cfg });
      const list: any[] = Array.isArray(d) ? d : [];
      emit(flags, { connections: list }, () =>
        list.length
          ? list.map((c) => `${statusText(c.status).padEnd(8)}  ${String(c.platform ?? "").padEnd(7)}  ${c.label}  ${c.baseUrl}`).join("\n")
          : t("No connections."),
      );
      return;
    }

    case "agent": {
      requireAuth(cfg);
      const company = flag(flags, "company") ?? cfg.defaultCompany;
      if (!company) usage("usage: braavo agent --company <id>  (or set one with: braavo use <id>)");
      const d = await apiFetch(`/companies/${company}`, { cfg });
      const agents: any[] = d.agents ?? [];
      emit(flags, { companyId: company, agents }, () =>
        agents.length
          ? agents.map((a) => `${statusText(a.status).padEnd(10)}  ${a.role ?? ""}  ${a.name ?? a.id}`).join("\n")
          : t("No agents in this company."),
      );
      return;
    }

    case "session": {
      requireAuth(cfg);
      const d = await apiFetch("/relay/sessions", { cfg });
      const list: any[] = Array.isArray(d) ? d : (d?.sessions ?? []);
      emit(flags, { sessions: list }, () =>
        list.length
          ? list.map((x: any) => `${statusText(x.state ?? x.status).padEnd(10)}  ${x.id}  ${x.deviceId ?? ""}`).join("\n")
          : t("No active sessions."),
      );
      return;
    }

    default: {
      console.log(HELP(ui));
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(EXIT.USAGE);
    }
  }
}

// Only run when invoked as the bin — importing this module (tests) is side-effect-free.
if (require.main === module) {
  main().catch((e) => {
    const ui = makeUi();
    console.error(ui.fail(e instanceof ApiError ? `API ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e)));
    // Documented exit codes (forge/exit-codes.ts) — a non-interactive caller
    // branches on these, so "1 for everything" is not a contract.
    if (e instanceof CommandInterruptedError) process.exit(EXIT.INTERRUPTED);
    if (e instanceof ConfirmationRequiredError) process.exit(e.exitCode);
    if (e instanceof UntrustedHostError) process.exit(EXIT.UNTRUSTED_HOST);
    if (e instanceof ApiError) process.exit(e.status === 401 ? EXIT.AUTH : e.status === 404 ? EXIT.NOT_FOUND : EXIT.API);
    process.exit(EXIT.GENERAL);
  });
}

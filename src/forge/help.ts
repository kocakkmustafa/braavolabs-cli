import { t, getLocale, LOCALES } from "./locale";
import type { Ui } from "./ui";
import { wrapTerminalText } from "./terminal-text";
/** Command tokens and option syntax stay stable in every language. */
export const COMMAND_HELP = [
["login", "braavo login [--api <url>] [--token <jwt> | --email <e> --password <p>]", "Sign in"],
["logout", "braavo logout", "Sign out"],
["use", "braavo use <companyId>", "Choose the default company"],
["ask", "braavo ask <question> [--company <id>] [--models PROVIDER/model,...] [--reasoning-effort low|medium|high] [--repo]", "Compare model answers"],
["cancel", "braavo cancel <researchId> --yes [--json]", "Cancel a research session"],
["cascade", "braavo cascade <question> [--threshold <0-1>] [--second-opinion] [--budget <usd>]", "Try models from lowest cost upward"],
["savings", "braavo savings [--days <1-90>]", "Show measured routing savings"],
["keys", "braavo keys add <provider> [--key <secret>] | list | rm <provider>", "Manage local BYOK keys"],
["media-key", "braavo media-key add <provider> <secret> | list | rm <provider>", "Manage server-side media keys"],
["image", "braavo image <prompt> [--model <id>] [--n <1-4>] [--size <WxH>] [--yes]", "Preview or generate an image"],
["voice", "braavo voice <text> [--provider <id>] [--voice <name>] [--out <path>] [--yes]", "Preview or generate speech"],
["local", "braavo local <question> [--model <name>] [--host <url>] [--repo]", "Ask an Ollama endpoint"],
["direct", "braavo direct <provider> <question> [--model <name>] [--repo]", "Ask a provider with your local key"],
["setup", "braavo setup [--host <url>] [--json]", "Check the daemon, your keys and local models"],
["models", "braavo models [--host <url>] | pull <name>", "List installed models and key providers"],
["skills", "braavo skills [list] | show <name> | add-dir <path> | rm-dir <path> [--json]", "List SKILL.md skills you can give agents"],
["spawn", "braavo spawn <claude|codex> [args...] [--dir <path>] [--quiet] [--bridge] | --list", "Run your own authenticated vendor CLI"],
["fix", "braavo fix --cmd <test-command> [--via local|direct|ask] [--provider <p>] [--repo]", "Run a test command and suggest a fix"],
["mcp", "braavo mcp add <name> -- <command> [args...] | list | rm <name> | tools <name> | call <name> <tool> [--json <args>] | serve", "Manage and call local MCP servers"],
["whoami", "braavo whoami", "Show the current account"],
["runs", "braavo runs", "List recent runs"],
["run", "braavo run <pipelineId> --yes [--json]", "Start a pipeline run"],
["steer", "braavo steer <runId> <message...>", "Send guidance to a running agent"],
["handoffs", "braavo handoffs [--open]", "List provider handoffs"],
["handoff", "braavo handoff <runId> [--reason <text>]", "Open a provider handoff"],
["continue", "braavo continue <runId> --provider <P> [--model <m>] [--base-url <u>]", "Continue a checkpoint with a provider"],
["connections", "braavo connections", "List external connections"],
["doctor", "braavo doctor [--json]", "Check configuration and API health"],
["init", "braavo init [--api <url>] [--json]", "Write the API configuration"],
["watch", "braavo watch <runId> [--json]", "Watch a run until completion or local timeout"],
["monitor", "braavo monitor add <url> [--every 6h] [--notify price,plans,promo,release,text] [--label <text>] | list | rm <id> | check [<id>] [--due] [--summarize] | log <id>", "Watch web pages for changes; a model runs only when something changed"],
["code", "braavo code <task> [--dir <path>] [--model PROVIDER/model] [--plan] [--yes] [--allow-web <domains>] [--review-model P/m] [--project-hooks] [--shell] | undo", "Edit code with your own model: plan, diff, undo"],
["company", "braavo company init <name> [--templates all|id,...] [--watch <urls>|@file] | show | tui | memory | hire | set <agent> [--model PROVIDER/model] [--effort <e>] [--pause|--resume] | watch <name> --urls <urls>|@file | run <routine> | findings | prices", "Run your local company: agents, panel and watch routines"],
["chat", "braavo chat [<message>] [--model PROVIDER/model] [--effort low|medium|high] [--continue <id>|last] | list | show <id> | search <text> | export <id> [--format md|json] [--out <file>]", "Chat through the local daemon"],
["daemon", "braavo daemon run [--relay] | start [--relay] | stop | status | install [--relay] [--dry-run] | uninstall [--json]", "Run the local daemon: agents, schedules and the local API"],
["approve", "braavo approve <approvalId> [--deny] [--reason <text>] --yes [--json]", "Approve or reject a pending action"],
["pause", "braavo pause <runId> --yes [--json]", "Pause a run"],
["stop", "braavo stop <runId> --yes [--json]", "Stop a run"],
["cost", "braavo cost [--days <n>] [--json]", "Show usage and costs"],
["policy", "braavo policy test [--json]", "Show governance settings and risks"],
["audit", "braavo audit verify [--run <runId>] --anchor-count <n> --anchor-genesis <sha256> --anchor-head <sha256> [--json]", "Verify an evidence chain against anchors"],
["connect", "braavo connect [--json]", "List external connections"],
["agent", "braavo agent --company <id> [--json]", "List company agents"],
["session", "braavo session [--json]", "List active relay sessions"],
] as const;
export function renderHelp(ui: Ui, command?: string, width = process.stdout.isTTY ? process.stdout.columns : undefined): string {
  const commands = command ? COMMAND_HELP.filter(([name]) => name === command) : COMMAND_HELP;
  const lines = [ui.bold("> braavo"), t("Language: {0}", getLocale()), "", ui.primary(t("Commands"))];
  const prose = (text: string) => width ? wrapTerminalText(text, width) : text;
  for (const [_name, usage, description] of commands) {
    const text = width ? wrapTerminalText(t(description), Math.max(4, width - 2)) : t(description);
    lines.push(ui.primary(usage), text.split("\n").map(line => `  ${line}`).join("\n"));
  }
  lines.push("", ui.primary(t("Options")), `--lang <${LOCALES.join("|")}> · BRAAVO_LOCALE`, "--help · --version · --json · NO_COLOR · BRAAVO_REDUCED_MOTION", "BRAAVO_THEME=light|dark|system · COLORFGBG", "",
    t("Commands that require confirmation accept only a bare --yes; --approval is not supported. Exit 4 means refused."),
    t("Local BYOK keys and server-side media keys are separate. Provider usage is billed separately."),
    t("Local waiting has a deadline. Remote work may continue after cancellation or timeout."),
    t("Only suggestion text is printed; fix never applies a patch."),
    t("Choose light, dark or system with BRAAVO_THEME. system uses known COLORFGBG metadata, otherwise the terminal foreground."),
    t("Terminal background is unchanged. NO_COLOR disables color and animation; BRAAVO_REDUCED_MOTION disables animation."),
    t("JSON, exit codes, command names and provider content are not translated."));
  return lines.map(line => line.startsWith("\x1b") || line.startsWith("braavo ") || line.startsWith("--") || line.startsWith("  ") ? line : prose(line)).join("\n");
}

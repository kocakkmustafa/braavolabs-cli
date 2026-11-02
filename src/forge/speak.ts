/**
 * Read answers aloud in the terminal (plan 5.9, CLI) with the operating system's own
 * speech: `say` on macOS, Speech Dispatcher or eSpeak on Linux, System.Speech on Windows.
 * No audio service, key or model; the text goes to the local program on stdin (never as
 * an argument, never through a shell). For dictation the terminal already has the OS
 * dictation (macOS: press Fn twice) — a command-line program cannot ask for speech
 * recognition permission itself.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface SpeechCommand { cmd: string; args: string[] }

const PS_SPEAK = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())";

/** The first speech program this system has, or null. `exists` is injectable for tests. */
export function speechCommand(platform: NodeJS.Platform = process.platform, exists: (cmd: string) => boolean = onPath): SpeechCommand | null {
  if (platform === "darwin") return exists("say") ? { cmd: "say", args: ["-f", "-"] } : null;
  if (platform === "win32") return exists("powershell") ? { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", PS_SPEAK] } : null;
  for (const c of [{ cmd: "spd-say", args: ["-w", "-e"] }, { cmd: "espeak-ng", args: ["--stdin"] }, { cmd: "espeak", args: ["--stdin"] }]) if (exists(c.cmd)) return c;
  return null;
}

function onPath(cmd: string): boolean {
  const probe = process.platform === "win32" ? spawnSync("where", [cmd], { stdio: "ignore" }) : spawnSync("/bin/sh", ["-c", 'command -v "$1" >/dev/null', "sh", cmd], { stdio: "ignore" });
  return probe.status === 0;
}

/** Markdown and code read badly aloud: keep the words, drop the markup and fenced code. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~>|]+/g, " ")
    .split("\n").map(line => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n")
    .slice(0, 20_000);
}

export type Spawn = (cmd: string, args: string[]) => Pick<ChildProcess, "stdin" | "on" | "kill">;

/** Speak and resolve when done; `signal` stops it. Resolves false when there is nothing to speak with. */
export function speak(text: string, o: { command?: SpeechCommand | null; spawnImpl?: Spawn; signal?: AbortSignal } = {}): Promise<boolean> {
  const command = o.command === undefined ? speechCommand() : o.command;
  const words = speakable(text);
  if (!command || !words) return Promise.resolve(false);
  const child = (o.spawnImpl ?? ((cmd, args) => spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })))(command.cmd, command.args);
  return new Promise(resolve => {
    const stop = () => child.kill();
    o.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => { o.signal?.removeEventListener("abort", stop); resolve(false); });
    child.on("close", () => { o.signal?.removeEventListener("abort", stop); resolve(true); });
    child.stdin?.on("error", () => { /* the speaker quit early (stopped) */ });
    child.stdin?.end(words);
  });
}

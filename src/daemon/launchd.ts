import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * `braavo daemon install|uninstall` on macOS: a per-user LaunchAgent that keeps
 * `braavo daemon run` alive across logins (design §2, K4: agents run only on the
 * user's machine). No root, no system-wide daemon; the plist lives in
 * ~/Library/LaunchAgents and is loaded into the user's GUI domain so the login
 * keychain (BYOK keys) stays reachable.
 *
 * The plist carries no secrets and no environment: the daemon reads its token
 * and keys from ~/.braavo and the keychain itself. `exec`/fs are injected so
 * tests never touch the real launchctl.
 */

export const LAUNCHD_LABEL = "com.braavolabs.daemon";

export interface LaunchdDeps {
  home: string;
  uid: number;
  exec: (cmd: string, args: string[]) => void;
  writeFile: (path: string, data: string) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
}

function defaultDeps(): LaunchdDeps {
  return {
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    exec: (cmd, args) => { execFileSync(cmd, args, { stdio: "ignore" }); },
    writeFile: (path, data) => writeFileSync(path, data, { mode: 0o644 }),
    removeFile: path => rmSync(path, { force: true }),
    exists: existsSync,
    mkdir: path => mkdirSync(path, { recursive: true }),
  };
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** The LaunchAgent: run in the foreground, restart only after a crash, log to the daemon log. */
export function renderPlist(o: { node: string; script: string; log: string }): string {
  const args = [o.node, o.script, "daemon", "run"].map(a => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

/**
 * Homebrew's real node path carries the version (…/Cellar/node/26.9.0/bin/node) and
 * disappears on `brew upgrade`; its `<prefix>/bin/node` link survives upgrades.
 */
export function stableNodePath(execPath: string, exists: (path: string) => boolean = existsSync): string {
  const m = /^(.*)\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/.exec(execPath);
  return m && exists(`${m[1]}/bin/node`) ? `${m[1]}/bin/node` : execPath;
}

export interface InstallPlan { path: string; plist: string; label: string; domain: string }

export function planInstall(o: { node: string; script: string; log: string }, deps: Pick<LaunchdDeps, "home" | "uid"> = defaultDeps()): InstallPlan {
  return { path: plistPath(deps.home), plist: renderPlist(o), label: LAUNCHD_LABEL, domain: `gui/${deps.uid}` };
}

/** Write the plist and (re)load it. Re-running replaces an older install in place. */
export function install(o: { node: string; script: string; log: string }, partial: Partial<LaunchdDeps> = {}): InstallPlan {
  const deps = { ...defaultDeps(), ...partial };
  const plan = planInstall(o, deps);
  deps.mkdir(join(deps.home, "Library", "LaunchAgents"));
  if (deps.exists(plan.path)) {
    try { deps.exec("launchctl", ["bootout", `${plan.domain}/${plan.label}`]); } catch { /* not loaded */ }
  }
  deps.writeFile(plan.path, plan.plist);
  deps.exec("launchctl", ["bootstrap", plan.domain, plan.path]);
  return plan;
}

/** Unload and remove; returns false when nothing was installed. */
export function uninstall(partial: Partial<LaunchdDeps> = {}): boolean {
  const deps = { ...defaultDeps(), ...partial };
  const path = plistPath(deps.home);
  if (!deps.exists(path)) return false;
  try { deps.exec("launchctl", ["bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]); } catch { /* already unloaded */ }
  deps.removeFile(path);
  return true;
}

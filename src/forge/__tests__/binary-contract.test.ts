import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../exit-codes";

// Compile the actual entry point once, without requiring a stale dist/ or a
// preceding build in CI. Every child gets its own home and an entirely fake
// fetch implementation; no user's config, keychain or API is used.
let buildRoot: string;
let bin: string;
let preload: string;
const packageVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;

beforeAll(() => {
  buildRoot = mkdtempSync(join(tmpdir(), "braavo-binary-contract-"));
  bin = join(buildRoot, "dist", "braavo.js");
  preload = join(buildRoot, "isolated.cjs");
  copyFileSync(join(process.cwd(), "package.json"), join(buildRoot, "package.json"));
  symlinkSync(join(process.cwd(), "node_modules"), join(buildRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  const build = spawnSync(process.execPath, [
    require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json",
    "--outDir", join(buildRoot, "dist"),
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 30000 });
  expect(build.error, build.stderr).toBeUndefined();
  expect(build.status, build.stdout + build.stderr).toBe(0);
  writeFileSync(preload, `
const os = require("node:os");
const fs = require("node:fs");
os.homedir = () => process.env.BRAAVO_TEST_HOME;
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(process.env.BRAAVO_TEST_CALLS, JSON.stringify({
    origin: new URL(String(url)).origin, redirect: init.redirect,
    ...(process.env.BRAAVO_TEST_CAPTURE_REQUEST ? {
      path: new URL(String(url)).pathname, method: init.method,
      body: JSON.parse(init.body), authorization: init.headers.Authorization,
    } : {}),
  }) + "\\n");
  const status = Number(process.env.BRAAVO_TEST_STATUS || 200);
  const body = status === 200
    ? { token: "synthetic-access", user: { email: "fixture@example.invalid" } }
    : { error: "fixture error" };
  return new Response(JSON.stringify(body), { status });
};
`);
}, 40000);

afterAll(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

function fixture(config?: Record<string, unknown>) {
  const home = mkdtempSync(join(buildRoot, "home-"));
  const configPath = join(home, ".braavo", "config.json");
  const callsPath = join(home, "calls.jsonl");
  if (config) {
    mkdirSync(join(home, ".braavo"), { mode: 0o700 });
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  }
  return {
    config: () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : undefined,
    calls: () => existsSync(callsPath)
      ? readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [],
    run: (args: string[], env: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, ["--require", preload, bin, ...args], {
        cwd: home, encoding: "utf8", timeout: 10000,
        env: {
          PATH: process.env.PATH, LANG: "C", TERM: "dumb", NO_COLOR: "1",
          BRAAVO_TEST_HOME: home, BRAAVO_TEST_CALLS: callsPath, ...env,
        },
      });
      expect(result.error).toBeUndefined();
      return result;
    },
  };
}

const authenticated = { apiUrl: "https://braavolabs.com/api/v1", token: "synthetic-access" };
const loginArgs = ["login", "--email", "fixture@example.invalid", "--password", "synthetic-password"];

describe("compiled CLI version and exit contract", () => {
  for (const alias of ["--version", "-v"]) {
    it(`${alias} prints package version without config or API side effects`, () => {
      const f = fixture();
      const r = f.run([alias, "--api", "https://unused.example.invalid/api/v1"]);
      expect(r.status).toBe(EXIT.OK);
      expect(r.stdout).toBe(`${packageVersion}\n`);
      expect(r.stderr).toBe("");
      expect(f.config()).toBeUndefined();
      expect(f.calls()).toEqual([]);
    });
  }

  it("missing local authentication returns AUTH before any request", () => {
    const f = fixture();
    const r = f.run(["runs"]);
    expect(r.status).toBe(EXIT.AUTH);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not logged in");
    expect(f.calls()).toEqual([]);
  });

  for (const args of [
    ["unknown-contract-command"], ["local"], ["direct"], ["direct", "unknown", "question"],
    ["cascade"], ["ask"], ["run"], ["steer"], ["watch"], ["approve"], ["stop"],
    ["policy", "unknown"], ["mcp", "call"], ["image", "prompt", "--n", "0"],
    ["image", "prompt", "--size", "not-a-size"], ["fix"],
  ]) {
    it(`${args.join(" ")} rejects bad invocation as USAGE without a request`, () => {
      const f = fixture(authenticated);
      const r = f.run(args);
      expect(r.status).toBe(EXIT.USAGE);
      expect(f.calls()).toEqual([]);
    });
  }

  it("keeps confirmation refusal ahead of dispatch and JSON stdout clean", () => {
    const f = fixture(authenticated);
    const r = f.run(["stop", "synthetic-run", "--json"]);
    expect(r.status).toBe(EXIT.CONFIRMATION_REQUIRED);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--yes");
    expect(r.stderr).not.toContain("\u001b[");
    expect(f.calls()).toEqual([]);
  });

  it("doctor emits an actual parseable JSON document without ANSI or stderr", () => {
    const f = fixture();
    const r = f.run(["doctor", "--json"]);
    expect(JSON.parse(r.stdout).checks).toContainEqual({
      name: "api reachable", status: "ok", detail: "https://braavolabs.com/api/v1/health → 200",
    });
    expect(r.stdout).not.toContain("\u001b[");
    expect(r.stderr).toBe("");
  });

  for (const [status, exit] of [[401, EXIT.AUTH], [404, EXIT.NOT_FOUND], [503, EXIT.API]]) {
    it(`preserves API ${status} exit ${exit}`, () => {
      const f = fixture(authenticated);
      const r = f.run(["runs"], { BRAAVO_TEST_STATUS: String(status) });
      expect(r.status).toBe(exit);
      expect(f.calls()).toHaveLength(1);
    });
  }
});

describe("compiled CLI current-host opt-in", () => {
  it("trusts the saved HTTPS host on a bare flag and remembers that exact URL", () => {
    const apiUrl = "https://saved.example.invalid:8443/api/v1";
    const f = fixture({ apiUrl });
    const first = f.run([...loginArgs, "--allow-custom-host"]);
    expect(first.status).toBe(EXIT.OK);
    expect(first.stderr).toContain("https://saved.example.invalid:8443");
    expect(first.stderr).not.toContain("/api/v1");
    expect(f.config()).toMatchObject({ apiUrl, allowCustomHost: true });
    expect(f.run(loginArgs).status).toBe(EXIT.OK);
    expect(f.calls()).toEqual([
      { origin: "https://saved.example.invalid:8443", redirect: "manual" },
      { origin: "https://saved.example.invalid:8443", redirect: "manual" },
    ]);
  });

  it("accepts opt-in for the environment fallback when there is no saved URL", () => {
    const f = fixture();
    const apiUrl = "https://env.example.invalid/api/v1";
    const r = f.run([...loginArgs, "--allow-custom-host"], { BRAAVO_API_URL: apiUrl });
    expect(r.status).toBe(EXIT.OK);
    expect(f.config()).toMatchObject({ apiUrl, allowCustomHost: true });
    expect(f.calls()).toHaveLength(1);
  });

  it("preserves saved-config precedence and does not trust a different env host", () => {
    const f = fixture({ apiUrl: "https://saved.example.invalid/api/v1" });
    const r = f.run([...loginArgs, "--allow-custom-host"], {
      BRAAVO_API_URL: "https://different.example.invalid/api/v1",
    });
    expect(r.status).toBe(EXIT.OK);
    expect(f.calls()).toEqual([{ origin: "https://saved.example.invalid", redirect: "manual" }]);
  });

  it("clears earlier opt-in when --api selects another host without consent", () => {
    const f = fixture({ apiUrl: "https://old.example.invalid/api/v1", allowCustomHost: true });
    const r = f.run([...loginArgs, "--api", "https://new.example.invalid/api/v1"]);
    expect(r.status).toBe(EXIT.UNTRUSTED_HOST);
    expect(f.config().allowCustomHost).toBeUndefined();
    expect(f.calls()).toEqual([]);
  });

  it("never treats a string-valued flag as explicit consent", () => {
    const f = fixture({ apiUrl: "https://custom.example.invalid/api/v1" });
    expect(f.run([...loginArgs, "--allow-custom-host", "true"]).status).toBe(EXIT.UNTRUSTED_HOST);
    expect(f.calls()).toEqual([]);
  });

  it("refuses plaintext custom credentials without claiming they are allowed", () => {
    const f = fixture();
    const r = f.run([...loginArgs, "--api", "http://custom.example.invalid/api/v1", "--allow-custom-host"]);
    expect(r.status).toBe(EXIT.UNTRUSTED_HOST);
    expect(r.stderr).toContain("plaintext HTTP");
    expect(r.stderr).not.toContain("— allowed by");
    expect(f.calls()).toEqual([]);
  });

  it("continues to reject redirects after explicit custom-host consent", () => {
    const f = fixture({ apiUrl: "https://custom.example.invalid/api/v1" });
    const r = f.run([...loginArgs, "--allow-custom-host"], { BRAAVO_TEST_STATUS: "302" });
    expect(r.status).not.toBe(EXIT.OK);
    expect(r.stderr).toMatch(/redirect/i);
    expect(f.calls()).toEqual([{ origin: "https://custom.example.invalid", redirect: "manual" }]);
  });
});


describe("compiled CLI approval decision contract", () => {
  for (const deny of [false, true]) {
    const args = ["approve", "synthetic-approval", ...(deny ? ["--deny"] : [])];
    const decision = deny ? "REJECTED" : "APPROVED";

    it(`${decision} sends the exact authenticated decision payload`, () => {
      const f = fixture(authenticated);
      const r = f.run([...args, "--yes", "--json"], { BRAAVO_TEST_CAPTURE_REQUEST: "1" });
      expect(r.status).toBe(EXIT.OK);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toMatchObject({ id: "synthetic-approval", decision });
      expect(f.calls()).toEqual([{
        origin: "https://braavolabs.com", redirect: "manual",
        path: "/api/v1/approvals/synthetic-approval/decide", method: "POST",
        body: { decision, reason: "via braavo cli" }, authorization: "Bearer synthetic-access",
      }]);
    });

    it(`${decision} requires explicit confirmation before dispatch`, () => {
      const f = fixture(authenticated);
      const r = f.run([...args, "--json"]);
      expect(r.status).toBe(EXIT.CONFIRMATION_REQUIRED);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`${deny ? "deny" : "approve"} approval synthetic-approval`);
      expect(f.calls()).toEqual([]);
    });

    it(`${decision} requires authentication even with --yes`, () => {
      const f = fixture();
      const r = f.run([...args, "--yes", "--json"]);
      expect(r.status).toBe(EXIT.AUTH);
      expect(r.stdout).toBe("");
      expect(f.calls()).toEqual([]);
    });
  }

  it("preserves an explicit reason without introducing an INPUT answer note", () => {
    const f = fixture(authenticated);
    expect(f.run(["approve", "synthetic-approval", "--deny", "--yes", "--reason", "operator reason"],
      { BRAAVO_TEST_CAPTURE_REQUEST: "1" }).status).toBe(EXIT.OK);
    expect(f.calls()[0].body).toEqual({ decision: "REJECTED", reason: "operator reason" });
  });

  for (const status of [401, 403]) {
    it(`API ${status} refuses denial without emitting success`, () => {
      const f = fixture(authenticated);
      const r = f.run(["approve", "synthetic-approval", "--deny", "--yes", "--json"],
        { BRAAVO_TEST_STATUS: String(status) });
      expect(r.status).not.toBe(EXIT.OK);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("fixture error");
      expect(f.calls()).toHaveLength(1);
    });
  }
});


for (const confirmation of [["--yes", "true"], ["--yes", "--approval", "unverified"]]) {
  it(`denial rejects unverified confirmation ${confirmation.join(" ")}`, () => {
    const f = fixture(authenticated);
    const r = f.run(["approve", "synthetic-approval", "--deny", "--json", ...confirmation]);
    expect(r.status).toBe(EXIT.CONFIRMATION_REQUIRED);
    expect(r.stdout).toBe("");
    expect(f.calls()).toEqual([]);
  });
}

it("human denial output uses the accepted rejection label", () => {
  const f = fixture(authenticated);
  const r = f.run(["approve", "synthetic-approval", "--deny", "--yes"]);
  expect(r.status).toBe(EXIT.OK);
  expect(r.stdout).toBe("REJECTED  synthetic-approval\n");
});

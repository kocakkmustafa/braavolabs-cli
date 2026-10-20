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
      body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers.Authorization,
    } : {}),
  }) + "\\n");
  let status = Number(process.env.BRAAVO_TEST_STATUS || 200);
  if (process.env.BRAAVO_TEST_OLD_COMPARE) {
    // Accepted old platform selector shape: real Zod strict nested object.
    const { z } = require("zod");
    const oldCompare = z.object({ selections: z.array(z.object({
      provider: z.string().min(1), model: z.string().min(1),
    }).strict()).min(1).max(3).optional(), companyId: z.string(), query: z.string() });
    status = oldCompare.safeParse(JSON.parse(init.body)).success ? 200 : 400;
  }
  const body = status === 200
    ? (process.env.BRAAVO_TEST_RESPONSE ? JSON.parse(process.env.BRAAVO_TEST_RESPONSE)
      : new URL(String(url)).pathname.includes("/approvals/")
        ? { success: true, decision: JSON.parse(init.body).decision }
        : { token: "synthetic-access", user: { email: "fixture@example.invalid" } })
    : (process.env.BRAAVO_TEST_RESPONSE ? JSON.parse(process.env.BRAAVO_TEST_RESPONSE) : { error: "fixture error" });
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

describe("compiled CLI relay and handoff failures", () => {
  it.each([[401, EXIT.AUTH], [404, EXIT.NOT_FOUND], [503, EXIT.API]])("session HTTP %s preserves exit %s and emits no empty-success JSON", (status, exit) => {
    const f = fixture(authenticated); const result = f.run(["session", "--json"], { BRAAVO_TEST_STATUS: String(status) });
    expect(result.status).toBe(exit); expect(result.stdout).toBe(""); expect(result.stderr).toContain("fixture error");
    expect(f.calls()).toHaveLength(1);
  });

  it.each([[401, EXIT.AUTH], [404, EXIT.NOT_FOUND], [409, EXIT.API], [503, EXIT.API]])("continue HTTP %s preserves exit %s without replay", (status, exit) => {
    const f = fixture(authenticated); const result = f.run(["continue", "run", "--provider", "OPENAI", "--yes"], { BRAAVO_TEST_STATUS: String(status) });
    expect(result.status).toBe(exit); expect(result.stdout).not.toContain("Checkpoint still freezing");
    expect(result.stderr).toContain("fixture error"); expect(f.calls()).toHaveLength(1);
  });

  it("cancelled compare returns an API failure instead of successful synthesis", () => {
    const f = fixture(authenticated); const result = f.run(["ask", "question", "--company", "company"], {
      BRAAVO_TEST_RESPONSE: JSON.stringify({ id: "session", status: "CANCELLED", findings: {} }),
    });
    expect(result.status).toBe(EXIT.API); expect(result.stderr).toContain("Compare cancelled");
    expect(result.stdout).not.toContain("synthesis"); expect(f.calls()).toHaveLength(2);
  });
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

  for (const deny of [false, true]) {
    for (const reason of ["  operator rationale ✓  ", ""]) {
      it(`preserves ${deny ? "rejected" : "approved"} reason ${JSON.stringify(reason)} without an INPUT answer note`, () => {
        const f = fixture(authenticated);
        expect(f.run(["approve", "synthetic-approval", ...(deny ? ["--deny"] : []), "--yes", "--reason", reason],
          { BRAAVO_TEST_CAPTURE_REQUEST: "1" }).status).toBe(EXIT.OK);
        expect(f.calls()[0].body).toEqual({ decision: deny ? "REJECTED" : "APPROVED", reason });
      });
    }
  }

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


describe("compiled explicit models contract", () => {
  it.each(["low", "medium", "high"])("forwards %s in the actual binary and fails closed against the old strict selector contract", effort => {
    const f = fixture({...authenticated, defaultCompany: "synthetic-company"});
    const result = f.run(["ask", "Question for models", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort", effort],
      {BRAAVO_TEST_OLD_COMPARE: "1", BRAAVO_TEST_CAPTURE_REQUEST: "1"});
    expect(result.status).toBe(EXIT.API); expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]).toMatchObject({path: "/api/v1/research/compare/selected", method: "POST",
      body: {selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: effort}]}});
  });
  it("the actual binary posts nested effort and completes polling without losing it", () => {
    const f = fixture({...authenticated, defaultCompany: "synthetic-company"});
    const result = f.run(["ask", "Question for models", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort", "low"],
      {BRAAVO_TEST_CAPTURE_REQUEST: "1", BRAAVO_TEST_RESPONSE: JSON.stringify({id: "synthetic-session", status: "COMPLETED"})});
    expect(result.status).toBe(0); expect(f.calls()).toHaveLength(2);
    expect(f.calls()[0]).toMatchObject({path: "/api/v1/research/compare/selected", body: {
      selections: [{provider: "CEREBRAS", model: "gpt-oss-120b", reasoningEffort: "low"}]}});
    expect(f.calls()[1].path).toBe("/api/v1/research/synthetic-session");
  });
  it.each([
    ["ask", "Question", "--reasoning-effort", "high"],
    ["ask", "Question", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort"],
    ["ask", "Question", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort=high"],
    ...["default", "none", "xhigh", "HIGH"].map(v => ["ask", "Question", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort", v]),
    ...["cascade", "direct", "local", "login", "models", "--version"].map(cmd => [cmd, "Question", "--models", "CEREBRAS/gpt-oss-120b", "--reasoning-effort", "high"]),
  ])("rejects invalid or misplaced effort before network: %j", (...args) => {
    const f = fixture({...authenticated, defaultCompany: "synthetic-company"});
    expect(f.run(args).status).toBe(EXIT.USAGE); expect(f.calls()).toHaveLength(0);
  });
  it("forwards exact pairs on the selected endpoint and fails closed on old platforms", () => {
    const f = fixture({token: "synthetic-token", apiUrl: "https://braavolabs.com/api/v1", defaultCompany: "synthetic-company"});
    const result = f.run(["ask", "Question for models", "--models", "OPENAI/gpt-4o,GROQ/llama-3.3-70b-versatile"], {BRAAVO_TEST_STATUS: "404", BRAAVO_TEST_CAPTURE_REQUEST: "1"});
    expect(result.status).not.toBe(0);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]).toMatchObject({path: "/api/v1/research/compare/selected", body: {selections: [{provider: "OPENAI", model: "gpt-4o"}, {provider: "GROQ", model: "llama-3.3-70b-versatile"}]}});
  });
  it.each(["gpt-4o", "", "OPENAI/gpt-4o,", "OPENAI/gpt-4o,OPENAI/gpt-4o"])("rejects malformed selectors without a request: %s", models => {
    const f = fixture({token: "synthetic-token", defaultCompany: "synthetic-company"});
    expect(f.run(["ask", "Question for models", "--models", models]).status).not.toBe(0);
    expect(f.calls()).toHaveLength(0);
  });
});


describe("compiled CLI handoff outcome contract", () => {
  for (const json of [false, true]) {
    it(`committed approval with blocked handoff is nonzero and explicit (json=${json})`, () => {
      const f = fixture(authenticated);
      const outcome = { success: true, decision: "APPROVED", claimFailed: true, error: "not frozen" };
      const result = f.run(["approve", "synthetic-approval", "--yes", ...(json ? ["--json"] : [])],
        { BRAAVO_TEST_RESPONSE: JSON.stringify(outcome), BRAAVO_TEST_CAPTURE_REQUEST: "1" });
      expect(result.status).toBe(EXIT.API); expect(f.calls()).toHaveLength(1);
      if (json) expect(JSON.parse(result.stdout)).toEqual({ id: "synthetic-approval", decision: "APPROVED", result: outcome });
      else { expect(result.stdout).toContain("APPROVED"); expect(result.stdout).toMatch(/handoff.*(incomplete|attention|failed|blocked)/i); expect(result.stdout).toContain("not frozen"); }
    });
  }
  it.each([{}, { success: true, decision: "APPROVED", claimFailed: "true" }, { success: true, decision: "REJECTED" }])("invalid successful decision response is not success (%j)", outcome => {
    const f = fixture(authenticated);
    const result = f.run(["approve", "synthetic-approval", "--yes", "--json"], { BRAAVO_TEST_RESPONSE: JSON.stringify(outcome) });
    expect(result.status).not.toBe(EXIT.OK); expect(result.stdout).toBe(""); expect(f.calls()).toHaveLength(1);
  });
  it.each([undefined, false])("true decision success accepts legacy absent/false claimFailed (%j)", claimFailed => {
    const f = fixture(authenticated);
    const outcome = { success: true, decision: "APPROVED", claimFailed };
    const result = f.run(["approve", "synthetic-approval", "--yes", "--json"], { BRAAVO_TEST_RESPONSE: JSON.stringify(outcome) });
    expect(result.status).toBe(EXIT.OK); expect(JSON.parse(result.stdout).result).toEqual(JSON.parse(JSON.stringify(outcome))); expect(f.calls()).toHaveLength(1);
  });
});

// Actual compiled command entry, temporary homes, injected fetch only.
describe("compiled fourteen-language CLI", () => {
  const locales = ["tr", "en", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"];
  const commands = ["login","logout","use","ask","cancel","cascade","savings","keys","media-key","image","voice","local","direct","models","spawn","fix","mcp","whoami","runs","run","steer","handoffs","handoff","continue","connections","doctor","init","watch","approve","pause","stop","cost","policy","audit","connect","agent","session"];
  for (const locale of locales) {
    it(`${locale}: help and all37 command-help routes require no config, credential or network`, () => {
      const f = fixture(); const full = f.run(["--lang", locale, "help"]);
      expect(full.status).toBe(EXIT.OK); expect(full.stdout).not.toContain("�");
      for (const command of commands) {
        expect(full.stdout).toContain(`braavo ${command}`);
        const result = f.run(["--lang", locale, command, "--help"]);
        expect(result.status, result.stderr).toBe(EXIT.OK); expect(result.stdout).toContain(`braavo ${command}`);
      }
      expect(f.calls()).toHaveLength(0); expect(f.config()).toBeUndefined();
    }, 30000);
    it(`${locale}: refusal sends no request and leaves the account untouched`, () => {
      const f = fixture(authenticated); const result = f.run(["--lang", locale, "stop", "synthetic-run"]);
      expect(result.status).toBe(EXIT.CONFIRMATION_REQUIRED); expect(result.stderr).toContain("synthetic-run");
      expect(f.calls()).toHaveLength(0); expect(f.config()).toEqual(authenticated);
    });
    it(`${locale}: JSON retains raw protocol and provider text`, () => {
      const body = { status: "COMPLETED", providerText: "No keys stored. 日本語 العربية", costUsd: 1234.5 };
      const f = fixture(authenticated); const result = f.run(["cost", "--json", "--lang", locale], { BRAAVO_TEST_RESPONSE: JSON.stringify(body) });
      expect(result.status).toBe(EXIT.OK); expect(JSON.parse(result.stdout)).toEqual({ usage: body, savings: body, days: 30 });
      expect(f.calls()).toHaveLength(2);
    });
  }
  it("BRAAVO_LOCALE selects Japanese and an explicit flag overrides it", () => {
    const f = fixture(); expect(f.run(["help"], { BRAAVO_LOCALE: "ja" }).stdout).toContain("コマンド");
    expect(f.run(["help", "--lang", "tr"], { BRAAVO_LOCALE: "ja" }).stdout).toContain("Komutlar");
    const fallback = f.run(["help"], { BRAAVO_LOCALE: "unknown" });
    expect(fallback.status).toBe(EXIT.OK); expect(fallback.stdout).toContain("Commands"); expect(fallback.stderr).toContain("using en");
    expect(f.calls()).toHaveLength(0); expect(f.config()).toBeUndefined();
  });
});

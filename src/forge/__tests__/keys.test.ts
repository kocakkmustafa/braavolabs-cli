import { describe, it, expect, vi } from "vitest";
import { makeKeyStore, maskKey, KEYCHAIN_SERVICE, type KeyStoreDeps } from "../keys";

/** In-memory fs + chmod recorder for injecting into makeKeyStore. */
function fakeFs() {
  const files = new Map<string, string>();
  const chmods: Array<{ path: string; mode: number }> = [];
  const fs: KeyStoreDeps["fs"] = {
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    writeFileSync: (p, data) => void files.set(p, data),
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    chmodSync: (p, mode) => void chmods.push({ path: p, mode }),
    rmSync: (p) => void files.delete(p),
  };
  return { files, chmods, fs };
}

describe("maskKey", () => {
  it("never reveals the full key for long secrets", () => {
    const secret = "sk-ant-api03-abcdef1234567890WXYZ";
    const masked = maskKey(secret);
    expect(masked).not.toBe(secret);
    expect(masked).toContain("…");
    expect(masked).toBe("sk-a…WXYZ");
  });

  it("reveals nothing for short secrets", () => {
    expect(maskKey("short")).toBe("…");
    expect(maskKey("")).toBe("…");
  });
});

describe("keychain store (macOS)", () => {
  it("add calls `security add-generic-password` with service forge-cli and records the name only", () => {
    const { files, fs } = fakeFs();
    const exec = vi.fn(() => "");
    const store = makeKeyStore({ platform: "darwin", dir: "/home/.forge", exec, fs });
    store.add("openai", "sk-secret-value-xyz");

    expect(store.secure).toBe(true);
    expect(exec).toHaveBeenCalledWith([
      "add-generic-password",
      "-a",
      "openai",
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      "sk-secret-value-xyz",
      "-U",
    ]);
    // index file holds the provider name, not the secret
    const index = files.get("/home/.forge/keys-index.json")!;
    expect(index).toContain("openai");
    expect(index).not.toContain("sk-secret-value-xyz");
  });

  it("list masks the secret fetched from the keychain", () => {
    const { fs } = fakeFs();
    const exec = vi.fn((args: string[]) => {
      if (args[0] === "find-generic-password") return "sk-abcdEFGH1234wxyz";
      return "";
    });
    const store = makeKeyStore({ platform: "darwin", dir: "/home/.forge", exec, fs });
    store.add("anthropic", "sk-abcdEFGH1234wxyz");
    const list = store.list();
    expect(list).toEqual([{ provider: "anthropic", masked: "sk-a…wxyz" }]);
    expect(JSON.stringify(list)).not.toContain("EFGH1234");
  });

  it("rm calls delete-generic-password and drops the name from the index", () => {
    const { files, fs } = fakeFs();
    const exec = vi.fn(() => "");
    const store = makeKeyStore({ platform: "darwin", dir: "/home/.forge", exec, fs });
    store.add("openai", "k1");
    store.add("groq", "k2");
    store.remove("openai");
    expect(exec).toHaveBeenCalledWith(["delete-generic-password", "-a", "openai", "-s", KEYCHAIN_SERVICE]);
    const index = files.get("/home/.forge/keys-index.json")!;
    expect(index).not.toContain("openai");
    expect(index).toContain("groq");
  });
});

describe("fallback file store (non-macOS)", () => {
  it("add writes keys.json and chmods it to 600", () => {
    const { files, chmods, fs } = fakeFs();
    const store = makeKeyStore({ platform: "linux", dir: "/home/.forge", exec: () => "", fs });
    store.add("openai", "sk-linux-secret");
    expect(store.secure).toBe(false);
    expect(files.get("/home/.forge/keys.json")).toContain("sk-linux-secret");
    expect(chmods).toContainEqual({ path: "/home/.forge/keys.json", mode: 0o600 });
  });

  it("list masks fallback secrets and rm removes them", () => {
    const { files, fs } = fakeFs();
    const store = makeKeyStore({ platform: "linux", dir: "/home/.forge", exec: () => "", fs });
    store.add("openai", "sk-abcd00001234wxyz");
    expect(store.list()).toEqual([{ provider: "openai", masked: "sk-a…wxyz" }]);
    store.remove("openai");
    expect(store.list()).toEqual([]);
    expect(files.get("/home/.forge/keys.json")).not.toContain("sk-abcd00001234wxyz");
  });
});

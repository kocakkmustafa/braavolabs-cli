import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { speak, speakable, speechCommand } from "../speak";

class FakeChild extends EventEmitter {
  written = ""; killed = false;
  stdin = Object.assign(new EventEmitter(), { end: (s: string) => { this.written = s; } });
  kill() { this.killed = true; this.emit("close", null); return true; }
}

describe("CLI read-aloud (plan 5.9)", () => {
  it("picks the system's own speech program per platform", () => {
    expect(speechCommand("darwin", c => c === "say")).toEqual({ cmd: "say", args: ["-f", "-"] });
    expect(speechCommand("darwin", () => false)).toBeNull();
    expect(speechCommand("linux", c => c === "espeak-ng")).toEqual({ cmd: "espeak-ng", args: ["--stdin"] });
    expect(speechCommand("linux", c => c === "spd-say" || c === "espeak")).toEqual({ cmd: "spd-say", args: ["-w", "-e"] });
    expect(speechCommand("win32", c => c === "powershell")?.args.at(-1)).toContain("System.Speech");
  });

  it("reads words, not markup, links or code", () => {
    expect(speakable("## Plan\n- **Ship** on `Monday`, see [notes](https://x.example)\n```js\nrm()\n```\nDone.")).toBe("Plan\nShip on Monday, see notes\nDone.");
  });

  it("sends the text on stdin, waits for the voice and stops on abort", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const done = speak("Hello **there**", { command: { cmd: "say", args: ["-f", "-"] }, spawnImpl });
    expect(spawnImpl).toHaveBeenCalledWith("say", ["-f", "-"]);
    expect(child.written).toBe("Hello there");
    child.emit("close", 0);
    expect(await done).toBe(true);

    const second = new FakeChild(); const controller = new AbortController();
    const stopped = speak("long answer", { command: { cmd: "say", args: [] }, spawnImpl: () => second as never, signal: controller.signal });
    controller.abort();
    expect(await stopped).toBe(true);
    expect(second.killed).toBe(true);

    expect(await speak("hi", { command: null })).toBe(false);
    expect(await speak("```\ncode only\n```", { command: { cmd: "say", args: [] }, spawnImpl })).toBe(false);
  });
});

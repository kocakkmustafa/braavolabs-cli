import { describe, expect, it } from "vitest";
import { initialBoard, reduceBoard, renderBoard, withData, withOffline, type BoardData, type BoardState } from "../tui/board";
import { fitLine, plainText, sanitize, shorten } from "../tui/theme";

const NONE = { color: false, light: false };
const FORMAT = "‮‪⁦⁩​‏⁠﻿؜᠎";
const agent = (name: string) => ({ id: "a1", name, role: "role", status: "idle", provider: "P", model: "m", budgetUsdMonthly: null, budgetRatio: null, month: { usd: 0, runs: 0 } });
const approval = (title: string, tool = "Mailchimp", paths: string[] = ["a.ts"]) => ({ id: "ap1", title, tool, paths, created_at: "x" });
const data = (approvals: BoardData["approvals"], agents = [agent("Valar")]): BoardData => ({ company: null, agents, tasks: [], approvals, conversations: [] });
const ready = (d: BoardData): BoardState => reduceBoard(withData(initialBoard(false), d), "x").state;
const press = (s: BoardState, ...keys: string[]) => keys.reduce((st, k) => reduceBoard(st, k).state, s);
const screen = (s: BoardState, cols = 120) => renderBoard(s, { cols, rows: 30 }, NONE).join("\n");

describe("outside text is sanitized (approval integrity)", () => {
  it("sanitize removes controls and every Unicode format character", () => {
    expect(sanitize(`a${FORMAT}b\u001b[2Jc d`)).toBe("ab [2Jcd");
    expect(plainText(fitLine([[`x${FORMAT}y`]], 10, false))).toBe("xy");
  });

  it("a bidi-override title, tool, path and agent name are drawn clean, also in the confirm line", () => {
    let s = ready(data([approval(`Pay ${FORMAT}$5 only`, `Mail${FORMAT}chimp`, [`a${FORMAT}/b.ts`])], [agent(`Va${FORMAT}lar`)]));
    const view = screen(s);
    expect(view).toContain("Pay $5 only");
    expect(view).toContain("Mailchimp");
    expect(view).toContain("a/b.ts");
    s = press(s, "o");
    const confirm = screen(s);
    expect(confirm).toContain("Approve: Pay $5 only? Tool Mailchimp · 1 files");
    const agentView = screen(press(s, "\u001b", "j"));
    expect(agentView).toContain("Valar");
    for (const ch of FORMAT) for (const out of [view, confirm, agentView]) expect(out).not.toContain(ch);
  });

  it("marks a shortened title with an ellipsis instead of cutting silently", () => {
    expect(shorten("x".repeat(120), 80)).toBe("x".repeat(79) + "…");
    expect(shorten(`ok${FORMAT}`, 80)).toBe("ok");
    const s = press(ready(data([approval("y".repeat(120), "Mailchimp", ["a", "b"])])), "r");
    const label = (s.confirm as { label: string }).label;
    expect([...label]).toHaveLength(80);
    expect(label.endsWith("…")).toBe(true);
    expect(s.confirm).toMatchObject({ kind: "reject", tool: "Mailchimp", files: 2 });
    expect(screen(s, 200)).toContain(`Reject: ${label}? Tool Mailchimp · 2 files`);
    expect((press(ready(data([approval("short")])), "r").confirm as { label: string }).label).toBe("short");
  });

  it("offline reasons from the daemon are sanitized too", () => {
    expect(screen(withOffline(ready(data([])), `down‮​x`))).toContain("downx");
  });
});

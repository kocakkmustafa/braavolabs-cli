import { afterEach, describe, expect, it } from "vitest";
import { DaemonStore } from "../store";
import { CompanyError, hire, panel, updateAgent } from "../company";

const stores: DaemonStore[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
const NOW = new Date("2026-11-01T04:00:00Z");

function setup() {
  const store = new DaemonStore(":memory:", () => NOW.toISOString()); stores.push(store);
  const co = store.createCompany({ name: "YULA Lab", mission: "Small, excellent apps" });
  return { store, co };
}

describe("hiring the starter company", () => {
  it("hires the seven approved agents with their reporting lines, routines and setup needs", () => {
    const { store, co } = setup();
    const result = hire(store, co.id, { timezone: "Europe/Istanbul", locale: "tr", urls: { "market-analyst/watch-competitors": ["https://rival.example/pricing"] } },
      { keys: new Set(), local: { OLLAMA: ["qwen3:8b"] } }, NOW);
    expect(result.agents.map(a => a.name)).toEqual(["Genel Müdür", "Pazar Analisti", "İçerik ve Sosyal Medya Sorumlusu", "Müşteri Sesi Analisti", "Finans Takipçisi", "Teknik Lider", "Sürüm ve Bağımlılık Takipçisi"]);
    const byRole = Object.fromEntries(result.agents.map(a => [a.role, a]));
    expect(byRole["market-analyst"]).toMatchObject({ provider: "OLLAMA", model: "qwen3:8b", status: "idle", reports_to_agent_id: byRole.ceo.id });
    expect(byRole["customer-voice"].reports_to_agent_id).toBe(byRole["content-lead"].id);
    // K3: local model serves every tier when there is no key; nothing needs setup.
    expect(result.needsSetup).toEqual([]);
    expect(result.needsUrls).toEqual(["release-tracker/watch-releases"]);
    const watch = result.routines.find(r => r.name === "Rakipleri izle")!;
    expect(watch).toMatchObject({ rrule: "FREQ=HOURLY;INTERVAL=6", nextFireAt: "2026-11-01T10:00:00.000Z" });
    expect(result.routines.find(r => r.name === "Haftalık özet")?.nextFireAt).toBe("2026-11-02T06:00:00.000Z");
    expect(JSON.parse(store.getRoutine(watch.id)!.preflight)).toMatchObject({ type: "web", urls: ["https://rival.example/pricing"] });
  });

  it("is idempotent per role and reports agents that need setup", () => {
    const { store, co } = setup();
    const first = hire(store, co.id, { templates: ["ceo", "market-analyst"] }, { keys: new Set() }, NOW);
    expect(first.needsSetup.map(n => n.reason)).toEqual(["setup-required", "setup-required"]);
    expect(first.agents.every(a => a.status === "error")).toBe(true);
    const again = hire(store, co.id, { templates: "all" }, { keys: new Set(["GROQ"]) }, NOW);
    expect(again.skipped).toEqual(["ceo", "market-analyst"]);
    expect(again.agents).toHaveLength(5);
    expect(store.listAgents(co.id)).toHaveLength(7);
    const cto = again.agents.find(a => a.role === "cto")!;
    expect(cto.reports_to_agent_id).toBe(first.agents[0].id);
    expect(() => hire(store, co.id, { templates: ["intern"] }, { keys: new Set() })).toThrow(CompanyError);
    expect(() => hire(store, "co_nope", {}, { keys: new Set() })).toThrow(/company not found/);
  });
});

describe("panel and agent changes", () => {
  it("shows the org tree, month usage and routine outcomes in one snapshot", () => {
    const { store, co } = setup();
    const { agents, routines } = hire(store, co.id, { templates: ["ceo", "market-analyst"], urls: { "market-analyst/watch-competitors": ["https://rival.example"] } }, { keys: new Set(["GROQ"]) }, NOW);
    store.recordCost({ companyId: co.id, agentId: agents[1].id, provider: "GROQ", model: "openai/gpt-oss-120b", inputTokens: 100, outputTokens: 20 });
    store.recordExecution({ routineId: routines[1].id, scheduledFor: NOW.toISOString(), outcome: "no-change", note: "1 pages", nextFireAt: NOW.toISOString(), fired: true });
    const p = panel(store, co.id, NOW);
    expect(p.tree).toEqual([{ id: agents[0].id, children: [{ id: agents[1].id, children: [] }] }]);
    expect(p.agents[1]).toMatchObject({ name: "Market Analyst", provider: "GROQ", effort: "low", status: "idle", month: { inputTokens: 100, outputTokens: 20, runs: 1 } });
    expect(p.routines.find(r => r.id === routines[1].id)).toMatchObject({ preflight: "web", last: { outcome: "no-change", note: "1 pages" } });
    expect(p.month).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(p.activity[0]).toMatchObject({ verb: "hired-templates" });
  });

  it("changes model and effort, pauses and resumes, and refuses org cycles", () => {
    const { store, co } = setup();
    const { agents: [ceo, analyst] } = hire(store, co.id, { templates: ["ceo", "market-analyst"] }, { keys: new Set() }, NOW);
    const canUse = (p: string) => p === "OLLAMA";
    expect(updateAgent(store, analyst.id, { provider: "OLLAMA", model: "qwen3:8b", effort: null }, canUse)).toMatchObject({ provider: "OLLAMA", effort: null, status: "idle" });
    expect(updateAgent(store, analyst.id, { status: "paused" }, canUse).status).toBe("paused");
    expect(updateAgent(store, analyst.id, { effort: "low" }, canUse).status).toBe("paused");
    expect(updateAgent(store, analyst.id, { status: "idle" }, canUse).status).toBe("idle");
    expect(() => updateAgent(store, ceo.id, { reportsToAgentId: analyst.id }, canUse)).toThrow(/break the org chart/);
    expect(() => updateAgent(store, analyst.id, { effort: "xhigh" }, canUse)).toThrow(/unknown effort/);
    expect(updateAgent(store, ceo.id, { provider: "ANTHROPIC", model: "claude-opus-5-5" }, canUse).status).toBe("error");
  });
});

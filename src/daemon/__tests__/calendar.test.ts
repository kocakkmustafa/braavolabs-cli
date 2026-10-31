import { describe, expect, it } from "vitest";
import { firstFireAt, isSupportedRrule, nextCalendarFire, parseCalendarRule, planTick } from "../scheduler";
import { AGENT_TEMPLATES } from "../../core/templates";

const next = (rrule: string, zone: string, after: string) => new Date(nextCalendarFire(parseCalendarRule(rrule)!, zone, Date.parse(after))!).toISOString();

describe("calendar rules in the routine's time zone", () => {
  it("accepts every rule the starter templates use and rejects guesses", () => {
    for (const t of AGENT_TEMPLATES) {
      if (t.heartbeatRrule) expect(isSupportedRrule(t.heartbeatRrule), t.heartbeatRrule).toBe(true);
      for (const r of t.routines) expect(isSupportedRrule(r.rrule), r.rrule).toBe(true);
    }
    for (const bad of ["FREQ=WEEKLY;BYDAY=XX", "FREQ=DAILY;BYHOUR=24", "FREQ=DAILY;BYHOUR=9;INTERVAL=2", "FREQ=MONTHLY;BYDAY=MO", "FREQ=DAILY;BYSETPOS=1;BYHOUR=9", "FREQ=YEARLY;BYHOUR=1"]) {
      expect(isSupportedRrule(bad), bad).toBe(false);
    }
  });

  it("fires at local wall-clock times", () => {
    // Istanbul is UTC+3 all year.
    expect(next("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "Europe/Istanbul", "2026-11-01T05:00:00Z")).toBe("2026-11-01T06:00:00.000Z");
    expect(next("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "Europe/Istanbul", "2026-11-01T06:00:00Z")).toBe("2026-11-02T06:00:00.000Z");
    // 2026-11-01 is a Sunday; next Monday 09:00 Istanbul.
    expect(next("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", "Europe/Istanbul", "2026-11-01T12:00:00Z")).toBe("2026-11-02T06:00:00.000Z");
    expect(next("FREQ=DAILY;BYHOUR=7,18;BYMINUTE=30", "UTC", "2026-11-01T08:00:00Z")).toBe("2026-11-01T18:30:00.000Z");
  });

  it("handles the last day of the month and DST changes", () => {
    expect(next("FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18;BYMINUTE=0", "UTC", "2026-02-10T00:00:00Z")).toBe("2026-02-28T18:00:00.000Z");
    expect(next("FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18;BYMINUTE=0", "UTC", "2028-02-10T00:00:00Z")).toBe("2028-02-29T18:00:00.000Z");
    // New York leaves DST on 2026-11-01: 09:00 is 13:00Z before and 14:00Z after.
    expect(next("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "America/New_York", "2026-10-31T12:00:00Z")).toBe("2026-10-31T13:00:00.000Z");
    expect(next("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "America/New_York", "2026-10-31T13:00:00Z")).toBe("2026-11-01T14:00:00.000Z");
    // Spring forward: 02:30 does not exist on 2026-03-08; it still fires once that day.
    const gap = next("FREQ=DAILY;BYHOUR=2;BYMINUTE=30", "America/New_York", "2026-03-08T05:00:00Z");
    expect(gap.startsWith("2026-03-08T0")).toBe(true);
  });

  it("schedules, catches up once after sleep and re-anchors on the calendar", () => {
    const rrule = "FREQ=DAILY;BYHOUR=8;BYMINUTE=0";
    expect(firstFireAt(rrule, new Date("2026-11-01T04:00:00Z"), "Europe/Istanbul")).toBe("2026-11-01T05:00:00.000Z");
    // Asleep for three mornings: two are skipped, the latest runs once as a catch-up.
    const actions = planTick([{ id: "r", rrule, timezone: "Europe/Istanbul", catchUp: "once", nextFireAt: "2026-11-01T05:00:00.000Z", enabled: true }], new Date("2026-11-03T09:00:00Z"));
    expect(actions.map(a => [a.kind, a.scheduledFor])).toEqual([
      ["skip", "2026-11-01T05:00:00.000Z"], ["skip", "2026-11-02T05:00:00.000Z"], ["run", "2026-11-03T05:00:00.000Z"],
    ]);
    expect(actions.at(-1)).toMatchObject({ catchUp: true, nextFireAt: "2026-11-04T05:00:00.000Z" });
  });
});

/**
 * Routine scheduling decisions (platform docs/ai-company/TASARIM.tr.md §6.3),
 * kept pure so sleep/wake and catch-up behaviour is testable without timers.
 *
 * - Interval rules: RFC 5545 subset FREQ=MINUTELY|HOURLY|DAILY|WEEKLY with
 *   INTERVAL (default 1), anchored on creation.
 * - Calendar rules, read in the routine's own IANA time zone: FREQ=DAILY|WEEKLY|
 *   MONTHLY with BYHOUR, BYMINUTE, BYDAY (MO…SU) and BYMONTHDAY (1…31, -1 = last
 *   day), INTERVAL=1. Anything else is rejected rather than silently misread.
 * - The daemon ticks every 60 s. A gap much longer than a tick means the
 *   machine slept or the daemon was stopped: missed firings are handled by the
 *   routine's catch-up policy — `once` runs only the most recent missed firing
 *   (within 7 days) and records the rest as skipped-sleep; `skip` records all
 *   of them as skipped-sleep. Agents never run in the cloud (founder decision K4).
 */

export const TICK_MS = 60_000;
export const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_RECORDED_MISSES = 50;

const FREQ_MS: Record<string, number> = { MINUTELY: 60_000, HOURLY: 3_600_000, DAILY: 86_400_000, WEEKLY: 604_800_000 };

/** Interval of a supported RRULE in ms; undefined when the rule is outside the supported subset. */
export function intervalMs(rrule: string): number | undefined {
  const body = rrule.startsWith("RRULE:") ? rrule.slice(6) : rrule;
  const parts = Object.fromEntries(body.split(";").map(p => p.split("=") as [string, string]));
  const keys = Object.keys(parts);
  if (!parts.FREQ || !FREQ_MS[parts.FREQ] || keys.some(k => k !== "FREQ" && k !== "INTERVAL")) return undefined;
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return undefined;
  const ms = FREQ_MS[parts.FREQ] * interval;
  return ms >= 15 * 60_000 || parts.FREQ !== "MINUTELY" ? ms : undefined; // floor: 15 minutes
}

// ─── Calendar rules ─────────────────────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface CalendarRule { freq: "DAILY" | "WEEKLY" | "MONTHLY"; hours: number[]; minutes: number[]; days?: Set<number>; monthDays?: number[] }

function ints(value: string, min: number, max: number): number[] | undefined {
  const out = value.split(",").map(Number);
  return out.every(n => Number.isInteger(n) && n >= min && n <= max) ? [...new Set(out)].sort((a, b) => a - b) : undefined;
}

export function parseCalendarRule(rrule: string): CalendarRule | undefined {
  const body = rrule.startsWith("RRULE:") ? rrule.slice(6) : rrule;
  const parts = Object.fromEntries(body.split(";").map(p => p.split("=") as [string, string]));
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") return undefined;
  if (!parts.BYHOUR && !parts.BYDAY && !parts.BYMONTHDAY) return undefined; // plain FREQ is an interval rule
  const allowed = new Set(["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYDAY", "BYMONTHDAY"]);
  if (Object.keys(parts).some(k => !allowed.has(k)) || (parts.INTERVAL !== undefined && parts.INTERVAL !== "1")) return undefined;
  const hours = parts.BYHOUR ? ints(parts.BYHOUR, 0, 23) : [0];
  const minutes = parts.BYMINUTE ? ints(parts.BYMINUTE, 0, 59) : [0];
  if (!hours || !minutes) return undefined;
  const rule: CalendarRule = { freq, hours, minutes };
  if (parts.BYDAY) {
    if (freq === "MONTHLY") return undefined;
    const days = parts.BYDAY.split(",").map(d => WEEKDAYS.indexOf(d));
    if (days.some(d => d < 0)) return undefined;
    rule.days = new Set(days);
  } else if (freq === "WEEKLY") return undefined; // which weekday would be a guess
  if (parts.BYMONTHDAY) {
    if (freq !== "MONTHLY") return undefined;
    const monthDays = parts.BYMONTHDAY.split(",").map(Number);
    if (monthDays.some(n => !Number.isInteger(n) || n === 0 || n < -31 || n > 31)) return undefined;
    rule.monthDays = monthDays;
  } else if (freq === "MONTHLY") return undefined;
  return rule;
}

/** Offset of `timeZone` from UTC at instant `ms`, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `timeZone` (DST gaps move forward, overlaps take the first). */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const wall = Date.UTC(y, m, d, h, min);
  let utc = wall - zoneOffset(wall, timeZone);
  const corrected = zoneOffset(utc, timeZone);
  if (wall - corrected !== utc) utc = wall - corrected; // the guess crossed a DST change
  return utc;
}

/** First calendar-rule firing strictly after `afterMs`, looking at most ~13 months ahead. */
export function nextCalendarFire(rule: CalendarRule, timeZone: string, afterMs: number): number | undefined {
  const local = new Date(afterMs + zoneOffset(afterMs, timeZone));
  for (let i = 0; i <= 400; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    const y = day.getUTCFullYear(); const m = day.getUTCMonth(); const d = day.getUTCDate();
    if (rule.days && !rule.days.has(day.getUTCDay())) continue;
    if (rule.monthDays) {
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      if (!rule.monthDays.some(n => (n > 0 ? n : last + 1 + n) === d)) continue;
    }
    for (const h of rule.hours) for (const min of rule.minutes) {
      const at = zonedToUtc(y, m, d, h, min, timeZone);
      if (at > afterMs) return at;
    }
  }
  return undefined;
}

/** True when the daemon can schedule this rule (interval or calendar subset). */
export function isSupportedRrule(rrule: string): boolean {
  return intervalMs(rrule) !== undefined || parseCalendarRule(rrule) !== undefined;
}

export interface DueRoutine { id: string; rrule: string; timezone?: string; catchUp: "once" | "skip"; nextFireAt: string; enabled: boolean; running?: boolean }

export type TickAction =
  | { routineId: string; kind: "run"; scheduledFor: string; catchUp: boolean; nextFireAt: string }
  | { routineId: string; kind: "skip"; scheduledFor: string; outcome: "skipped-sleep" | "skipped-running" | "invalid-rule"; nextFireAt: string };

/**
 * Decide what each routine does at `now`. Missed firings older than the
 * latest one are skipped (or caught up once); the schedule is re-anchored so
 * the next firing is always in the future.
 */
export function planTick(routines: DueRoutine[], now: Date): TickAction[] {
  const actions: TickAction[] = [];
  const t = now.getTime();
  for (const r of routines) {
    if (!r.enabled) continue;
    const due = Date.parse(r.nextFireAt);
    if (!(due <= t)) continue;
    const every = intervalMs(r.rrule);
    const calendar = every === undefined ? parseCalendarRule(r.rrule) : undefined;
    const zone = r.timezone ?? "UTC";
    if (every === undefined && !calendar) {
      actions.push({ routineId: r.id, kind: "skip", scheduledFor: r.nextFireAt, outcome: "invalid-rule", nextFireAt: new Date(t + 86_400_000).toISOString() });
      continue;
    }
    // Firings in [due, now]; the latest is the one that may run.
    let missed: number; let latest: number; let nextMs: number;
    let calendarFirings: number[] = [];
    if (every !== undefined) {
      missed = Math.floor((t - due) / every);
      latest = due + missed * every;
      nextMs = latest + every;
    } else {
      calendarFirings = [due];
      for (let n = nextCalendarFire(calendar!, zone, due); n !== undefined && n <= t && calendarFirings.length < 10_000; n = nextCalendarFire(calendar!, zone, n)) calendarFirings.push(n);
      missed = calendarFirings.length - 1;
      latest = calendarFirings[missed];
      nextMs = nextCalendarFire(calendar!, zone, Math.max(latest, t)) ?? t + 86_400_000;
    }
    const next = new Date(nextMs).toISOString();
    const lateBySleep = t - due > 2 * TICK_MS;
    const skippedCount = Math.min(missed, MAX_RECORDED_MISSES);
    for (let i = missed - skippedCount; i < missed; i++) {
      const at = every !== undefined ? due + i * every : calendarFirings[i];
      actions.push({ routineId: r.id, kind: "skip", scheduledFor: new Date(at).toISOString(), outcome: "skipped-sleep", nextFireAt: next });
    }
    const latestIso = new Date(latest).toISOString();
    if (r.running) {
      actions.push({ routineId: r.id, kind: "skip", scheduledFor: latestIso, outcome: "skipped-running", nextFireAt: next });
    } else if (lateBySleep && (r.catchUp === "skip" || t - latest > CATCH_UP_WINDOW_MS)) {
      actions.push({ routineId: r.id, kind: "skip", scheduledFor: latestIso, outcome: "skipped-sleep", nextFireAt: next });
    } else {
      actions.push({ routineId: r.id, kind: "run", scheduledFor: latestIso, catchUp: lateBySleep, nextFireAt: next });
    }
  }
  return actions;
}

/** First firing for a new routine: one interval from creation, or the next calendar match in its zone. */
export function firstFireAt(rrule: string, now: Date, timezone = "UTC"): string | undefined {
  const every = intervalMs(rrule);
  if (every !== undefined) return new Date(now.getTime() + every).toISOString();
  const calendar = parseCalendarRule(rrule);
  const at = calendar ? nextCalendarFire(calendar, timezone, now.getTime()) : undefined;
  return at === undefined ? undefined : new Date(at).toISOString();
}

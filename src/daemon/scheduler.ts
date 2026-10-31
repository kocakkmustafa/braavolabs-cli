/**
 * Routine scheduling decisions (platform docs/ai-company/TASARIM.tr.md §6.3),
 * kept pure so sleep/wake and catch-up behaviour is testable without timers.
 *
 * - Interval rules: RFC 5545 subset FREQ=MINUTELY|HOURLY|DAILY|WEEKLY with
 *   INTERVAL (default 1). Calendar parts (BYHOUR, BYDAY…) are rejected for now
 *   rather than silently misread.
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

export interface DueRoutine { id: string; rrule: string; catchUp: "once" | "skip"; nextFireAt: string; enabled: boolean; running?: boolean }

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
    if (every === undefined) {
      actions.push({ routineId: r.id, kind: "skip", scheduledFor: r.nextFireAt, outcome: "invalid-rule", nextFireAt: new Date(t + 86_400_000).toISOString() });
      continue;
    }
    // Firings in [due, now]: due, due+every, ... ; the latest is the one that may run.
    const missed = Math.floor((t - due) / every);
    const latest = due + missed * every;
    const next = new Date(latest + every).toISOString();
    const lateBySleep = t - due > 2 * TICK_MS;
    const skippedCount = Math.min(missed, MAX_RECORDED_MISSES);
    for (let i = missed - skippedCount; i < missed; i++) {
      actions.push({ routineId: r.id, kind: "skip", scheduledFor: new Date(due + i * every).toISOString(), outcome: "skipped-sleep", nextFireAt: next });
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

/** First firing for a new routine: one interval from creation. */
export function firstFireAt(rrule: string, now: Date): string | undefined {
  const every = intervalMs(rrule);
  return every === undefined ? undefined : new Date(now.getTime() + every).toISOString();
}

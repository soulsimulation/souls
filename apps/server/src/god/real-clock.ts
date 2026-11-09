// #1649: worlds run on real time. A world's clock is the real time in the world's own time zone: one world hour is one
// real hour, and the time of day and calendar date are the local wall time there. This file is the one clock source on
// the server: everything that needs "what time is it in this world" either reads the engine's env.datetime (which this
// clock drives) or asks here.
//
// The engine stays deterministic: it never reads a wall clock. Its day clock is the logged `dayConfig` rules event
// ({origin, dayTicks}; env.datetime = CLOCK_BASE + (tick - origin) / dayTicks days). On real time the day is
// REAL_DAY_TICKS long (86,400 s at 20 ticks/s), and the server, which does read the wall clock, chooses the origin so the
// engine's datetime reads the local wall time now. The server logs a new origin only when the engine's clock has drifted
// from the wall (a restart, a slowed or stalled tick loop, a daylight-saving change), as an ordinary rules event, so a
// replay reaches the same state. Nothing is simulated for skipped time, and nothing is stored but the zone.
//
// Behind SIM_REAL_TIME=1 until the consumers have moved over (#1649 PR plan); off, the accelerated clock is unchanged.

/** The engine's clock epoch: elapsed 0 reads 2026-10-03T06:00 (engine-mars updateClock, brain clockAt). */
export const CLOCK_BASE_MS = Date.UTC(2026, 9, 3, 6);
/** Engine ticks are 50 ms: 20 per second. */
export const TICK_MS = 50;
/** One real day of ticks: the day length of a real-time world. */
export const REAL_DAY_TICKS = (86_400_000 / TICK_MS) as 1_728_000;
/** A watched world's clock may drift this far from the wall before one re-alignment is logged. */
export const REALIGN_MS = 60_000;

/** Real time is on (SIM_REAL_TIME=1). Off by default until #1649's consumers have all moved over. */
export function realTimeEnabled(env: Record<string, string | undefined> = process.env): boolean { return env.SIM_REAL_TIME === '1'; }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** An IANA time zone name this runtime knows (e.g. "America/New_York", "Europe/Lisbon", "UTC"). */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v)) return false;
  try { formatter(v); return true; } catch { return false; }
}

/** The local wall time in `timeZone` at the UTC instant `utcMs`, as milliseconds of a UTC date that reads the same
 *  (year, month, day, hour, minute, second; milliseconds carried over). */
export function localWallMs(utcMs: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(new Date(utcMs))) if (type !== 'literal') p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + (((utcMs % 1000) + 1000) % 1000);
}

/** The local wall time in `timeZone` as the engine writes datetimes ("YYYY-MM-DDTHH:MM:SS.sssZ", read as local). */
export function localDateTime(utcMs: number, timeZone: string): string { return new Date(localWallMs(utcMs, timeZone)).toISOString(); }

/** The day-clock origin that makes the engine read the local wall time of `utcMs` in `timeZone` at `tick`. */
export function realClockOrigin(tick: number, utcMs: number, timeZone: string): number {
  return tick - Math.round((localWallMs(utcMs, timeZone) - CLOCK_BASE_MS) / TICK_MS);
}

/** The rules payload that puts the world clock on real time at `tick`. `zone` is informational (host.living.zone). */
export function realClockConfig(tick: number, utcMs: number, timeZone: string) {
  return { dayConfig: { origin: realClockOrigin(tick, utcMs, timeZone), dayTicks: REAL_DAY_TICKS, customs: [] as string[], zone: timeZone },
    why: `world clock: real time in ${timeZone}` };
}

/** How far (ms, signed: positive = the engine is behind the wall) a clock {origin, dayTicks} is from real time. */
export function realClockDriftMs(clock: { origin: number; dayTicks: number }, tick: number, utcMs: number, timeZone: string): number {
  if (clock.dayTicks !== REAL_DAY_TICKS) return Infinity;
  return (clock.origin - realClockOrigin(tick, utcMs, timeZone)) * TICK_MS;
}

/** #1649 migration: the time zone of a world that never had one, by its slug (Gene's decision). */
export const MIGRATION_ZONES: Readonly<Record<string, string>> = Object.freeze({
  'mars-college-2026': 'America/Los_Angeles',
  'mars-college-2027': 'America/Los_Angeles',
  'rna-studio': 'Europe/Lisbon',
});
export const DEFAULT_TIME_ZONE = 'America/New_York';
export function defaultTimeZone(slug: string | undefined): string { return (slug && MIGRATION_ZONES[slug]) || DEFAULT_TIME_ZONE; }

/** #1649: the deploy's explicit production marker. The production unit sets SIM_STAGE=production (sim-worlds@.service:
 *  the instance name), the launcher passes it to every world; anything else (staging, local, tests) is a dev world. */
export function productionWorld(env: Record<string, string | undefined> = process.env): boolean { return env.SIM_STAGE === 'production'; }

/** A world clock's mode: real time, or the dev-only accelerated clock (`time.clock: 'accelerated'`). With the flag off
 *  every world keeps the accelerated clock it always had. */
export function clockMode(time: { clock?: string | null } | undefined, env: Record<string, string | undefined> = process.env): 'real' | 'accelerated' {
  return realTimeEnabled(env) && time?.clock !== 'accelerated' ? 'real' : 'accelerated';
}

/** A paused clock: a day this long never visibly moves (2^40 ticks ≈ 1,700 years at 20/s). Same value as world-clock's. */
const PAUSED_TICKS = 2 ** 40;

type ClockHost = {
  engine: { world: { tick: number } };
  living?: { origin: number; dayTicks: number; customs?: string[] } | undefined;
  enqueue(kind: 'rules', author: string, payload: unknown): Promise<unknown>;
  pace?: number; paused?: boolean; running?: boolean;
};
export type RealClockOptions = {
  /** The world's zone now. */ zone: () => string;
  /** The god paused time (the clock stands still). */ paused?: () => boolean;
  /** Whether this keeper owns the clock now (false: another mode, e.g. the dev-only accelerated clock). */ active?: () => boolean;
  now?: () => number; checkMs?: number; log?: (m: string) => void;
};
const kept = new WeakSet<object>();
/** Whether a real-time keeper already runs this host's clock. */
export function hasRealClock(host: object): boolean { return kept.has(host); }

/** The one real-time clock keeper (god worlds through world-clock.ts, authored worlds through main.ts): logs the
 *  day clock that reads the local time, at once, on demand (`sync`) and whenever a watched, running world has drifted
 *  REALIGN_MS from the wall (checked every `checkMs`, default 15 s). A world nobody watches (pace < 1) or an
 *  admin-paused one is left alone until it runs at full pace again. Customs carry over. */
export function installRealClock(host: ClockHost, o: RealClockOptions) {
  kept.add(host);
  const now = o.now ?? Date.now, active = o.active ?? (() => true);
  let pending: Promise<void> | undefined;
  const sync = (): Promise<void> => {
    if (!active()) return Promise.resolve();
    if (pending) return pending.then(sync);
    const l = host.living as (ClockHost['living'] & { zone?: string }) | undefined, tick = host.engine.world.tick, zone = o.zone();
    let payload: { dayConfig: Record<string, unknown>; why: string };
    if (o.paused?.()) {
      if (l && l.dayTicks === PAUSED_TICKS) return Promise.resolve();
      // the time of day stands where it is (the phase of the running day), on a day too long to move
      const days = l ? Math.max(0, tick - l.origin) / l.dayTicks : 0;
      payload = { dayConfig: { origin: Math.round(tick - days * PAUSED_TICKS), dayTicks: PAUSED_TICKS, customs: l?.customs ?? [], zone }, why: 'world clock: paused by the god' };
    } else {
      if (l && l.zone === zone && Math.abs(realClockDriftMs(l, tick, now(), zone)) < REALIGN_MS) return Promise.resolve();
      const c = realClockConfig(tick, now(), zone);
      payload = { ...c, dayConfig: { ...c.dayConfig, customs: l?.customs ?? [] } };
    }
    pending = host.enqueue('rules', 'world', payload).then(() => {}).finally(() => { pending = undefined; });
    return pending.then(sync);
  };
  const schedule = () => { void sync().catch((e: Error) => o.log?.(`world clock: ${e.message}`)); };
  schedule();
  const timer = setInterval(() => { if ((host.pace ?? 1) >= 1 && !host.paused && host.running !== false) schedule(); }, o.checkMs ?? 15_000);
  timer.unref?.();
  return { sync, schedule, stop: () => clearInterval(timer) };
}

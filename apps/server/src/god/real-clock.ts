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
// On by default (#1649 part 4); SIM_REAL_TIME=0 (false, off) turns it off, and the accelerated clock is then unchanged.

/** The engine's clock epoch: elapsed 0 reads 2026-10-03T06:00 (engine-mars updateClock, brain clockAt). */
export const CLOCK_BASE_MS = Date.UTC(2026, 9, 3, 6);
/** Engine ticks are 50 ms: 20 per second. */
export const TICK_MS = 50;
/** One real day of ticks: the day length of a real-time world. */
export const REAL_DAY_TICKS = (86_400_000 / TICK_MS) as 1_728_000;
/** A watched world's clock may drift this far from the wall before one re-alignment is logged. */
export const REALIGN_MS = 60_000;

/** Real time is on: every world's clock is the local time in its zone (#1649). SIM_REAL_TIME=0 (or false, off, no)
 *  turns it off (the rollback switch, and tests that pin the old accelerated clock). */
export function realTimeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !['0', 'false', 'off', 'no'].includes((env.SIM_REAL_TIME ?? '').trim().toLowerCase());
}

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
/** A world's zone before it has its own: the zone its creator chose in the New world dialog (the launcher passes it as
 *  WORLD_TIME_ZONE, so the first real-time boot records it), else its slug's migration zone, else America/New_York. */
export function defaultTimeZone(slug: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (isTimeZone(env.WORLD_TIME_ZONE)) return env.WORLD_TIME_ZONE;
  return (slug && MIGRATION_ZONES[slug]) || DEFAULT_TIME_ZONE;
}

/** A dev signal: dev auth, or a world whose public URL is local (unset reads http://localhost, config.ts). */
function devSignal(env: Record<string, string | undefined>): boolean {
  if (env.DEV_AUTH === '1') return true;
  const url = (env.PUBLIC_URL ?? '').trim();
  if (!url) return true;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host) || host.endsWith('.localhost') || host.endsWith('.test');
}

/** #1649: the deploy's production marker. The keeper names its stage from the unit instance it runs
 *  (sim-worlds@<stage>: SIM_STAGE, or its --link /srv/sim-worlds/<stage>), the launcher passes it to every world; the
 *  public stages (production, legacy) are production, a named other stage (staging) is a dev world. It fails closed:
 *  with no stage (a release activated with --reload keeps an older keeper that sets none) a world is production unless
 *  it carries an explicit dev signal (DEV_AUTH=1, or a local or unset PUBLIC_URL), so local runs and tests stay dev. */
export function productionWorld(env: Record<string, string | undefined> = process.env): boolean {
  const stage = env.SIM_STAGE?.trim();
  if (stage) return stage === 'production' || stage === 'legacy';
  return !devSignal(env);
}

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
  pace?: number; paused?: boolean; running?: boolean; owedTicks?: number; silent?(): boolean;
  /** #2297: the keeper reports the zone's next daylight-saving change as a deadline (WorldHost.stillUntil). */
  listeners?: { stillness?(tick: number): { name: string; tick?: number | null }[] }[];
};
export type RealClockOptions = {
  /** The world's zone now. */ zone: () => string;
  /** The god paused time (the clock stands still). */ paused?: () => boolean;
  /** Whether this keeper owns the clock now (false: another mode, e.g. the dev-only accelerated clock). */ active?: () => boolean;
  now?: () => number; checkMs?: number; log?: (m: string) => void;
  /** The customs of a world whose clock has not started yet (LivingWorld's; later configs carry the running ones). */
  customs?: string[];
  /** #1649 part 4: the clock came onto real time from another clock (the cut-over), and its rules event has applied: map
   *  the data that counts world days (clock-cutover.ts). Called once per cut-over per process, and again after a throw
   *  or a restart, so it must be idempotent; a failure is logged and never stops the clock. */
  onCutOver?: (c: { tick: number; from: { origin: number; dayTicks: number }; to: { origin: number; dayTicks: number } }) => void;
};
const kept = new WeakSet<object>();
/** Whether a real-time keeper already runs this host's clock. */
export function hasRealClock(host: object): boolean { return kept.has(host); }

/** #2297: the next instant (UTC ms, to the minute) after `utcMs` at which `timeZone`'s offset changes (a daylight-saving
 *  change), within `horizonDays`; null when none (UTC, or a zone without one). */
export function nextOffsetChangeMs(utcMs: number, timeZone: string, horizonDays = 400): number | null {
  const off = (u: number) => localWallMs(u, timeZone) - u, at = off(utcMs), DAY = 86_400_000;
  for (let d = 1; d <= horizonDays; d++) {
    if (off(utcMs + d * DAY) === at) continue;
    let lo = utcMs + (d - 1) * DAY, hi = utcMs + d * DAY;   // off(lo) == at, off(hi) != at
    while (hi - lo > 60_000) { const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000 || lo + 60_000; if (off(mid) === at) lo = mid; else hi = mid; }
    return hi;
  }
  return null;
}

/** The one real-time clock keeper (god worlds through world-clock.ts, authored worlds through main.ts): logs the
 *  day clock that reads the local time, at once, on demand (`sync`) and whenever a watched, running world has drifted
 *  REALIGN_MS from the wall (checked every `checkMs`, default 15 s). A world nobody watches (pace < 1) or an
 *  admin-paused one is left alone until it runs at full pace again. Customs carry over. */
export function installRealClock(host: ClockHost, o: RealClockOptions) {
  kept.add(host);
  const now = o.now ?? Date.now, active = o.active ?? (() => true);
  let pending: Promise<void> | undefined;
  type Cut = { tick: number; from: { origin: number; dayTicks: number }; to: { origin: number; dayTicks: number } };
  const mapped = new Set<number>();
  // the cut-over named by the running clock is mapped once (the mapping itself is idempotent and records that it ran);
  // a failure is logged and tried again at the next sync or boot
  const mapCut = (c: Cut | undefined) => {
    if (!c || mapped.has(c.tick) || !o.onCutOver) return;
    try { o.onCutOver(c); mapped.add(c.tick); } catch (e) { o.log?.(`world clock: cut-over mapping failed (tried again later): ${(e as Error).message}`); }
  };
  const sync = (): Promise<void> => {
    if (!active()) return Promise.resolve();
    if (pending) return pending.then(sync);
    // #2235: during a boot catch-up the clock is read as caught up (the event applies after the owed ticks)
    const l = host.living as (ClockHost['living'] & { zone?: string; cutOver?: Cut }) | undefined, tick = host.engine.world.tick + (host.owedTicks ?? 0), zone = o.zone();
    mapCut(l?.cutOver);
    let payload: { dayConfig: Record<string, unknown>; why: string };
    if (o.paused?.()) {
      if (l && l.dayTicks === PAUSED_TICKS) return Promise.resolve();
      // the time of day stands where it is (the phase of the running day), on a day too long to move. Paused from another
      // clock, it keeps that clock's day count and names no zone, so the cut-over comes when the clock runs again.
      const days = l ? Math.max(0, tick - l.origin) / l.dayTicks : 0;
      payload = { dayConfig: { origin: Math.round(tick - days * PAUSED_TICKS), dayTicks: PAUSED_TICKS, customs: l?.customs ?? o.customs ?? [], ...(!l || l.zone ? { zone } : {}), ...(l?.cutOver ? { cutOver: l.cutOver } : {}) }, why: 'world clock: paused by the god' };
    } else {
      if (l && l.zone === zone && Math.abs(realClockDriftMs(l, tick, now(), zone)) < REALIGN_MS) return Promise.resolve();
      const c = realClockConfig(tick, now(), zone);
      payload = { ...c, dayConfig: { ...c.dayConfig, customs: l?.customs ?? o.customs ?? [], ...(l?.cutOver ? { cutOver: l.cutOver } : {}) } };
    }
    // a clock already on real time only moves its origin: the day's state (last day turn, event, quiet) is kept (world.ts).
    // Coming from another clock (the accelerated one, whose day numbers differ), the day state starts over.
    if (l?.zone) (payload as { realign?: boolean }).realign = true;
    const d = payload.dayConfig as { origin: number; dayTicks: number };
    // #1649 part 4: coming onto real time from another clock is the cut-over. The clock event names it (and later clock
    // events carry it on), so the mapping is finished after a failure or a restart.
    if (l && !l.zone && d.dayTicks === REAL_DAY_TICKS) payload.dayConfig.cutOver = { tick, from: { origin: l.origin, dayTicks: l.dayTicks }, to: { origin: d.origin, dayTicks: d.dayTicks } };
    pending = host.enqueue('rules', 'world', payload).then(() => { mapCut((host.living as { cutOver?: Cut } | undefined)?.cutOver); }).finally(() => { pending = undefined; });
    return pending.then(sync);
  };
  const schedule = () => { void sync().catch((e: Error) => o.log?.(`world clock: ${e.message}`)); };
  // #2297: the zone's next daylight-saving change is a deadline: the keeper logs a re-alignment there (cached until it passes)
  let dst: { zone: string; from: number; at: number | null } | undefined, dstFell = false;
  host.listeners?.push({ stillness: (tick) => {
    if (o.paused?.()) return [];
    const zone = o.zone(), t = now();
    if (dst && dst.at !== null && t >= dst.at) dstFell = true;   // #2303: the silent check below runs once for it
    if (!dst || dst.zone !== zone || (dst.at !== null && t >= dst.at) || (dst.at === null && t - dst.from > 86_400_000)) dst = { zone, from: t, at: nextOffsetChangeMs(t, zone) };
    return dst.at === null ? [] : [{ name: 'clock.daylight-saving', tick: tick + Math.max(1, Math.ceil((dst.at - t) / TICK_MS)) }];
  } });
  schedule();
  // #2303: a silent world (still, unwatched) keeps wall pace by jumping, so it does not drift; it is checked only once a
  // daylight-saving deadline has fallen (the world lands there and the next check re-aligns it)
  const timer = setInterval(() => {
    if (host.silent?.() && !(dstFell || (dst?.at != null && now() >= dst.at))) return;
    dstFell = false;
    if ((host.pace ?? 1) >= 1 && !host.paused && host.running !== false) schedule();
  }, o.checkMs ?? 15_000);
  timer.unref?.();
  return { sync, schedule, stop: () => clearInterval(timer) };
}

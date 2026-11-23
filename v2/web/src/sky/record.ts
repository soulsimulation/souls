// The sky as the record holds it (Engine v2 V19, #2763): E6's fields on the world's own node (`replica::sky`), read by
// the page's copy and kept as plain numbers and names. Local time is world time through the world's calendar, exactly
// as `replica::sky::Calendar::local` reads it: civil µs = origin + world µs · 86,400 / day length (rounded down), plus
// the zone's offset in force. Nothing here reads the page's clock.

/** E6's field numbers: the calendar (60–62), how the sky is drawn (88–91, V19c #3521: the month and day it is drawn
 *  on, the palette, the morning mist, and a creator's staged hour; the clock's mapping holds 66–68), the creator's last strike (69, #3695), the
 *  light (70, 71) and the weather (75–79). */
export const F = { dayS: 60, origin: 61, offsets: 62, skyDate: 88, palette: 89, mist: 90, skyHour: 91, strike: 69, light: 70, lightNext: 71, weather: 75, cloud: 76, rain: 77, wind: 78, weatherNext: 79 } as const;
const KEYS = Object.values(F);
const DAY_US = 86_400_000_000;

/** The world node's sky fields, as the replica's query gives them, plain (CBOR integers as numbers). */
export type SkyFields = Partial<Record<number, unknown>>;

const plain = (v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : Array.isArray(v) ? v.map(plain) : v);

/** The sky fields of a node's field map, or undefined when the node holds none (any node but the world's). */
export function skyFields(f: Map<number, unknown>): SkyFields | undefined {
  if (!f.has(F.dayS) && !f.has(F.light)) return undefined;
  const out: SkyFields = {};
  for (const k of KEYS) if (f.has(k)) out[k] = plain(f.get(k));
  return out;
}

export type SkyRecord = {
  /** World seconds in a calendar day; civil µs at world time 0; `[world µs, offset µs]` ascending. */
  dayS: number;
  origin: number;
  offsets: [number, number][];
  light: string | null;
  lightNext: number | null;
  weather: string | null;
  /** Levels 0 to 100, as the world announced them. */
  cloud: number;
  rain: number;
  wind: number;
  weatherNext: number | null;
  /** V19c (#3521): the month and day the sky is drawn on (today's `state.time.calendar`), else the calendar's own
   *  date; the palette's name (`souls:<palette>`); the morning mist `[peak, half-width]` µs after local midnight and
   *  its strength 0 to 100. Each null when the world has none. */
  skyDate: [number, number] | null;
  palette: string | null;
  mist: [number, number, number] | null;
  /** #3695: the creator's last lightning strike, `[x mm, z mm, world µs]` on the open ground, or null. */
  strike: [number, number, number] | null;
  /** A creator's staged hour (`souls-god time HH:MM`, `replica::sky::F_SKY_HOUR`): µs after local midnight the sky is
   *  drawn at, or null (none, or `souls:live`) for the world's own time. Display only: the world's clock is unchanged. */
  skyHour: number | null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pair = (v: unknown): [number, number] | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [m, d] = v.map(num);
  return m !== null && d !== null && m >= 1 && m <= 12 && d >= 1 && d <= MONTH_DAYS[m - 1] ? [m, d] : null;
};
const mist = (v: unknown): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [p, h, s] = v.map(num);
  return p !== null && h !== null && s !== null && p >= 0 && p < DAY_US && h > 0 && s >= 0 && s <= 100 ? [p, h, s] : null;
};

const hourOfDay = (v: unknown): number | null => {
  const h = num(v);
  return h !== null && Number.isInteger(h) && h >= 0 && h < DAY_US ? h : null;
};

const strike = (v: unknown): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, z, at] = v.map(num);
  return x !== null && z !== null && at !== null ? [x, z, at] : null;
};

/** The record's sky, or null before the world node holds its calendar. A world with a calendar and no weather yet
 *  reads clear (levels 0). */
export function readSky(f: SkyFields): SkyRecord | null {
  const dayS = num(f[F.dayS]), origin = num(f[F.origin]);
  const offsets = Array.isArray(f[F.offsets]) ? (f[F.offsets] as unknown[]).map((r) => (Array.isArray(r) ? [num(r[0]), num(r[1])] : [null, null])) : [];
  if (dayS === null || dayS <= 0 || origin === null || !offsets.length || offsets.some(([a, b]) => a === null || b === null)) return null;
  return {
    dayS, origin, offsets: offsets as [number, number][],
    light: text(f[F.light]), lightNext: num(f[F.lightNext]),
    weather: text(f[F.weather]), cloud: num(f[F.cloud]) ?? 0, rain: num(f[F.rain]) ?? 0, wind: num(f[F.wind]) ?? 0,
    weatherNext: num(f[F.weatherNext]),
    skyDate: pair(f[F.skyDate]), palette: text(f[F.palette]), mist: mist(f[F.mist]), strike: strike(f[F.strike]),
    skyHour: hourOfDay(f[F.skyHour]),
  };
}

/** The zone's offset in force at world time `t`, µs (the first row's before it). */
export function offsetAt(r: SkyRecord, t: number): number {
  let o = r.offsets[0][1];
  for (const [from, off] of r.offsets) if (from <= t) o = off;
  return o;
}

/** Local wall time at world time `t`, µs since 1970-01-01T00:00 local. */
export function localAt(r: SkyRecord, t: number): number {
  const civil = r.dayS === 86_400 ? r.origin + t : r.origin + Math.floor((t * 86_400) / r.dayS);
  return civil + offsetAt(r, t);
}

/** Local wall time at world time `t` as the sky is drawn: on the world's sky date when it has one (the clock's year
 *  and time of day), as today's page draws its sky, moon and stars on `calendarClock`'s clock. */
export function skyLocalAt(r: SkyRecord, t: number): number {
  const local = localAt(r, t);
  if (!r.skyDate) return local;
  const days = Math.floor(local / DAY_US), { y } = civil(local);
  return daysFromCivil(y, r.skyDate[0], r.skyDate[1]) * DAY_US + (local - days * DAY_US);
}

/** The day number (since 1970-01-01) of a civil date (H. Hinnant's `days_from_civil`, as `replica::sky`). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y, era = Math.floor(yy / 400), yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

/** The civil date and time of day of a local µs (H. Hinnant's `civil_from_days`, as `replica::sky`). Given the
 *  world's sky date (`skyDate`), the month and day are that date's and the year and hour the clock's, as today's
 *  `calendarClock` dates a world's sky. */
export function civil(local: number, skyDate: [number, number] | null = null): { y: number; m: number; d: number; hour: number } {
  const days = Math.floor(local / DAY_US);
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0), hour = (local - days * DAY_US) / 3_600_000_000;
  return skyDate ? { y, m: skyDate[0], d: skyDate[1], hour } : { y, m, d, hour };
}

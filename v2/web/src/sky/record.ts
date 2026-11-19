// The sky as the record holds it (Engine v2 V19, #2763): E6's fields on the world's own node (`replica::sky`), read by
// the page's copy and kept as plain numbers and names. Local time is world time through the world's calendar, exactly
// as `replica::sky::Calendar::local` reads it: civil µs = origin + world µs · 86,400 / day length (rounded down), plus
// the zone's offset in force. Nothing here reads the page's clock.

/** E6's field numbers: the calendar (60–62), the light (70, 71) and the weather (75–79). */
export const F = { dayS: 60, origin: 61, offsets: 62, light: 70, lightNext: 71, weather: 75, cloud: 76, rain: 77, wind: 78, weatherNext: 79 } as const;
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
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

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

/** The civil date and time of day of a local µs (H. Hinnant's `civil_from_days`, as `replica::sky`). */
export function civil(local: number): { y: number; m: number; d: number; hour: number } {
  const days = Math.floor(local / DAY_US);
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d, hour: (local - days * DAY_US) / 3_600_000_000 };
}

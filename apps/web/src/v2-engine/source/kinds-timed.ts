// X1 (0.134): copied from v2/web/src/kinds/timed.ts, so the old page's stream reader needs nothing from v2/web.
// A value that changes with time, on the page (#3871): the value-now function the world (replica's `timed.rs`) and
// today's viewer (packages/form-rules/src/rules.ts, `timed:begin`) share, ported here because this page imports nothing
// from packages/. A timed value is three whole numbers, `{value, per_s, set_us}`; its value at world time t is
// `clamp(clamp(value) + trunc(per_s × (t − set_us) / 1,000,000), min, max)`. Worked in big integers, so a long sleep
// never overflows; a number outside the signed 64-bit range is refused (`beyond_i64`), never wrapped. The shared cases
// are SA-F5a's `souls-timed-cases/1` (packages/form-rules/cases/timed), run by timed.test.ts.

export type Int = number | bigint;
export type Timed = { value: Int; per_s: Int; set_us: Int };
export type Bounds = { min?: Int; max?: Int };
type Exact = { v0: bigint; rate: bigint; set: bigint; at: bigint; lo: bigint | null; hi: bigint | null };
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A value stored as a timed field's three whole numbers. */
export const isTimed = (v: unknown): v is Timed => typeof v === 'object' && v !== null && !Array.isArray(v) && 'value' in v && 'per_s' in v && 'set_us' in v;

/** A whole number as a big integer; `null` if it is not one; `beyond` if it lies outside the signed 64-bit range. */
function big(v: unknown): bigint | null | 'beyond' {
  const b = typeof v === 'bigint' ? v : whole(v) ? BigInt(v) : null;
  return b === null ? null : b < I64_MIN || b > I64_MAX ? 'beyond' : b;
}

function exact(def: Bounds, stored: unknown, at: unknown): Exact | { bad: string } {
  if (!stored || typeof stored !== 'object') return { bad: 'not_timed' };
  const { value, per_s, set_us } = stored as Partial<Timed>;
  const three = [value, per_s, set_us].map(big);
  if (three.includes(null)) return { bad: 'not_whole_number' };
  const now = big(at);
  if (now === null) return { bad: 'no_time' };
  const bounds = [def.min, def.max].map((b) => (b === undefined ? undefined : big(b)));
  if (bounds.includes(null)) return { bad: 'not_whole_number' };
  if ([...three, now, ...bounds].includes('beyond')) return { bad: 'beyond_i64' };
  const [v0, rate, set] = three as bigint[];
  const [lo, hi] = bounds.map((b) => (b === undefined ? null : (b as bigint)));
  if ((now as bigint) < set) return { bad: 'time_before_set' };
  if (lo !== null && hi !== null && lo > hi) return { bad: 'bounds_crossed' };
  return { v0: clamp(v0, lo, hi), rate, set, at: now as bigint, lo, hi };
}

function clamp(v: bigint, lo: bigint | null, hi: bigint | null): bigint {
  if (lo !== null && v < lo) return lo;
  if (hi !== null && v > hi) return hi;
  return v;
}

/** A result: a number if it is a safe integer, a big integer beyond that, refused outside the signed 64-bit range. */
function out(v: bigint): Int | { bad: string } {
  if (v < I64_MIN || v > I64_MAX) return { bad: 'beyond_i64' };
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function at(x: Exact, t: bigint): bigint {
  return clamp(x.v0 + (x.rate * (t - x.set)) / 1000000n, x.lo, x.hi);
}

/** The value of a timed field at `now_us`: the whole units accrued since it was set, held within `min` and `max`. */
export function valueAt(def: Bounds, stored: unknown, now_us: unknown): Int | { bad: string } {
  const x = exact(def, stored, now_us);
  if ('bad' in x) return x;
  return out(at(x, x.at));
}

/** The first whole microsecond, at or after `from_us`, at which the value is `at_least` (or `at_most`) the level; `null`
 *  when it never does. */
export function crossing(def: Bounds, stored: unknown, level: { at_least?: Int; at_most?: Int }, from_us: unknown): Int | null | { bad: string } {
  const x = exact(def, stored, from_us);
  if ('bad' in x) return x;
  const rising = level && has(level, 'at_least') && !has(level, 'at_most');
  const falling = level && has(level, 'at_most') && !has(level, 'at_least');
  const L = big(rising ? level.at_least : falling ? level.at_most : undefined);
  if (L === null) return { bad: 'malformed_level' };
  if (L === 'beyond') return { bad: 'beyond_i64' };
  const now = at(x, x.at);
  if (rising ? now >= L : now <= L) return out(x.at);
  if (rising ? x.rate <= 0n || (x.hi !== null && x.hi < L) : x.rate >= 0n || (x.lo !== null && x.lo > L)) return null;
  const gap = rising ? L - x.v0 : x.v0 - L;
  const speed = rising ? x.rate : -x.rate;
  return out(x.set + (gap * 1000000n + speed - 1n) / speed);
}

// The world's clock on a copy (Engine v2 E7b, #3516): the mapping in force is three fields on the zone's root, which is
// in every Soul's scope, so a copy computes what world time it is now from its own records, with no request and no
// world time in the frames (`v2/crates/replica/src/time.rs`, `F_CLOCK_*`). The clock thread writes them with the
// mapping's time effect whenever a mapping applies (a first start, a restart at another rate), so a copy brought
// current after a rate change reads the new one.
//
//   world now = world + (real now − real) · num / den, rounded down (T5 rule 4), in µs.
//
// The real anchor is on the world's real line, µs from the Unix epoch as the world's machine read it; this machine's
// clock stands in for it. R15's scheduler and R15b's world-time triggers read `clockOf` and `worldNow`.

import { decode } from '../brief/copy.mjs';

export const F_CLOCK_WORLD = 66, F_CLOCK_REAL = 67, F_CLOCK_RATE = 68;

const big = (v) => (typeof v === 'bigint' ? v : Number.isSafeInteger(v) ? BigInt(v) : null);

/** The mapping a node's fields (a Map, as `decode` gives) hold, `{ world, real, rate: [num, den] }`, or null. */
export function clockOfFields(fields) {
  if (!(fields instanceof Map)) return null;
  const world = big(fields.get(F_CLOCK_WORLD)), real = big(fields.get(F_CLOCK_REAL)), rate = fields.get(F_CLOCK_RATE);
  if (world === null || real === null || !Array.isArray(rate) || rate.length !== 2) return null;
  const [num, den] = rate.map(big);
  if (num === null || den === null || num <= 0n || den <= 0n) return null;
  return { world: Number(world), real: Number(real), rate: [Number(num), Number(den)] };
}

/** The mapping the copy's root holds (the first scope node whose record has one), or null. */
export function clockOf(copy) {
  for (const hash of Object.values(JSON.parse(copy.roots()))) {
    const bytes = copy.record(hash);
    if (!bytes) continue;
    const m = decode(bytes);
    const c = clockOfFields(m instanceof Map ? m.get(6) : null);
    if (c) return c;
  }
  return null;
}

/** World µs at real µs `realUs` (default this machine's clock now) on `clock`'s line, rounded down; null without one. */
export function worldNow(clock, realUs = Date.now() * 1000) {
  if (!clock) return null;
  const p = (BigInt(Math.trunc(realUs)) - BigInt(clock.real)) * BigInt(clock.rate[0]), q = BigInt(clock.rate[1]);
  const floor = p >= 0n ? p / q : -((-p + q - 1n) / q);
  return Number(BigInt(clock.world) + floor);
}

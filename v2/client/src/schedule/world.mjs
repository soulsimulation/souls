// R15b (#3517): resolve a client's occurrence from the calendar published on its copy's root (E6/E7), then invert
// E7b's clock mapping for one real deadline. This reads no clock and keeps no world clock of its own.
import { decode } from '../brief/copy.mjs';
import { worldNow } from '../clock/clock.mjs';
import { due } from './schedule.mjs';

const DAY = 86_400_000_000n;
const floor = (p, q) => p >= 0n ? p / q : -((-p + q - 1n) / q);
const ceil = (p, q) => -floor(-p, q);
const integer = (n) => typeof n === 'bigint' || Number.isSafeInteger(n);

/** E6's calendar settings (fields 60–62), from the same root records as E7b's mapping. Missing settings stay inert. */
export function calendarOf(copy) {
  for (const hash of Object.values(JSON.parse(copy.roots()))) {
    const bytes = copy.record(hash);
    if (!bytes) continue;
    const fields = decode(bytes).get(6);
    if (!(fields instanceof Map)) continue;
    const day = fields.get(60), origin = fields.get(61), offsets = fields.get(62);
    if (!integer(day) || day <= 0 || !integer(origin) || !Array.isArray(offsets) || !offsets.length) continue;
    if (!offsets.every((p, i) => Array.isArray(p) && p.length === 2 && p.every(integer)
      && (i === 0 || p[0] >= offsets[i - 1][0]))) continue;
    return { day: BigInt(day), origin: BigInt(origin), offsets: offsets.map((p) => p.map(BigInt)) };
  }
  return null;
}

const localAt = (cal, world) => {
  let offset = cal.offsets[0][1];
  for (const [at, value] of cal.offsets) { if (at > world) break; offset = value; }
  return cal.origin + floor(world * 86_400n, cal.day) + offset;
};

/** The first world µs reaching a local time: the same rising-line inverse as replica::schedule::world_of. */
function worldAt(cal, local) {
  let best = null;
  for (const [, offset] of cal.offsets) {
    const world = ceil((local - cal.origin - offset) * cal.day, 86_400n);
    if (localAt(cal, world) >= local && (best === null || world < best)) best = world;
  }
  return best;
}

/** The next occurrence of HH:mm on the published calendar; persisted once so a restart cannot move it to tomorrow. */
export function nextWorldTime(time, cal, worldUs) {
  if (!cal || worldUs === null) return null;
  const world = BigInt(worldUs), local = localAt(cal, world);
  const [hour, minute] = time.split(':').map(BigInt);
  let target = floor(local, DAY) * DAY + (hour * 60n + minute) * 60_000_000n;
  if (target < local) target += DAY;
  let at = worldAt(cal, target);
  if (at !== null && at < world) at = worldAt(cal, target + DAY);
  return at === null ? null : Number(at);
}

/** The first real millisecond reaching a world µs on the current published mapping, rounded up. */
export function realDeadline(clock, worldUs) {
  if (!clock) return null;
  return Number(ceil(BigInt(clock.real) * BigInt(clock.rate[0])
    + (BigInt(worldUs) - BigInt(clock.world)) * BigInt(clock.rate[1]), BigInt(clock.rate[0]) * 1000n));
}

/** World entries through R15's existing real-time/missed rules. `targets` is the daemon's persisted occurrence map. */
export function worldDue(entries, marks, targets, clock, calendar, now, off = null) {
  const fire = [], missed = [];
  let next = null, resolved = false;
  if (!clock) return { fire, missed, next, resolved };
  const worldUs = worldNow(clock, now * 1000);
  for (const e of entries) {
    if (marks[e.key] || (!e.world && e.worldUs === undefined) || (e.until !== null && now > e.until)) continue;
    let occurrence = targets[e.key];
    if (occurrence === undefined) {
      const target = e.worldUs ?? nextWorldTime(e.world, calendar, worldUs);
      if (target === null) continue;
      occurrence = targets[e.key] = { worldUs: target, realMs: realDeadline(clock, target) };
      resolved = true;
    }
    // A new mapping moves a future deadline. A moment before that mapping keeps its prior real deadline, so a
    // restart/rate change does not reinterpret how late an already missed occurrence was.
    const real = occurrence.worldUs >= clock.world ? realDeadline(clock, occurrence.worldUs) : occurrence.realMs;
    if (real !== occurrence.realMs) { occurrence.realMs = real; resolved = true; }
    const d = due([{ ...e, real }], marks, now, off);
    fire.push(...d.fire.map((hit) => ({ ...hit, e })));
    missed.push(...d.missed.map((hit) => ({ ...hit, e })));
    if (real > now) next = next === null ? real : Math.min(next, real);
  }
  return { fire, missed, next, resolved };
}

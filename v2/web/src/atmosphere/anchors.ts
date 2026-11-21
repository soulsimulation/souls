// N-V7 (#3690): where the birds, gulls, ducks and butterflies go, from what the world already holds, never from a
// world's name. Today's `atmosphere/fauna.ts` placed Eden's flocks by hand and then moved landers, gulls, ducks and
// butterflies onto what a scan of the scene found (roofs, harbour, water, flowers). Here the same roles are filled from
// general facts of any world: its ground's extent and heights, its water areas, and the things whose kind sounds of
// birds, bees or waterfowl in the page's sound table (`sound/kinds.json`), so what is heard is what is seen.

/** A deterministic 0..1 hash of two integers (today's `weather.ts` hash01). */
export function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export type P3 = [number, number, number];
/** A flock: centre x, z (m), circle radius (m), altitude above the ground there (m), birds. */
export type Flock = [number, number, number, number, number];
export type Anchors = {
  flocks: Flock[];
  /** Where landers come down to peck (ground points, m). */
  perches: P3[];
  /** Water surface points for ducks. */
  water: P3[];
  /** Over the largest water: the gulls' circle centre (x, z, m), or null on a dry world. */
  gulls: [number, number] | null;
  /** Flower points for butterflies. */
  flowers: P3[];
};
export type Source = { pos: P3; sounds: readonly string[] };
export type Water = { level: number; points: [number, number][] };
export type AnchorInput = {
  /** The ground's extent `[minX, minZ, maxX, maxZ]` (m), or null before the ground has arrived. */
  extent: [number, number, number, number] | null;
  heightAt: (x: number, z: number) => number | null;
  water: readonly Water[];
  sources: readonly Source[];
};

/** Today's flock count over Eden's ~200 m town (six); a larger world gets more, a small one at least two. */
const FLOCK_SPACING = 40, MIN_FLOCKS = 2, MAX_FLOCKS = 8;
export const MAX_PERCHES = 16, MAX_WATER = 24, MAX_FLOWERS = 24;

function inside(poly: readonly [number, number][], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function area(poly: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}
const inWater = (water: readonly Water[], x: number, z: number) => water.some((w) => inside(w.points, x, z));
/** Every `n`th of a list, so a long list is thinned evenly (and the same way each time). */
const spread = <T>(a: readonly T[], max: number): T[] => (a.length <= max ? [...a] : Array.from({ length: max }, (_, i) => a[Math.floor((i * a.length) / max)]));

/** The fauna's anchors for a world: the same input gives the same anchors. */
export function faunaAnchors(input: AnchorInput): Anchors {
  const { extent, heightAt, water, sources } = input;
  const out: Anchors = { flocks: [], perches: [], water: [], gulls: null, flowers: [] };
  if (!extent) return out;
  const [x0, z0, x1, z1] = extent, w = x1 - x0, d = z1 - z0;
  if (!(w > 0 && d > 0)) return out;
  const seed = Math.round(w * 7 + d * 13) | 0;
  let k = 0;
  const r = () => hash01(seed, k++);
  const land = (x: number, z: number) => heightAt(x, z) !== null && !inWater(water, x, z);
  // Flocks circle over land, within the world's ground (kept a radius in from its edge).
  const flocks = Math.max(MIN_FLOCKS, Math.min(MAX_FLOCKS, Math.round(Math.sqrt(w * d) / FLOCK_SPACING)));
  for (let f = 0, tries = 0; f < flocks && tries < flocks * 12; tries++) {
    const radius = 14 + r() * 12, mx = Math.min(radius, w / 4), mz = Math.min(radius, d / 4);
    const x = x0 + mx + r() * (w - 2 * mx), z = z0 + mz + r() * (d - 2 * mz);
    const alt = 12 + r() * 12, birds = 5 + Math.floor(r() * 3);
    if (!land(x, z)) continue;
    out.flocks.push([x, z, radius, alt, birds]);
    f++;
  }
  // Landers come down where birds are heard (a fountain's birdsong), else on open ground near the world's middle.
  const birdy = sources.filter((s) => s.sounds.includes('birds'));
  for (const s of spread(birdy, MAX_PERCHES)) {
    for (let i = 0; i < 2 && out.perches.length < MAX_PERCHES; i++) {
      const a = r() * Math.PI * 2, rr = 3 + r() * 5, x = s.pos[0] + Math.cos(a) * rr, z = s.pos[2] + Math.sin(a) * rr, y = heightAt(x, z);
      if (y !== null && land(x, z)) out.perches.push([x, y + 0.02, z]);
    }
  }
  for (let tries = 0; out.perches.length < 4 && tries < 40; tries++) {
    const x = x0 + w * (0.35 + r() * 0.3), z = z0 + d * (0.35 + r() * 0.3), y = heightAt(x, z);
    if (y !== null && land(x, z)) out.perches.push([x, y + 0.02, z]);
  }
  // Ducks paddle on open water, and where waterfowl are heard; gulls circle the largest water.
  let biggest: Water | null = null, most = 0;
  for (const wa of water) {
    const a = area(wa.points);
    if (a > most) (most = a), (biggest = wa);
  }
  const pond: P3[] = [];
  for (const wa of water) {
    const share = Math.max(1, Math.round((MAX_WATER * area(wa.points)) / Math.max(1, water.reduce((s, v) => s + area(v.points), 0))));
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const [x, z] of wa.points) (bx0 = Math.min(bx0, x)), (bz0 = Math.min(bz0, z)), (bx1 = Math.max(bx1, x)), (bz1 = Math.max(bz1, z));
    for (let n = 0, tries = 0; n < share && tries < share * 10; tries++) {
      const x = bx0 + r() * (bx1 - bx0), z = bz0 + r() * (bz1 - bz0);
      if (inside(wa.points, x, z)) (pond.push([x, wa.level, z]), n++);
    }
  }
  for (const s of sources) if (s.sounds.includes('waterfowl')) pond.push([s.pos[0], s.pos[1], s.pos[2]]);
  out.water = spread(pond, MAX_WATER);
  if (biggest && most >= 400) {
    let cx = 0, cz = 0;
    for (const [x, z] of biggest.points) (cx += x), (cz += z);
    out.gulls = [cx / biggest.points.length, cz / biggest.points.length];
  }
  // Butterflies over what hums with bees (gardens, wildflowers).
  out.flowers = spread(sources.filter((s) => s.sounds.includes('bees')).map((s) => [s.pos[0], s.pos[1] + 0.3, s.pos[2]] as P3), MAX_FLOWERS);
  return out;
}

/** Today's visibility of each kind of creature for the weather (`WorldAtmosphere`'s birds and butterflies; ducks while
 *  motion is allowed). Reduced motion shows none. */
export function faunaLevels(s: { daylight: number; rain: number; cloud: number; wind: number; fogLevel: number }, reduced: boolean): { birds: number; butterflies: number; ducks: number } {
  if (reduced) return { birds: 0, butterflies: 0, ducks: 0 };
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return {
    birds: c((s.daylight - 0.15) / 0.35) * (1 - s.rain * 0.9) * (1 - s.fogLevel * 0.6) * (1 - Math.max(0, s.wind - 0.7) * 1.5),
    butterflies: c((s.daylight - 0.4) / 0.3) * (1 - s.rain) * (1 - s.cloud * 0.5) * (1 - s.wind * 0.6),
    ducks: 1,
  };
}

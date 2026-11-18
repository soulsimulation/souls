import { rot2, type OBB2, type Vec2 } from '../../../../mars/viewer/engine/core/math.ts';

/** Longest piece (m) a world-frame solid on uneven ground is cut into. */
export const SLOPE_PIECE_M = 1;
/** Terrain spread (m) under a solid below which it stays one prism, exactly as before. */
export const SLOPE_TOL_M = 0.05;

/**
 * #2193: a world-frame solid (a wall, fence or hedge along a path, L3) is drawn on the terrain along its whole length, but
 * its collider is one prism at the height of the terrain under its centre (world-compiler footprint). On a slope the
 * prism's uphill part sank under the ground, out of the body band the walk raster reads (above the step height), so a
 * 40 m vine row on a hillside blocked only near its middle and Souls walked through the rest. Where the terrain under the
 * solid spreads more than SLOPE_TOL_M, it is cut along its long axis into pieces of at most SLOPE_PIECE_M, each spanning
 * from the lowest ground under it plus `y0` to the highest plus `y1`. Null when it stays as it is (flat ground, or
 * nothing to cut). `obb` is the engine's (yaw already negated); `y0`/`y1` are ground-relative.
 */
export function slopePieces(obb: OBB2, y0: number, y1: number, ground: (x: number, z: number) => number): { obb: OBB2; y0: number; y1: number }[] | null {
  const long = obb.half[0] >= obb.half[1] ? 0 : 1, across = 1 - long, len = 2 * obb.half[long];
  const axis = rot2(long === 0 ? [1, 0] : [0, 1], obb.yaw), side = rot2(long === 0 ? [0, 1] : [1, 0], obb.yaw);
  const at = (t: number, s: number): Vec2 => [obb.c[0] + axis[0] * t + side[0] * s, obb.c[1] + axis[1] * t + side[1] * s];
  /** lowest and highest ground under the stretch [a, b] of the long axis (centre line and both long faces, every 0.25 m) */
  const span = (a: number, b: number): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    const n = Math.max(1, Math.ceil((b - a) / 0.25));
    for (let k = 0; k <= n; k++) for (const s of [-obb.half[across], 0, obb.half[across]]) {
      const p = at(a + ((b - a) * k) / n, s), h = ground(p[0], p[1]);
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return [lo, hi];
  };
  const [lo, hi] = span(-obb.half[long], obb.half[long]);
  if (!(hi - lo > SLOPE_TOL_M) || len <= 1e-6) return null;
  const n = Math.max(1, Math.ceil(len / SLOPE_PIECE_M - 1e-9)), step = len / n, r3 = (v: number) => Math.round(v * 1000) / 1000;
  const out: { obb: OBB2; y0: number; y1: number }[] = [];
  for (let k = 0; k < n; k++) {
    const a = -obb.half[long] + k * step, b = a + step, [l, h] = span(a, b), c = at((a + b) / 2, 0);
    const half: Vec2 = [obb.half[0], obb.half[1]]; half[long] = r3(step / 2);
    out.push({ obb: { c: [r3(c[0]), r3(c[1])], half, yaw: obb.yaw }, y0: r3(l + y0), y1: r3(h + y1) });
  }
  return out;
}

/**
 * #2193: the climb of a building/1 straight flight whose foot or head is entered from the side. The generator's link path
 * is approach, flight bottom, flight top, arrival; the engine link was the straight line from the approach to the arrival,
 * rising all the way. Where both ends are entered from the side (a cottage flight between two end walls), that line runs
 * half a metre outside the flight, so a Soul rose through the air beside the stairs and up through the floor beside the
 * stairwell. Here the climb follows the flight: level from the approach to the bottom step, up the flight, level from the
 * top step to the arrival. Null when the flight already lies on the straight line (it climbs as before).
 */
export function flightPath(a: Vec2, bottom: Vec2, top: Vec2, b: Vec2, ya: number, yb: number): [number, number, number][] | null {
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
  const off = (p: Vec2) => (len ? Math.abs((p[0] - a[0]) * dz - (p[1] - a[1]) * dx) / len : Math.hypot(p[0] - a[0], p[1] - a[1]));
  if (off(bottom) <= 0.05 && off(top) <= 0.05) return null;
  const r3 = (v: number) => Math.round(v * 1000) / 1000, n = Math.max(1, Math.ceil(Math.abs(yb - ya) / 0.18));
  const path: [number, number, number][] = [[r3(a[0]), r3(ya), r3(a[1])]];
  for (let k = 0; k <= n; k++) { const t = k / n; path.push([r3(bottom[0] + (top[0] - bottom[0]) * t), r3(ya + (yb - ya) * t), r3(bottom[1] + (top[1] - bottom[1]) * t)]); }
  path.push([r3(b[0]), r3(yb), r3(b[1])]);
  return path;
}

// A room's ways through, for furnish (#3728, today's lane SEALED check in `tools/god-skill/lib/furnish.mjs`): every
// doorway and stair end on a room's floor, and every standing piece's approach, stay reachable from each other, and a
// new piece's own approach is reached from a doorway. A piece whose pose cuts them apart tries its next pose or is
// dropped. The rule is today's (`packages/generators/src/clearance.ts`): a body needs 0.43 m from a wall and 0.50 m
// from a piece of furniture. Here on a 0.1 m grid of the room's outline in the building's frame, mm; boxes are
// axis-aligned [x0, z0, x1, z1].

const CELL = 100, WALL = 430, PIECE = 500, REACH = 1200;

const inside = (poly, x, z) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const toSegment = ([x, z], [ax, az], [bx, bz]) => {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
};
const toBox = ([x, z], b) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]));

/**
 * The ways of a room: its `outline` (building frame, mm), its `doors` ([{ c: [x, z], width }] on its level, those on
 * its walls kept) and stair `ends` ([x, z] inside it). `ok(pieces, box)` says whether `box` keeps every way `pieces`
 * (boxes standing there, each reached at its `fronts` point when known) leave, with its own approach (`front`) reached
 * from a doorway: { ok } or { ok: false, why }.
 */
export function waysOf(outline, doors, ends) {
  const xs = outline.map((p) => p[0]), zs = outline.map((p) => p[1]);
  const x0 = Math.min(...xs), z0 = Math.min(...zs), nx = Math.ceil((Math.max(...xs) - x0) / CELL), nz = Math.ceil((Math.max(...zs) - z0) / CELL);
  const edges = outline.map((p, i) => [p, outline[(i + 1) % outline.length]]);
  const mine = doors.filter((d) => edges.some(([a, b]) => toSegment(d.c, a, b) < 300));
  const centre = (i, j) => [x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL];
  // The cells a body can stand in, the room's walls alone: inside, clear of a wall unless in a doorway's gap.
  const base = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const c = centre(i, j);
    if (!inside(outline, c[0], c[1])) continue;
    const gap = mine.some((d) => Math.hypot(c[0] - d.c[0], c[1] - d.c[1]) < d.width / 2 + 100);
    if (!gap && edges.some(([a, b]) => toSegment(c, a, b) < WALL)) continue;
    base[j * nx + i] = 1;
  }
  const grid = (boxes) => {
    const g = base.slice();
    for (const b of boxes) {
      const i0 = Math.max(0, Math.floor((b[0] - PIECE - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((b[2] + PIECE - x0) / CELL));
      const j0 = Math.max(0, Math.floor((b[1] - PIECE - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((b[3] + PIECE - z0) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (g[j * nx + i] && toBox(centre(i, j), b) < PIECE) g[j * nx + i] = 0;
    }
    return g;
  };
  const labels = (g) => {
    const l = new Int32Array(nx * nz).fill(-1);
    let n = 0;
    for (let k = 0; k < g.length; k++) {
      if (!g[k] || l[k] >= 0) continue;
      const todo = [k];
      l[k] = n;
      while (todo.length) {
        const q = todo.pop(), i = q % nx, j = (q - i) / nx;
        for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
          if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
          const m = b * nx + a;
          if (g[m] && l[m] < 0) { l[m] = n; todo.push(m); }
        }
      }
      n++;
    }
    return l;
  };
  // The free cell nearest a point within reach (a doorway, a stair end, the side of a piece), or -1.
  const near = (g, test) => {
    let best = -1, d = REACH;
    for (let k = 0; k < g.length; k++) {
      if (!g[k]) continue;
      const e = test(centre(k % nx, Math.floor(k / nx)));
      if (e < d) { d = e; best = k; }
    }
    return best;
  };
  // A piece is reached at its approach: the free spot nearest its front (today's `approachKeys`), else nearest it.
  const at = (p) => (c) => Math.hypot(c[0] - p[0], c[1] - p[1]);
  const approach = (g, b, front) => near(g, front ? at(front) : (c) => toBox(c, b));
  const keysOf = (g, pieces, fronts) => [...mine.map((d) => near(g, at(d.c))), ...ends.map((p) => near(g, at(p))), ...pieces.map((b, i) => approach(g, b, fronts[i]))];
  const pairs = (l, keys) => {
    let n = 0;
    for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) if (keys[a] >= 0 && keys[b] >= 0 && l[keys[a]] === l[keys[b]]) n++;
    return n;
  };
  return {
    doors: mine.length,
    ok(pieces, box, fronts = [], front = null) {
      if (!mine.length) return { ok: true };
      const was = grid(pieces), now = grid([...pieces, box]);
      const before = pairs(labels(was), keysOf(was, pieces, fronts));
      const ln = labels(now), keys = keysOf(now, pieces, fronts);
      if (pairs(ln, keys) < before) return { ok: false, why: 'would cut the way to its doors or another piece' };
      const own = approach(now, box, front), doorKeys = keys.slice(0, mine.length).filter((k) => k >= 0);
      if (own < 0 || !doorKeys.some((k) => ln[k] === ln[own])) return { ok: false, why: 'no way to it from the doors' };
      return { ok: true };
    },
  };
}

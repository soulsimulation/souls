// legal-edits/2 (#2188): a god edit that would leave a Soul with no walk out is refused by name before it commits. The
// preview (edit-preview.ts) judges each body by the geometry round it, so it does not see a ring of walls closed at a
// distance; the walk-out planner sees only what an edit lands on. This check is the missing one, and the pocket rule is
// nav-connect/1's: a Soul is sealed in when the free ground she stands on is cut off from everything else and holds at most
// NAV_RESCUE_MAX_POCKET m² (a larger walled area is a place to live in, which nav-connect never steps anyone out of either).
//
// Model-only and local, on BUILDSAFE's raster (buildsafe.ts: the ways rule's body radius on a 0.1 m grid, ground level):
//  - only an edit that adds or moves blocking geometry at ground level is looked at; a removal never seals anyone in;
//  - a pocket the edit seals is bounded by what it added, so the check looks in windows SEAL_R round the added pieces
//    (nearby pieces share one window), and only at Souls on the ground inside one (none: nothing is rastered at all);
//  - one grid per window, after the edit; the free cells joined to each Soul are flooded, and Souls in one region share
//    one flood. A flood that reaches the window's edge, or more than the pocket's area, is a walk out;
//  - a Soul sealed after: the same flood on the window before the edit (rastered once, only then); if she had a walk out
//    then, this edit takes it away, and is refused. No standing room before or after is the preview's to judge.
// Not seen (known limits, nav-connect/1's step-out stays as the safety net for them): bodies on upper floors, a pocket that
// reaches more than SEAL_R from the pieces that close it (a long thin pen), and a single piece longer than MAX_PIECE.
import type { Diff, WorldModel } from '@souls/world-compiler';
import { NAV_RESCUE_MAX_POCKET } from '../../../../mars/viewer/engine/spatial/connectivity.ts';
import { CELL } from './buildsafe-rule.ts';
import { Grid, blocking, withRooms } from './buildsafe.ts';

/** How far round the edit's pieces (m) the check looks: holds a square pocket of the rule's area (50 m a side) that the
 *  pieces border, with room to spare. */
export const SEAL_R = 56;
/** The free ground (m²) at most of a pocket that seals a Soul in: nav-connect/1's rescue bound. */
export const SEAL_MAX_POCKET = NAV_RESCUE_MAX_POCKET;
/** Pieces whose windows merge into one while it stays at most this wide (m), and the longest piece looked at. */
const MAX_WINDOW = 2 * SEAL_R + 16, MAX_PIECE = 64;

export type SealResident = { body: string; soulId: string; name: string; p: [number, number]; level?: number };
export type Sealed = { body: string; soulId: string; name: string; at: [number, number]; pocket: number; by: string[] };
type Box = ReturnType<typeof blocking>[number];
type Rect = [number, number, number, number];

/** The edit's blocking boxes at ground level, by entity: what it added or moved (a footprint unchanged is not looked at). */
function added(before: WorldModel, after: WorldModel, diff: Diff): Map<string, Box[]> {
  const out = new Map<string, Box[]>();
  for (const e of diff.upserts) {
    const was = before.entities.get(e.id);
    if (was && JSON.stringify([was.p, was.r, was.s, was.shape, was.params, was.in, was.def]) === JSON.stringify([e.p, e.r, e.s, e.shape, e.params, e.in, e.def])) continue;
    let b: Box[]; try { b = blocking(after, e.id); } catch { continue; }
    if (b.length) out.set(e.id, b);
  }
  return out;
}
function boundsOf(boxes: Box[]): Rect {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of boxes) {
    const c = Math.abs(Math.cos(b.yaw)), s = Math.abs(Math.sin(b.yaw)), rx = c * b.half[0] + s * b.half[1], rz = s * b.half[0] + c * b.half[1];
    x0 = Math.min(x0, b.c[0] - rx); z0 = Math.min(z0, b.c[1] - rz); x1 = Math.max(x1, b.c[0] + rx); z1 = Math.max(z1, b.c[1] + rz);
  }
  return [x0, z0, x1, z1];
}
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const near = (r: Rect, p: [number, number], d: number) => Math.hypot(Math.max(0, r[0] - p[0], p[0] - r[2]), Math.max(0, r[1] - p[1], p[1] - r[3])) <= d;
/** The window's ground blockers in `m`. */
function gridIn(m: WorldModel, rect: Rect): Grid {
  const win = { c: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], half: [(rect[2] - rect[0]) / 2, (rect[3] - rect[1]) / 2], yaw: 0, y0: -1e4, y1: 1e4 };
  const g = new Grid(rect);
  for (const id of m.near([win as never])) { let b: Box[]; try { b = blocking(m, id); } catch { continue; } if (b.length) g.mark(b, 1); }
  return g;
}
/** The free cell nearest p within r (−1: none). */
function standCell(g: Grid, p: [number, number], r = 1): number {
  let best = -1, bd = Infinity;
  const i0 = Math.max(0, Math.floor((p[0] - g.x0 - r) / CELL)), i1 = Math.min(g.nx - 1, Math.floor((p[0] - g.x0 + r) / CELL));
  const j0 = Math.max(0, Math.floor((p[1] - g.z0 - r) / CELL)), j1 = Math.min(g.nz - 1, Math.floor((p[1] - g.z0 + r) / CELL));
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const q = i * g.nz + j; if (g.cnt[q]) continue;
    const d = Math.hypot(g.x0 + (i + 0.5) * CELL - p[0], g.z0 + (j + 0.5) * CELL - p[1]); if (d <= r && d < bd) { bd = d; best = q; }
  }
  return best;
}
/** Floods of one grid, shared by the Souls standing in it: each region is flooded once. */
class Floods {
  private g: Grid; private lab: Uint16Array; private area: (number | null)[] = [0]; private st: Int32Array;
  private readonly cap = Math.ceil(SEAL_MAX_POCKET / (CELL * CELL));
  constructor(g: Grid) { this.g = g; this.lab = new Uint16Array(g.nx * g.nz); this.st = new Int32Array(Math.min(g.nx * g.nz, 3 * this.cap + 8)); }
  /** The pocket's area (m²) of the region joined to `from`, or null: a walk out (the window's edge, more than the rule's
   *  area, or a region an earlier flood found open). */
  pocketOf(from: number): number | null {
    if (this.lab[from]) return this.area[this.lab[from]];
    const { nx, nz, cnt } = this.g, lab = this.lab, st = this.st, id = this.area.length;
    if (id > 0xfffe) return null;
    this.area.push(null);
    let top = 0, n = 0; st[top++] = from; lab[from] = id;
    while (top) {
      const q = st[--top], i = (q / nz) | 0, j = q - i * nz;
      if (++n > this.cap || i === 0 || j === 0 || i === nx - 1 || j === nz - 1) return null;
      // a cell an earlier flood labelled is in a region it left open (a sealed one is labelled whole, so never met)
      let k = q - nz; if (!cnt[k] && lab[k] !== id) { if (lab[k]) return null; lab[k] = id; st[top++] = k; }
      k = q + nz; if (!cnt[k] && lab[k] !== id) { if (lab[k]) return null; lab[k] = id; st[top++] = k; }
      k = q - 1; if (!cnt[k] && lab[k] !== id) { if (lab[k]) return null; lab[k] = id; st[top++] = k; }
      k = q + 1; if (!cnt[k] && lab[k] !== id) { if (lab[k]) return null; lab[k] = id; st[top++] = k; }
    }
    return (this.area[id] = Math.round(n * CELL * CELL));
  }
}

/** The ground residents `after` seals in that `before` did not (empty: none). Pure; reads only the two models. */
export function sealedBy(before: WorldModel, after: WorldModel, diff: Diff, residents: Iterable<SealResident>): Sealed[] {
  const boxes = added(before, after, diff); if (!boxes.size) return [];
  const ground = [...residents].filter((r) => !r.level); if (!ground.length) return [];
  // windows: each piece's bounds SEAL_R round, merged with a neighbour's while the window stays at most MAX_WINDOW wide
  const wins: { pieces: Rect; ids: string[] }[] = [];
  for (const [id, b] of boxes) {
    const r = boundsOf(b); if (r[2] - r[0] > MAX_PIECE || r[3] - r[1] > MAX_PIECE) continue;
    const w = wins.find((x) => { const u = union(x.pieces, r); return u[2] - u[0] + 2 * SEAL_R <= MAX_WINDOW && u[3] - u[1] + 2 * SEAL_R <= MAX_WINDOW; });
    if (w) { w.pieces = union(w.pieces, r); w.ids.push(id); } else wins.push({ pieces: r, ids: [id] });
  }
  const out: Sealed[] = [], done = new Set<string>();
  for (const w of wins) {
    const who = ground.filter((r) => !done.has(r.body) && near(w.pieces, r.p, SEAL_R - 1)); if (!who.length) continue;
    const rect = withRooms([before, after], [w.pieces[0] - SEAL_R, w.pieces[1] - SEAL_R, w.pieces[2] + SEAL_R, w.pieces[3] + SEAL_R]);
    const ga = gridIn(after, rect), fa = new Floods(ga);
    let fb: { g: Grid; f: Floods } | null = null;
    for (const r of who) {
      const qa = standCell(ga, r.p); if (qa < 0) continue;   // no standing room: the preview's to judge
      const pocket = fa.pocketOf(qa); if (pocket === null) continue;
      if (!fb) { const g = gridIn(before, rect); fb = { g, f: new Floods(g) }; }
      const qb = standCell(fb.g, r.p);
      if (qb < 0 || fb.f.pocketOf(qb) !== null) continue;   // no standing room, or sealed in before this edit too: not this edit's doing
      done.add(r.body);
      const by = w.ids.filter((id) => boxes.get(id)!.some((b) => near(boundsOf([b]), r.p, SEAL_R)));
      out.push({ body: r.body, soulId: r.soulId, name: r.name, at: r.p, pocket, by: by.length ? by : w.ids });
    }
  }
  return out;
}

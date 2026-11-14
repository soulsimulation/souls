// legal-edits/2 (#2188): a god edit that would leave a Soul with no walk out is refused by name before it commits. The
// preview (edit-preview.ts) judges each body by the geometry round it, so it does not see a ring of walls closed at a
// distance; the walk-out planner sees only what an edit lands on. This check is the missing one, and the pocket rule is
// nav-connect/1's: a Soul is sealed in when the free ground she stands on is cut off from everything else and holds at most
// NAV_RESCUE_MAX_POCKET m² (a larger walled area is a place to live in, which nav-connect never steps anyone out of either).
//
// Model-only and local, on BUILDSAFE's raster (buildsafe.ts: the ways rule's body radius on a 0.1 m grid, ground level):
//  - only an edit that adds or moves blocking geometry at ground level is looked at; a removal never seals anyone in;
//  - only Souls on the ground within SEAL_R of that geometry are looked at (none near: nothing is rastered at all);
//  - for each, the free cells joined to where she stands are flooded in a window SEAL_R round her, after the edit; the flood
//    stops as soon as it reaches the window's edge or more than the pocket's area (she has a walk out);
//  - sealed after: the same flood before the edit; if she had a walk out then, this edit takes it away, and is refused.
// Not seen (known limits, nav-connect/1's step-out stays as the safety net for them): bodies on upper floors, and a pocket
// no larger than the rule's area that reaches more than SEAL_R from her (a long thin pen).
import type { Diff, WorldModel } from '@souls/world-compiler';
import { NAV_RESCUE_MAX_POCKET } from '../../../../mars/viewer/engine/spatial/connectivity.ts';
import { CELL } from './buildsafe-rule.ts';
import { Grid, blocking, withRooms } from './buildsafe.ts';

/** How far round a Soul (m) the check looks: a window 2·SEAL_R a side, which holds any square pocket of the rule's area
 *  wherever she stands in it (50 m a side) with room to spare. */
export const SEAL_R = 56;
/** The free ground (m²) at most of a pocket that seals a Soul in: nav-connect/1's rescue bound. */
export const SEAL_MAX_POCKET = NAV_RESCUE_MAX_POCKET;

export type SealResident = { body: string; soulId: string; name: string; p: [number, number]; level?: number };
export type Sealed = { body: string; soulId: string; name: string; at: [number, number]; pocket: number; by: string[] };
type Box = ReturnType<typeof blocking>[number];

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
const reachOf = (b: Box) => { const c = Math.abs(Math.cos(b.yaw)), s = Math.abs(Math.sin(b.yaw)); return [c * b.half[0] + s * b.half[1], s * b.half[0] + c * b.half[1]]; };
/** Distance (m) from p to the box's axis-aligned bounds. */
function distTo(b: Box, p: [number, number]): number {
  const [rx, rz] = reachOf(b);
  return Math.hypot(Math.max(0, Math.abs(p[0] - b.c[0]) - rx), Math.max(0, Math.abs(p[1] - b.c[1]) - rz));
}
/** The window's ground blockers in `m`. */
function gridIn(m: WorldModel, rect: [number, number, number, number]): Grid {
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
/** Flood the free cells joined to `from`: the pocket's area (m²), or null when it reaches the window's edge or more than the
 *  rule's area (a walk out). */
function pocketOf(g: Grid, from: number): number | null {
  // the grid is this check's own: a visited cell is marked blocked
  const { nx, nz, cnt } = g, cap = Math.ceil(SEAL_MAX_POCKET / (CELL * CELL)), st = new Int32Array(Math.min(nx * nz, 3 * cap + 8));   // each cell popped pushes at most 3 new ones
  let top = 0, n = 0; st[top++] = from; cnt[from] = 1;
  while (top) {
    const q = st[--top], i = (q / nz) | 0, j = q - i * nz;
    if (++n > cap || i === 0 || j === 0 || i === nx - 1 || j === nz - 1) return null;
    if (!cnt[q - nz]) { cnt[q - nz] = 1; st[top++] = q - nz; }
    if (!cnt[q + nz]) { cnt[q + nz] = 1; st[top++] = q + nz; }
    if (!cnt[q - 1]) { cnt[q - 1] = 1; st[top++] = q - 1; }
    if (!cnt[q + 1]) { cnt[q + 1] = 1; st[top++] = q + 1; }
  }
  return Math.round(n * CELL * CELL);
}

/** The ground residents `after` seals in that `before` did not (empty: none). Pure; reads only the two models. */
export function sealedBy(before: WorldModel, after: WorldModel, diff: Diff, residents: Iterable<SealResident>): Sealed[] {
  const boxes = added(before, after, diff); if (!boxes.size) return [];
  const out: Sealed[] = [];
  for (const r of residents) {
    if (r.level) continue;
    const by = [...boxes].filter(([, b]) => b.some((x) => distTo(x, r.p) <= SEAL_R)).map(([id]) => id);
    if (!by.length) continue;
    const rect = withRooms([before, after], [r.p[0] - SEAL_R, r.p[1] - SEAL_R, r.p[0] + SEAL_R, r.p[1] + SEAL_R]);
    const ga = gridIn(after, rect), qa = standCell(ga, r.p); if (qa < 0) continue;   // no standing room: the preview's to judge
    const pocket = pocketOf(ga, qa); if (pocket === null) continue;
    const gb = gridIn(before, rect), qb = standCell(gb, r.p);
    if (qb >= 0 && pocketOf(gb, qb) !== null) continue;   // sealed in before this edit too: not this edit's doing
    out.push({ body: r.body, soulId: r.soulId, name: r.name, at: r.p, pocket, by });
  }
  return out;
}

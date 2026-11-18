// Engine v2 N18 (#2658): today's reachability labels for every place in the catalog of a world built from the Eden 2026
// template, made by today's code. N18's one-off label producer (PR #3079's body), kept here for timed-run's v2-bench
// prep `eden-facts` (#3185), never under v2/ (v2/ never imports today's engine). It runs from the root of the ref under
// measurement and imports that ref's code, so it reads the ref's engine, not this workflow commit's. Fake minds, an
// in-memory database, an isolated data folder, no port. Writes the labels v2/tools/compare-reach and N15's walkers read.
//   DATA_DIR=<dir> BRAIN_MODE=fake node <this file> [--out <file>]     (cwd: a checkout's root; default
//   .local/compare-reach/labels.json)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = pathToFileURL(`${process.cwd()}/`);
const from = (p: string) => import(new URL(p, root).href);
const { bootEden } = await from('apps/server/test/eden-capabilities-timing.ts');
const { ledgerCatalog } = await from('apps/server/src/edge/catalog/routes.ts');
const { obbCorners } = await from('mars/viewer/engine/core/math.ts');
const { MEDIUM_NAMES } = await from('mars/viewer/engine/spatial/ground.ts');
const { groundField } = await from('packages/engine-mars/src/ground-bridge.ts');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : '.local/compare-reach/labels.json';

type V2 = [number, number];
type Verdict = { id: string; ok: boolean; code?: string; door?: true; area?: string; pocket?: number; floor?: string };
type Eng = {
  navWarmV1(ms: number): boolean;
  navCheckV1(xs: { id: string; p: V2; level: number; tol: number }[]): Verdict[];
  exportStaticScene(): { arrival: V2; levels: { id: number; y: number }[]; surfaces: { id: string; level: number; y: number; obb: { c: V2; half: V2; yaw: number } }[] };
  world: { entities: Record<string, { pose: { p: number[] } }>; groundV1?: { recipeHash: string } };
};

const inPoly = (x: number, z: number, poly: V2[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
};
/** The place's point: its outline's area centroid when that lies inside, else the 1 m grid point (cell centres) inside
 *  the outline nearest the centroid. Chosen from the outline alone, never from either engine's labels. */
function pointOf(poly: V2[]): V2 {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x0, z0] = poly[j]!, [x1, z1] = poly[i]!, k = x0 * z1 - x1 * z0;
    a += k; cx += (x0 + x1) * k; cz += (z0 + z1) * k;
  }
  const c: V2 = Math.abs(a) > 1e-9 ? [cx / (3 * a), cz / (3 * a)] : [poly[0]![0], poly[0]![1]];
  if (inPoly(c[0], c[1], poly)) return c;
  const xs = poly.map(v => v[0]), zs = poly.map(v => v[1]);
  let best: V2 | null = null, bd = Infinity;
  for (let x = Math.floor(Math.min(...xs)) + 0.5; x < Math.max(...xs); x += 1)
    for (let z = Math.floor(Math.min(...zs)) + 0.5; z < Math.max(...zs); z += 1) {
      if (!inPoly(x, z, poly)) continue;
      const d = Math.hypot(x - c[0], z - c[1]);
      if (d < bd) { bd = d; best = [x, z]; }
    }
  return best ?? c;
}
/** Whole millimetres: the file holds no fractions (v2 decides on integers only). */
const mm = (v: number) => Math.round(v * 1000);

const t0 = performance.now();
const w = await bootEden((m: string) => console.error(m));
try {
  const E = w.host.engine as unknown as Eng;
  const cat = ledgerCatalog(w.edge).payload as { places: { id: string; kind: string; name: string }[] };
  const warm0 = performance.now();
  const warm = E.navWarmV1(Infinity);
  const warmMs = Math.round(performance.now() - warm0);
  const scene = E.exportStaticScene(), arrival = scene.arrival;
  // Today's terrain under each point (its height and medium), so the comparison can name a difference that terrain makes.
  const field = E.world.groundV1 ? groundField(E.world.groundV1.recipeHash) : null;
  const terrain = (p: V2) => field ? { ground: mm(field.height(p[0], p[1])), medium: MEDIUM_NAMES[field.medium(p[0], p[1])] } : {};
  /** An upper floor's height where the place stands: the surface of its level under its point, else the level's own y.
   *  The v2 comparison maps today's level (a number by height) to a floor by this position. */
  const yAt = (p: V2, level: number): { y: number; surface?: string } | null => {
    if (!level) return null;
    const s = scene.surfaces.filter(s => s.level === level && inPoly(p[0], p[1], obbCorners(s.obb as never) as V2[]));
    if (s.length) return { y: mm(s[0]!.y), surface: s[0]!.id };
    const l = scene.levels.find(l => l.id === level);
    return l ? { y: mm(l.y) } : null;
  };
  const rows: Record<string, unknown>[] = [];
  const asks: { id: string; p: V2; level: number; tol: number }[] = [];
  for (const cp of cat.places) {
    const pl = w.edge.places.byId.get(cp.id);
    if (!pl) { rows.push({ id: cp.id, kind: cp.kind, skipped: 'not in the ledger' }); continue; }
    let p: V2, how: string;
    if (pl.carrier) { const e = E.world.entities[pl.carrier.entity]; p = [e!.pose.p[0]!, e!.pose.p[2]!]; how = 'carrier'; }
    else if (pl.polygon.length >= 3) { p = pointOf(pl.polygon as V2[]); how = 'outline'; }
    else { rows.push({ id: cp.id, kind: cp.kind, skipped: 'no outline' }); continue; }
    const ask = { id: cp.id, p, level: pl.level ?? 0, tol: 1.5 };
    asks.push(ask);
    rows.push({ id: cp.id, kind: cp.kind, ref: pl.ref ?? null, parent: pl.parent, level: ask.level, p: [mm(p[0]), mm(p[1])], how, ...(yAt(p, ask.level) ?? {}), ...terrain(p) });
  }
  const check0 = performance.now();
  const verdicts = asks.map(a => E.navCheckV1([a])[0]!);
  const checkMs = Math.round(performance.now() - check0);
  const by = new Map(verdicts.map(v => [v.id, v]));
  for (const r of rows) { const v = by.get(r.id as string); if (v) { r.ok = v.ok; for (const k of ['code', 'door', 'area', 'floor'] as const) if (v[k] !== undefined) r[k] = v[k]; if (v.pocket !== undefined) r.pocket = Math.round(v.pocket); } }
  const out = { what: 'navCheckV1 per catalog place, tol 1.5 m (Engine v2 N18, #2658)', template: 'worlds/templates/eden-2026.json', seed: w.god.model.seed, warm, units: 'mm (p, y, arrival); m² (pocket)', arrival: [mm(arrival[0]), mm(arrival[1])], places: rows };
  mkdirSync(dirname(OUT), { recursive: true });
  const text = JSON.stringify(out);
  writeFileSync(OUT, text);
  const ok = verdicts.filter(v => v.ok).length;
  console.error(`labels: ${rows.length} places, ${asks.length} asked, ${ok} ok, warm ${warm} in ${warmMs} ms, checks ${checkMs} ms, total ${Math.round(performance.now() - t0)} ms; sha256 ${createHash('sha256').update(text).digest('hex')}`);
} finally { w.close(); }
process.exit(0);

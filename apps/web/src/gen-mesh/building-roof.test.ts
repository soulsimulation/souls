// A building/1 roof meets its walls (node --test apps/web/src/gen-mesh/building-roof.test.ts). Gene, 26 Nov: Eden's shed-roofed
// studios showed their side walls crossing the roof, the walls high at the back and the roof high at the front. For every
// library building with walls under a gable or a shed roof, facing each way and with its sides either way round, every
// corner of the walls drawn above the eaves (a gable's apex, a shed's sloped side and back) stands just under the roof:
// not above it (crossing it) and not far below it (a gap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreLibrary, type StoredDef } from '@souls/world-compiler';
import { GENERATORS, type Value } from '@souls/generators';
import { buildingLayout } from '../../../../packages/generators/src/building.ts';
import { buildingBuffers } from './building-buffers.ts';

/** How far above a wall's top corner the roof's underside may be: a gable's apex stands below the ridge by the overhang's
 *  rise (0.35 m at the pitch, under 0.7 m at 60 degrees). */
const GAP = 0.8, OVER = 0.05;

/** The heights of the roof triangles straight above (x, z). */
function roofAbove(p: Float32Array, x: number, z: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], az = p[i + 2], bx = p[i + 3], bz = p[i + 5], cx = p[i + 6], cz = p[i + 8];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue; // an upright face
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, w = 1 - u - v;
    if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
    out.push(u * p[i + 1] + v * p[i + 4] + w * p[i + 7]);
  }
  return out;
}

/** The newest revision of each library building drawn by building/1 with its default params. */
function buildings(): { def: StoredDef; params: Record<string, Value> }[] {
  const newest = new Map<string, StoredDef>();
  for (const d of coreLibrary().all()) if (d.make.kind === 'gen' && d.make.gen === 'building/1' && (newest.get(d.name)?.version ?? -1) < d.version) newest.set(d.name, d);
  return [...newest.values()].map((def) => ({ def, params: Object.fromEntries(Object.entries({ ...GENERATORS['building/1'].params, ...def.params }).filter(([, f]) => f.default !== undefined).map(([k, f]) => [k, f.default as Value])) }));
}

test('every gable and shed roof meets the walls under it, facing each way', () => {
  let checked = 0;
  const bad: string[] = [];
  for (const { def, params: base } of buildings()) {
    for (const roof of ['gable', 'shed']) for (const front of ['s', 'e', 'n', 'w']) for (const swap of [false, true]) {
      const params: Record<string, Value> = { ...base, roof, front, ...(swap ? { w: base.d, d: base.w } : {}) };
      const args = (def.make.kind === 'gen' ? def.make.args ?? {} : {}) as Record<string, unknown>;
      const L = buildingLayout(params, args);
      if (L.round) continue;
      const raw = buildingBuffers({ L, params, presetTrim: undefined, paint: '#888888', seed: 1 }).raw;
      // a glass building's roof is glass
      const roofP = raw.find((s) => s.k === 'roof|roof' || s.k === 'roof|glass')?.p, walls = raw.find((s) => s.k === 'roof|wall')?.p;
      assert.ok(roofP, `${def.ref} ${roof}: a roof is drawn`);
      if (!walls) continue; // an open building: nothing stands under the roof
      checked++;
      for (let i = 0; i < walls.length; i += 3) {
        const x = walls[i], y = walls[i + 1], z = walls[i + 2];
        if (y < L.wallTop + 0.01) continue; // the eaves line, where the walls start
        const gaps = roofAbove(roofP, x, z).map((h) => h - y);
        if (!gaps.some((g) => g >= -OVER && g <= GAP)) {
          bad.push(`${def.ref} roof ${roof} front ${front}${swap ? ' sides swapped' : ''}: wall corner (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) has ${gaps.length ? `the roof's underside at ${gaps.map((g) => `${g >= 0 ? '+' : ''}${g.toFixed(2)}`).join(', ')} m from it (below 0: the wall pokes through the roof)` : 'no roof above it'}`);
          break;
        }
      }
    }
  }
  assert.ok(checked >= 64, `buildings checked: ${checked}`);
  assert.deepEqual(bad, [], bad.slice(0, 8).join('\n'));
});

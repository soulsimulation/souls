// #1368: a walker that steps aside for a crew (a make-way detour) used to hold the crew's "clear of my way" test as a
// closure, so its walk could not be written into a snapshot (`detour.clearOf is a function`), and the periodic snapshot
// killed the server. The detour now names its test as data ({kind, action}). A carry is itself not resumable
// (carry/actions.ts), so here the only action a snapshot may refuse is the carry, never the walker stepped aside for it.
// The face-off kind ('way'), with a full capture, restore and identical replay, is pinned through the whole engine in
// packages/engine-mars/src/make-way-detour-snapshot.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../runtime/runtime.ts';
import { DEFAULT_INVARIANTS } from '../runtime/invariants.ts';
import { SnapshotError } from '../runtime/snapshot.ts';
import { Spatial } from '../spatial/service.ts';
import { emptyWorld, human, addAll, component } from '../world/factory.ts';
import { walkTo } from '../locomotion/walk.ts';
import { carry } from '../carry/actions.ts';
import { CARRY_INVARIANTS } from '../carry/invariants.ts';
import type { ActionDef } from '../actions/types.ts';
import type { SpatialScene } from '../spatial/types.ts';

const scene: SpatialScene = { bounds: [-20, -20, 20, 20], levels: [{ id: 0, y: 0, label: 'ground' }], surfaces: [{ id: 'ground', level: 0, y: 0, obb: { c: [0, 0], half: [20, 20], yaw: 0 } }], obstacles: [], links: [] };
const REG = new Map<string, ActionDef>([['walk_to', walkTo], ['carry', carry]]);
const detour = (rt: Runtime) => [...((rt.services.walkExecs as Map<string, { detour?: { clearOf?: unknown } }> | undefined)?.values() ?? [])].find((x) => x.detour?.clearOf)?.detour;

test('#1368 a walker stepped aside for a carry crew stays resumable: a snapshot refuses only the carry itself', () => {
  // a crew carries a beam up the x = 0 lane while w walks down it to a goal on the route: w steps off and waits
  const rt = new Runtime(addAll(emptyWorld('detour-snapshot', scene), component('b1', 'beam-12ft', [0, 0, -9], Math.PI / 2), human('p1', 0, -12), human('p2', 0, -6.5), human('w', 0, 9)), REG, { spatial: new Spatial(scene) }, [...DEFAULT_INVARIANTS, ...CARRY_INVARIANTS]);
  const crew = rt.submit('carry', { crew: ['p1', 'p2'], item: 'b1', to: { x: 0, z: 6, yaw: Math.PI / 2 } });
  for (let i = 0; i < 100; i++) rt.step();
  const walk = rt.submit('walk_to', { actor: 'w', x: 0, z: 0 });
  let checked = 0;
  for (let i = 0; i < 2400 && (rt.isActive(walk.id) || rt.isActive(crew.id)); i++) {
    rt.step();
    if (!detour(rt)) continue;
    assert.deepEqual(detour(rt)!.clearOf, { kind: 'carry', action: crew.id }, 'the detour names the crew as data');
    const err = (() => { try { rt.snapshot(); } catch (e) { return e; } })();
    assert.ok(err instanceof SnapshotError && err.code === 'snapshot.non-resumable', String(err));
    assert.deepEqual(err.subjects, [crew.id], `only the carry is refused, not the walk stepped aside for it: ${err.message}`);
    checked++;
  }
  assert.ok(checked > 20, `w held the detour for a while (${checked} ticks)`);
  assert.deepEqual([crew.status, walk.status], ['completed', 'completed']);
  assert.deepEqual(rt.violations.map((v) => v.message), []);
});

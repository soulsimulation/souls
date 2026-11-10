// #1368: a snapshot taken while a walker has stepped aside (a make-way detour) must be written and restore. The detour
// used to hold its "clear of the other's way" test as a closure, so capture threw `snapshot.unencodable … detour.clearOf
// is a function` and the periodic snapshot killed the server (stair rate run on main e0ad750a2, tick 5212). This drives
// the doorway face-off of doorway-passing.test.ts until the yielding walker holds a live detour, then snapshots there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, type MarsEngine } from './engine.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import type { Engine } from '@souls/engine-contract';

const wall = (id: string, c: [number, number], half: [number, number]) => ({ id, obb: { c, half, yaw: 0 }, y0: 0, y1: 2.8, kind: 'fixture' as const, label: 'cottage wall' });
const cottage: WorldEditV1['set'][string] = {
  surfaces: [{ id: 'cottage:ground', level: 0, y: 0, obb: { c: [10, 0], half: [3.9, 2.9], yaw: 0 } }],
  solids: [wall('cottage:n', [10, -3], [4, 0.11]), wall('cottage:e', [14, 0], [0.11, 3]), wall('cottage:w', [6, 0], [0.11, 3]),
    wall('cottage:s1', [7.75, 3], [1.75, 0.11]), wall('cottage:s2', [12.25, 3], [1.75, 0.11])],
};
const IN = 'h_inside0001', OUT = 'h_outside001';
type Detour = { clearOf?: unknown; faceoff?: boolean };
const detours = (e: MarsEngine & Engine) =>
  [...((e as unknown as { rt: { services: { walkExecs?: Map<string, { detour?: Detour }> } } }).rt.services.walkExecs?.values() ?? [])].map((x) => x.detour).filter((d): d is Detour => !!d?.clearOf);

test('#1368 a world snapshotted while a walker steps aside for a face-off writes, restores and steps on identically', async () => {
  const f = await marsFactory(GREEN_FIELD_WORLD), e = f.create(f.genesis('doorway')) as unknown as MarsEngine & Engine;
  const draft: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: [], set: { e_cottage1: cottage }, assets: {} };
  draft.hash = nextEntityPhysics(undefined, draft).hash;
  e.applyWorldEditV1(draft);
  e.spawnHuman({ id: IN, label: 'In', soul: 's_inside0001' });
  e.spawnHuman({ id: OUT, label: 'Out', soul: 's_outside001' });
  const place = (id: string, [x, z]: [number, number], yaw: number) => { const h = e.world.entities[id]; h.pose.p = [x, h.pose.p[1], z]; h.pose.yaw = yaw; };
  place(IN, [10, 2.0], 0); place(OUT, [10, 3.2], Math.PI);
  assert.ok(e.perform({ actor: IN, label: 'go out', steps: [{ verb: 'mars:walk_to', params: { x: 10.4, z: 7 } }] }).ok);
  assert.ok(e.perform({ actor: OUT, label: 'go in', steps: [{ verb: 'mars:walk_to', params: { x: 9.6, z: -1.5 } }] }).ok);
  let t = 0;
  for (; t < 600 && !detours(e).some((d) => d.faceoff); t++) e.step();
  assert.ok(detours(e).some((d) => d.faceoff), `a walker stepped aside for the face-off within ${t} ticks`);
  const snap = structuredClone(e.snapshot());
  const b = f.restore(snap) as unknown as MarsEngine & Engine;
  assert.equal(b.stateHash(), e.stateHash(), 'the restored world is the same world');
  assert.ok(detours(b).some((d) => d.faceoff), 'the copy still holds the detour');
  for (let i = 0; i < 600 && (e.programOf(IN) || e.programOf(OUT)); i++) {
    e.step(); b.step();
    assert.equal(b.stateHash(), e.stateHash(), `tick ${e.world.tick}`);
  }
  for (const w of [e, b]) {
    assert.ok(w.world.entities[IN].pose.p[2] > 5 && w.world.entities[OUT].pose.p[2] < 0, 'both got through');
    assert.deepEqual(w.runtime.violations, []);
  }
});

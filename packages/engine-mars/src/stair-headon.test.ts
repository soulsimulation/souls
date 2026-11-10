// #1722 two-way stair deadlock: on a switchback stair (two flights meeting at a mid landing), an ascender reaches the landing
// and waits at the upper flight's entry for the descender who holds that flight, while the descender's last step is onto that
// very entry. Without stair-pass/1 they wait for each other until the blocked-walk bound ends both walks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD } from './engine.ts';
import { groundFact } from './ground-bridge.ts';
import { nextEntityPhysics, type WorldEditV1 } from './entity-physics.ts';
import { emptyGround } from '../../ground/src/index.ts';

const factory = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
const cx = 20, cz = 20, H1 = 2.85, H2 = 5.7, RUN = 2.6, GAP = 0.7;
const flight = (x: number, z0: number, y0: number, z1: number, y1: number) => Array.from({ length: 17 }, (_, i) => [x, y0 + ((y1 - y0) * i) / 16, z0 + ((z1 - z0) * i) / 16]);
function switchback(seed: string, policy: Record<string, boolean> = {}) {
  const set = { e_house: { surfaces: [
    { id: 'h:ground', level: 0, y: 0, obb: { c: [cx, cz], half: [6, 6], yaw: 0 } },
    { id: 'h:landing', level: 1, y: H1, obb: { c: [cx + GAP / 2, cz - 0.45], half: [GAP / 2 + 1.5, 0.55], yaw: 0 } },
    { id: 'h:top', level: 2, y: H2, obb: { c: [cx + GAP / 2, cz + RUN + 1.5], half: [GAP / 2 + 1.5, 1.5], yaw: 0 } }], solids: [],
    links: [
      { id: 'h:lower', kind: 'stairs', from: { level: 0, p: [cx, cz + RUN], y: 0 }, to: { level: 1, p: [cx, cz - 0.3], y: H1 }, width: 0.9, heading: -Math.PI / 2, path: flight(cx, cz + RUN, 0, cz - 0.1, H1), usable: true },
      { id: 'h:upper', kind: 'stairs', from: { level: 1, p: [cx + GAP, cz - 0.3], y: H1 }, to: { level: 2, p: [cx + GAP, cz + RUN + 0.4], y: H2 }, width: 0.9, heading: Math.PI / 2, path: flight(cx + GAP, cz - 0.1, H1, cz + RUN, H2), usable: true }] } } as unknown as WorldEditV1['set'];
  const g = emptyGround(2000); g.extent = [-200, -1000, 1800, 1000];
  const e = factory.create(factory.genesis(seed)) as any;
  e.installGroundV1(groundFact(g, 1, { paged: true }));
  const ev: WorldEditV1 = { contract: 'world-edit/1', seq: 1, hash: '', levels: [{ id: 1, y: H1, label: 'landing' }, { id: 2, y: H2, label: 'top' }], set, assets: {} } as never; ev.hash = nextEntityPhysics(undefined, ev).hash; e.applyWorldEditV1(ev);
  e.configureRuntimePolicy({ sleepBlockTicks: 1200, bodyStepGuardV1: true, refusalSettleV1: true, stairWayV1: true, stairLandingClearanceV1: true, concurrentLinkEgressV1: true, occupiedLinkRoutingV1: true, ...policy } as never);
  return e;
}
const walk = (e: any, id: string, x: number, z: number, level: number) => { const r = e.perform({ actor: id, label: 'walk', steps: [{ verb: 'mars:walk_to', params: { x, z, level } }] }); assert.ok(r.ok, JSON.stringify(r)); return r.id as string; };

const hh = (e: any) => e.runtime.violations.filter((d: any) => d.code === 'collision.human-human');
/** A descender comes down the upper flight while an ascender, having climbed the lower one, waits on the landing at the upper
 *  flight's entry (its traffic.yield: the descender holds the flight). The descender's last step is onto that entry. */
function meet(seed: string, pass: boolean) {
  const e = switchback(seed, pass ? { stairPassV1: true } : {});
  for (const [id, x, z] of [['h_up', cx - 1.5, cz + RUN + 1], ['h_down', cx + 2, cz + RUN + 1]] as const) { e.spawnHuman({ id, label: id, soul: `s_${id}` }); assert.ok(e.relocateHumanV1(id, [x, z])); }
  walk(e, 'h_down', cx + GAP, cz + RUN + 2, 2); for (let k = 0; k < 2000 && e.programOf('h_down'); k++) e.step();
  assert.equal(e.world.entities.h_down.human.level, 2, 'the descender starts upstairs');
  const up = walk(e, 'h_up', cx + GAP + 1, cz + RUN + 2.2, 2), down = walk(e, 'h_down', cx - 1.5, cz + RUN + 1.5, 0);
  const ends: Record<string, any> = {}, copy = factory.restore(e.snapshot()) as any;
  let both = 0, longest = 0, run = 0, jump = 0;
  for (let t = 0; t < 3000 && !(ends[up] && ends[down]); t++) {
    const before = ['h_up', 'h_down'].map((id) => [...e.world.entities[id].pose.p]);
    for (const p of e.step().programs) if ((p.id === up || p.id === down) && p.kind !== 'step' && !ends[p.id]) ends[p.id] = { t, ...p };
    copy.step();
    ['h_up', 'h_down'].forEach((id, i) => { const q = e.world.entities[id].pose.p; jump = Math.max(jump, Math.hypot(q[0] - before[i][0], q[1] - before[i][1], q[2] - before[i][2])); });
    const still = ['h_up', 'h_down'].every((id, i) => { const q = e.world.entities[id].pose.p; return Math.hypot(q[0] - before[i][0], q[1] - before[i][1], q[2] - before[i][2]) < 1e-6; });
    run = still ? run + 1 : 0; longest = Math.max(longest, run); if (still) both++;
  }
  return { e, copy, ends, up, down, longest, jump, hh: hh(e) };
}

test('#1722 without stair-pass/1 a descender and a walker waiting at its flight end wait for each other until the blocked-walk bound ends both walks (the fault)', () => {
  const r = meet('headon-off', false);
  assert.equal(r.ends[r.up]?.code, 'route.blocked'); assert.equal(r.ends[r.down]?.code, 'route.blocked');
  assert.ok(r.longest > 1200, `both stood still for ${r.longest} ticks`);
});

test('#1722 under stair-pass/1 the waiting walker steps aside, clear of both flights; both walks complete with no long wait, no jump and no overlap, and a restored snapshot continues alike', () => {
  const r = meet('headon-on', true);
  assert.equal(r.ends[r.up]?.kind, 'completed', JSON.stringify(r.ends[r.up])); assert.equal(r.ends[r.down]?.kind, 'completed', JSON.stringify(r.ends[r.down]));
  assert.ok(r.longest < 200, `both stood still for ${r.longest} ticks, under 10 s`);
  assert.ok(r.jump <= 0.2, `largest one-tick move ${r.jump.toFixed(3)} m`);
  assert.deepEqual(r.hh, []);
  assert.equal(r.copy.stateHash(), r.e.stateHash(), 'a restored snapshot continues alike');
});

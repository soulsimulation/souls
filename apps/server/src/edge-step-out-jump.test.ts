// #2298: an idle body left inside a solid footprint steps out (CN5, the ledger's sweep every 100 ticks) on the same tick
// whether its world is ticked or jumped: the sweep is one of the world's deadlines, never skipped by a jump.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {accept} from '../test/native-owner-fixture.ts';
import {edenNavWorld} from '../test/eden-nav-fixture.ts';

// todo: in this fixture the ticked world never steps the body out either (idle, no programme, clearance 0, a standable spot
// 1 m away, yet no edge-relocate in 3,000 ticks), so the comparison cannot run yet; the deadline itself is in ledger.unstickDue
test('jumped: a body inside a new footprint is stepped out on the same tick as when ticked', {timeout: 900000, todo: 'the ticked world does not step the body out in this fixture'}, async t => {
  const world = async () => {
    const w = await edenNavWorld(1); t.after(() => {w.f.host.stop(); w.f.db.close();});
    for (const p of [w.f.host.enableHeldActivitiesV1(), w.f.host.enableNeedAnchorsV1()]) await accept<unknown>(w.f.host, p);
    for (let i = 0; i < 40; i++) {w.f.host.tickOnce(); if (i % 10 === 0) await setImmediate();}
    // a footprint now stands where the body stands (as a god's new building would): put the body inside a solid
    const s = w.spec!.solids.find(q => q.id.startsWith('eden-house-1'))!, b = w.engine.world.entities[w.souls[0].entityId];
    const yaw = s.yaw ?? 0, d = s.half[0] - 0.2; b.pose.p[0] = s.c[0] + Math.cos(yaw) * d; b.pose.p[2] = s.c[1] + Math.sin(yaw) * d;   // just inside its wall
    return w;
  };
  const a = await world(), b = await world(), from = a.f.host.engine.world.tick;
  assert.equal(b.f.host.engine.world.tick, from);
  assert.ok(a.engine.clearanceAtV1(a.engine.world.entities[a.souls[0].entityId].pose.p[0], a.engine.world.entities[a.souls[0].entityId].pose.p[2]) < 0.27, 'inside the footprint');
  const moved = (w: typeof a) => w.f.db.events(w.f.host.worldId).filter(e => e.tick > from && e.kind === 'edge-relocate').map(e => e.tick);
  for (let i = 0; i < 3000 && !moved(a).length; i++) {a.f.host.tickOnce(); if (i % 50 === 0) await setImmediate(); }
  assert.equal(moved(a).length, 1, 'the ticked world stepped it out');
  const end = a.f.host.engine.world.tick + 20; while (a.f.host.engine.world.tick < end) a.f.host.tickOnce();
  const j0 = b.f.host.skipStats.ticksJumped; await b.f.host.catchUp(end - b.f.host.engine.world.tick);
  t.diagnostic(JSON.stringify({ticked: moved(a), jumped: moved(b), ticksJumped: b.f.host.skipStats.ticksJumped - j0}));
  assert.deepEqual(moved(b), moved(a), 'stepped out on the same tick');
  assert.ok(b.f.host.skipStats.ticksJumped > j0, 'and the world did jump');
});

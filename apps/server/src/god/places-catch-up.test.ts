// R14: a world catching up the ticks it owes (a release handover's or a restart's boot, before its clock starts) is
// served, so the god layer's places pass (layersStep: the initial door-safety index, a new day's places) runs in slices
// there, as on a running world, never whole inside one catch-up tick. Whole, it held the new process's /healthz and every
// viewer's upgrade during a release reload (Eden 2026: ~0.35 s locally, the release probe's held upgrade in production).
// A world stepped by hand (no clock, nothing owed) still publishes it whole at once, as before. As perceive-catch-up.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function world(t: any) {
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const bridge = installEngineBridge({ host: f.host, god, edge, log: () => {} }) as any;
  const { Hono } = await import('hono');
  const { mountEdgeRoutes, edgeSoulResolver } = await import('../edge/routes.ts');
  const comms = mountEdgeRoutes(new Hono(), { host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, () => undefined), ledger: edge } as never);
  f.brain.quiesce();
  t.after(() => { comms.close(); f.brain.quiesce(); f.host.stop(); f.db.close(); });
  const r = god.act({ ops: [
    { op: 'place', def: coreRef('fountain'), name: 'fountain', p: [0, 0] },
    { op: 'place', def: coreRef('roundhouse'), name: 'hut', p: [-20, 20] },
  ] } as never) as any;
  assert.equal(r.accepted, true, JSON.stringify(r));
  // a world with a calendar layer (Eden 2026 has one): layersStep derives the day's places (its schedules are not this test's)
  bridge.layers.active = () => true; bridge.layers.dayKey = () => '2026-11-23'; bridge.layers.step = () => {};
  // which way layersStep publishes places: whole (sync(true)) or a slice (syncStep), and whether a catch-up was under way
  const places = bridge.places, calls: { how: 'whole' | 'slice'; owed: number }[] = [];
  const sync = places.sync.bind(places), syncStep = places.syncStep.bind(places);
  places.sync = (force?: boolean) => { if (force === true) calls.push({ how: 'whole', owed: f.host.owedTicks }); return sync(force); };
  places.syncStep = (budget?: number) => { calls.push({ how: 'slice', owed: f.host.owedTicks }); return syncStep(budget); };
  return { f, bridge, places, calls };
}

test('R14: the places pass runs in slices during a boot catch-up, and whole on a world stepped by hand', async (t) => {
  await t.test('catching up owed ticks (the clock not started): sliced, and published by the end', async (t) => {
    const { f, places, calls } = await world(t);
    const ran = await f.host.catchUp(120, () => setImmediate());
    assert.equal(ran, 120, 'every owed tick runs (world time never stops)');
    const during = calls.filter((c) => c.owed > 0);
    assert.ok(during.some((c) => c.how === 'slice'), `the pass ran in slices during the catch-up (${JSON.stringify(calls.slice(0, 5))})`);
    assert.equal(during.filter((c) => c.how === 'whole').length, 0, 'never whole inside a catch-up tick');
    assert.ok(places.hasPublished(), 'the places are published by the end of the catch-up');
  });
  await t.test("the layers' places step itself: a slice while ticks are owed, whole when stepped by hand", async (t) => {
    const { f, bridge, places, calls } = await world(t);
    assert.equal(places.hasPublished(), false, 'nothing published yet');
    f.host.owedTicks = 5; bridge.layersStep(false); f.host.owedTicks = 0;
    assert.deepEqual(calls.map((c) => c.how), ['slice'], 'owed ticks: one slice');
    calls.length = 0; bridge.layerDay = '2026-11-22'; bridge.layersStep(false);   // a new day: its places again
    assert.deepEqual(calls.map((c) => c.how), ['whole'], 'by hand: whole at once, as before');
    assert.ok(places.hasPublished(), 'published');
  });
});

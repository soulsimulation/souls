// #2354: a far place's walk asked for by id (`walk:<place>`) resolves on the Soul's walk offers alone (offersOfVerb, a
// focused build), not on its whole menu (every object's actions, seats, layers: most of such an act at 24 Souls). The
// walk offers are exactly the whole menu's, in its order, and the act chooses the same walk or the same refusal.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, factory, invite, accept } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { offersOfVerb, explicitPlaceCapability } from '../edge/boot/world-places.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { GroundHost } from './ground-host.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const COTTAGE = { w: 8, d: 6, floors: 1, floorHeight: 2.8, style: 'cottage', roof: 'gable', roofPitch: 32, material: 'plaster', front: 's', porch: 0, balcony: false, windows: 0.6, wallThickness: 0.22 };

async function world(t: TestContext) {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {} });
  new GroundHost(w.db, w.host, god);
  const edge = new EdgeLedger(w.host, w.db); installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
  t.after(() => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); });
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  await invite(w, 'ada'); const row: any = await accept(w.host, w.souls.create('dev:ada', { name: 'Ada', description: 'curious' })); await settle(3);
  const s = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner };
  const p = (w.host.engine.world as any).entities[s.entityId].pose.p, at = [p[0], p[2]];
  const r = god.act({ ops: [
    { op: 'place', def: coreRef('cottage'), name: 'cottage', p: [Math.round(at[0] + 95), Math.round(at[1])], params: COTTAGE },
    { op: 'place', def: coreRef('bench'), name: 'bench', p: [Math.round(at[0] + 6), Math.round(at[1] + 3)] },
    { op: 'place', def: coreRef('fountain'), name: 'fountain', p: [Math.round(at[0] - 12), Math.round(at[1] + 4)] },
  ] }) as any;
  assert.equal(r.accepted, true, JSON.stringify(r)); await settle(4);
  return { edge, s, settle };
}

const view = (caps: any[]) => caps.map((c) => JSON.stringify(c));

test('#2354: the walk offers a walk resolves on are exactly the whole menu\'s, and the same choice and refusals follow', { timeout: 300_000 }, async (t) => {
  const { edge, s, settle } = await world(t);
  await settle(1); edge.invalidateBodies();                     // nothing kept: the focused build runs, then the whole one
  const focused = offersOfVerb(edge, s as any, 'walk'), whole = edge.coreA.binds(s as any).caps.filter((c) => c.verb === 'walk');
  assert.ok(whole.length > 1, 'walks are offered');
  assert.deepEqual(view(focused), view(whole), 'same walk offers, same order');
  // the same answers through the act's place check, with no menu kept (focused) and with this tick's whole menu built
  for (const asked of ['walk:cottage/bedroom', 'walk:cottage', 'walk:nowhere-at-all', 'walk:bench', 'walk:fountain']) {
    await settle(1); edge.invalidateBodies();
    const focused = explicitPlaceCapability(edge, s as any, asked);
    edge.coreA.binds(s as any);
    const whole = explicitPlaceCapability(edge, s as any, asked);
    assert.deepEqual(focused, whole, asked);
  }
});

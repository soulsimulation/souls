// #1770 plan-once: a strict act binds its offer once. The strict gate's bind answers the act's own bind in the same
// synchronous turn (as the act route runs them); after any await the act binds afresh. Oracle on: every reuse is compared
// with a fresh bind, and the outcome is the same as with the reuse turned off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {menuStats} from './edge/ledger/menu-stats.ts';

type Spot = {id: string; activity: string; at: [number, number]; level?: number; together?: unknown; base: string};

test('one bind per strict act: the gate\'s offer is the act\'s, in the same turn only', {timeout: 900_000}, async t => {
  const w = await bootEden(); t.after(() => w.close());   // Eden 2026: many spots
  const L = w.edge as any, soul = w.soul;
  await w.settle(40);
  const me = L.body(soul.entityId).pose.p, away = (s: Spot) => Math.hypot(s.at[0] - me[0], s.at[1] - me[2]);
  const ids = (L.spots.spots as Spot[]).filter(s => !s.level && !s.together && s.base !== 'lie').sort((a, b) => away(a) - away(b)).map(s => `${s.activity}:${s.id}`).slice(0, 12);
  const offered = ids.filter(id => {L.invalidateBodies(); return L.offerGate(soul, {capability: id}) === null;});
  assert.ok(offered.length >= 2, `two spots are on offer (${ids.length} spots)`);
  const missesBefore = menuStats.one.oracleMiss;
  // as the act route runs it: the gate, then the act, with no await in between
  const strict = (id: string) => {const no = L.offerGate(soul, {capability: id}); assert.equal(no, null); return accept(w.host, Promise.resolve(L.act(soul, {capability: id})));};
  L.invalidateBodies();
  const turn0 = menuStats.one.turn, built0 = menuStats.one.n, r = await strict(offered[0]!) as any;
  assert.equal(r.accepted, true, JSON.stringify(r));
  assert.ok(menuStats.one.turn > turn0, 'the act took the gate\'s bind');
  assert.equal(menuStats.one.n - built0, 1, 'one bind built for the gate and the act together');
  await w.settle(10);
  // an await between the gate and the act ends the turn: the act binds afresh
  L.invalidateBodies();
  const no = L.offerGate(soul, {capability: offered[1]}); assert.equal(no, null);
  await Promise.resolve();
  const turn1 = menuStats.one.turn, r2 = await accept(w.host, Promise.resolve(L.act(soul, {capability: offered[1]}))) as any;
  assert.equal(r2.accepted, true, JSON.stringify(r2));
  assert.equal(menuStats.one.turn, turn1, 'no reuse across an await');
  await w.settle(10);
  // a change the menu signature sees between the gate and the act (bodies moved) also ends the reuse, in the same turn
  L.invalidateBodies();
  assert.equal(L.offerGate(soul, {capability: offered[0]}), null);
  L.invalidateBodies();
  const turn2 = menuStats.one.turn, built2 = menuStats.one.n, r3 = await accept(w.host, Promise.resolve(L.act(soul, {capability: offered[0]}))) as any;
  assert.equal(r3.accepted, true, JSON.stringify(r3));
  assert.equal(menuStats.one.turn, turn2, 'no reuse once the signature changed');
  assert.ok(menuStats.one.n > built2, 'the act bound afresh');
  await w.settle(10);
  // P1d(iv): the gate's offer is replaced in the same turn by an act for another id: the act binds its own offer
  L.invalidateBodies();
  assert.equal(L.offerGate(soul, {capability: offered[0]}), null);
  const turn3 = menuStats.one.turn, built3 = menuStats.one.n, r4 = await accept(w.host, Promise.resolve(L.act(soul, {capability: offered[1]}))) as any;
  assert.equal(r4.accepted, true, JSON.stringify(r4));
  assert.equal(menuStats.one.turn, turn3, 'no reuse for another id');
  assert.equal(menuStats.one.n - built3, 1, 'the act bound its own offer');
  assert.equal(r4.receipt?.chosen?.capability, offered[1], 'the act performs the replacing id, not the gate\'s');
  assert.equal(menuStats.one.oracleMiss, missesBefore, 'no reuse differed from a fresh bind');
});

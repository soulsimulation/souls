// #1848: a spot asked for by its id builds only the sections that can produce its offer (the activity listing of that
// spot, the world profile, the ride refusals). Oracle: for every spot id of the Eden 2026 catalog, from three standing
// points and with one spot taken by another Soul, the offer and plan equal the focused build with every section run
// (`bindsCore(soul, focus)` as it was before), field for field.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {invite, accept} from '../test/native-owner-fixture.ts';
import {ledgerCatalog} from './edge/catalog/routes.ts';
import {focusFor} from './edge/ledger/focus.ts';
import type {EdgeCapability, EdgeSoul} from './edge/contract.ts';

type Core = {caps: EdgeCapability[]; plans: Map<string, unknown>};

test('Eden: a spot id\'s offer from its own sections equals the focused build of every section', {timeout: 900_000}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as any, host = w.host, soul = w.soul as EdgeSoul;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  await run(120);
  const ids: string[] = ledgerCatalog(L).payload.acts.map((a: {id: string}) => a.id);
  assert.ok(ids.length > 100, `the catalog names many spots (${ids.length})`);
  // one spot taken: another Soul acts on the spot nearest the arrival (its open act claims it)
  await invite(w, 'bo');
  const row = await accept(host, w.souls.create('dev:bo', {name: 'Bo', description: 'takes a spot'})) as {id: string; entity_id: string; name: string; owner: string};
  const bo = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  await run(10);
  const near = (L.bindOne(soul, ids.find(id => L.bindOne(soul, id)?.cap.available) ?? '')?.cap.id) as string;
  assert.ok(near, 'a spot is on offer at the arrival');
  const took = await accept(host, L.act(bo, {capability: near})) as {accepted: boolean};
  assert.equal(took.accepted, true, `Bo takes ${near}`);
  await run(5);
  const check = (where: string) => {
    const bad: string[] = []; let reduced = 0, offered = 0;
    const pick = (b: Core, id: string) => JSON.stringify([b.caps.find(c => c.id === id) ?? null, b.plans.get(id) ?? null]);
    for (const id of ids) {
      L.invalidateBodies();
      const f = focusFor(id), mine: Core = L.bindsCore(soul, f), every: Core = L.bindsCore(soul, f, true);
      if (pick(mine, id) !== pick(every, id)) bad.push(id);
      if (mine.caps.length < every.caps.length) reduced++;
      if (every.caps.some(c => c.id === id)) offered++;
    }
    t.diagnostic(`${where}: ${ids.length} spot ids, ${offered} offered, ${reduced} from their own sections`);
    assert.deepEqual(bad.slice(0, 8), [], `${where}: ${bad.length} of ${ids.length} spot offers differ`);
    assert.ok(offered > 100 && reduced === offered, `${where}: every offered spot came from its own sections (${reduced} of ${offered})`);
    return {offered, reduced};
  };
  const at0 = check('arrival');
  assert.equal(JSON.stringify(L.bindsCore(soul, focusFor(near), true).caps.find((c: EdgeCapability) => c.id === near) ?? null), 'null', `${near} is taken, so not offered`);
  // two more standing points: a walk and a gait to places on offer
  const been = new Set<string>();
  for (const verb of ['walk', 'jog']) {
    // (a different place each time: the menu's fourth such offer not walked to yet)
    const go = L.binds(soul).caps.filter((c: EdgeCapability) => c.verb === verb && c.available && c.target?.kind === 'place' && !been.has(c.target.id))[3];
    if (go) been.add(go.target.id);
    assert.ok(go, `a ${verb} is on offer`);
    const r = await accept(host, L.act(soul, {capability: go.id})) as {accepted: boolean};
    assert.equal(r.accepted, true, go.id);
    for (let k = 0; k < 12 && L.openReceipts(soul.soulId).length; k++) await run(25);
    check(`after ${go.id}`);
  }
  assert.ok(at0.reduced > 0);
});

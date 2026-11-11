// #1948 on the real Eden 2026 template (fake minds, in memory): an id the strict gate cannot bind is refused at once,
// capability.unknown with no did_you_mean, and neither the whole menu nor the words menu is built for it; the ids the
// catalog says are sent from anywhere (the anywhere acts, a far place's walk, a far seat) are still taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {ledgerCatalog} from './edge/catalog/routes.ts';
import {menuStats} from './edge/ledger/menu-stats.ts';
import {SPOT_REACH} from './edge/ledger/activities.ts';

test('Eden: an unknown id is refused without building a menu; on-demand ids are still taken', {timeout: 600_000}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge as any, host = w.host, soul = w.soul;
  for (let i = 0; i < 120; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}}
  await setImmediate(); host.drainInputs();
  const cat = ledgerCatalog(L).payload, me = L.body(soul.entityId).pose.p;
  const away = (at: [number, number]) => Math.hypot(at[0] - me[0], at[1] - me[2]);
  const gate = (id: string) => {L.invalidateBodies(); return L.offerGate(soul, {capability: id});};

  await t.test('A1/A3: an id the gate cannot bind moves no menu counter, keeps its code and names no others', () => {
    for (const id of ['walk:eden-no-such-place', 'eat:eat.e_no-such-spot', 'sit:no-such-thing', 'dance:nowhere', 'object:no-thing:open']) {
      const miss = menuStats.cap.miss, built = menuStats.words.built;
      const no = gate(id);
      assert.equal(no?.code, 'capability.unknown', id);
      assert.equal(menuStats.cap.miss, miss, `${id}: no whole menu`);
      assert.equal(menuStats.words.built, built, `${id}: no words menu`);
      assert.equal(no.did_you_mean, undefined, `${id}: no did_you_mean`);
      assert.equal(no.candidates, undefined, `${id}: no candidates`);
      assert.match(no.reason, /not an offer on this Soul/);
    }
  });

  await t.test('A2: the anywhere acts, a far place walk and a far sit from the catalog are taken', () => {
    const ids = cat.anywhere.map(a => a.id);
    const far = cat.places.filter(p => !p.level && p.parent && !p.fixed).sort((a, b) => away(b.at) - away(a.at)).slice(0, 2);
    const seats = cat.things.filter(x => x.seat && away(x.at) > SPOT_REACH + 100).sort((a, b) => away(b.at) - away(a.at)).slice(0, 2);
    assert.equal(far.length, 2, 'two far places'); assert.equal(seats.length, 2, 'two far seats');
    // and a far room by its walk ref, which only resolve's on-demand makers know (not on the menu, not an id in the world)
    const room = 'walk:region-alpine-mountain-station/hall';
    assert.ok(!L.coreA.binds(soul).caps.some((c: {id: string}) => c.id === room) && !L.bindOne(soul, room), `${room} is off the menu here`);
    ids.push(...far.map(p => `walk:${p.id}`), ...seats.map(s => `sit:${s.id}`), room);
    assert.deepEqual(ids.map(id => [id, gate(id)?.code ?? 'ok']).filter(([, code]) => code !== 'ok'), []);
  });
});

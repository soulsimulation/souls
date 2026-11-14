// #2274: `find` ranks a place's full name first, then the longest name the words hold whole, and a place row names the
// places that share its name as a prefix (`also`). Eden 2026, the real genesis (fake minds, in memory), searched by find.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootEden } from '../../../apps/server/test/eden-capabilities-timing.ts';
import { ledgerCatalog } from '../../../apps/server/src/edge/catalog/routes.ts';
import { setImmediate } from 'node:timers/promises';
import { accept } from '../../../apps/server/test/native-owner-fixture.ts';
import { bodyState } from '../../../apps/server/src/body-state.ts';
import { indexCatalog, find } from './catalog.mjs';

test('#2274 A2: Eden 2026, "eden house 3 kitchen", "eden house 3" and a unique name', { timeout: 300000 }, async (t) => {
  const w = await bootEden(); t.after(w.close);
  const ix = indexCatalog(ledgerCatalog(w.edge).payload), places = (words) => find(ix, words, { at: [0, 0] }).found.filter((r) => r.type === 'place');
  // the full name first, and the row says the house shares its name's start
  const kitchen = places('eden house 3 kitchen');
  assert.equal(kitchen[0].id, 'g-eden-house-3-kitchen');
  assert.deepEqual(kitchen[0].also, ['Eden House 3']);
  // the house by its full name, its row naming the other places that start with its name, the kitchen among them
  const house = places('eden house 3');
  assert.equal(house[0].id, 'g-eden-house-3');
  assert.deepEqual(house[0].also, ['Eden House 3 Bedroom', 'Eden House 3 Kitchen', 'Eden House 3 Study', 'Eden house 3 courtyard']);
  // more words than a name (#2271's instruction): the longest name the words hold whole, then the shorter one
  assert.deepEqual(places('the north door of Eden House 3 Kitchen').slice(0, 2).map((r) => r.id), ['g-eden-house-3-kitchen', 'g-eden-house-3']);
  // a unique name: first, and nothing shares it
  const library = places('eden library');
  assert.equal(library[0].id, 'g-eden-library-1');
  assert.equal(library[0].also, undefined);
});

// #2312: the bandstand has no seat on its floor; its audience benches stand round it. "sit at the bandstand" finds them,
// nearest first, and a Soul sent to the first by its id walks there and sits.
test('#2312: Eden 2026, "sit at the bandstand" finds the benches round it, and a Soul sits on one by id', { timeout: 900000 }, async (t) => {
  const w = await bootEden(); t.after(w.close);
  const ix = indexCatalog(ledgerCatalog(w.edge).payload), bandstand = ix.place('g-eden-bandstand');
  const r = find(ix, 'sit at the bandstand', { at: [0, 0] });
  assert.equal(r.near?.id, 'g-eden-bandstand');
  assert.ok(r.found.length >= 4, `seats found: ${r.found.length}`);
  for (const row of r.found.slice(0, 4)) {
    assert.equal(row.type, 'thing'); assert.match(row.act, /^sit:e_/);
    assert.ok(Math.hypot(row.at[0] - bandstand.at[0], row.at[1] - bandstand.at[1]) <= 10, `${row.name} stands by the bandstand`);
  }
  const out = await accept(w.host, w.edge.act(w.soul, { capability: r.found[0].act }));
  assert.equal(out.accepted, true, JSON.stringify(out));
  let body = null;
  for (let i = 0; i < 3000 && body?.posture !== 'seated'; i++) { w.host.tickOnce(); if (i % 20 === 0) { await setImmediate(); w.host.drainInputs(); } body = bodyState(w.host, w.soul.entityId); }
  assert.equal(body?.posture, 'seated', `the Soul sits on ${r.found[0].name}: ${JSON.stringify(body)}`);
  const p = w.host.engine.world.entities[w.soul.entityId].pose.p;
  assert.ok(Math.hypot(p[0] - r.found[0].at[0], p[2] - r.found[0].at[1]) < 2, `on the bench: ${p}`);
});

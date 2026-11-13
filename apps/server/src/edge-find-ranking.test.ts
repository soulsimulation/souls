// #2274: `find` ranks a place's full name first, then the longest name the words hold whole, and a place row names the
// places that share its name as a prefix (`also`). Eden 2026, the real genesis, searched by the client's own `find`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {ledgerCatalog} from './edge/catalog/routes.ts';

const CLIENT_CATALOG = new URL('../../../tools/world-launcher/soul/catalog.mjs', import.meta.url).href;
type Row = {type: string; id?: string; name?: string; also?: string[]};

test('#2274 A2: Eden 2026, "eden house 3 kitchen", "eden house 3" and a unique name', {timeout: 300000}, async t => {
  const w = await bootEden(); t.after(w.close);
  const {indexCatalog, find} = await import(CLIENT_CATALOG) as {indexCatalog: (c: unknown) => unknown; find: (ix: unknown, w: string, o: object) => {found: Row[]}};
  const ix = indexCatalog(ledgerCatalog(w.edge).payload), places = (words: string) => find(ix, words, {at: [0, 0]}).found.filter(r => r.type === 'place');
  // the full name first, and the row says the house shares its name's start
  const kitchen = places('eden house 3 kitchen');
  assert.equal(kitchen[0]!.id, 'g-eden-house-3-kitchen');
  assert.deepEqual(kitchen[0]!.also, ['Eden House 3']);
  // the house by its full name, its row naming the other places that start with its name, the kitchen among them
  const house = places('eden house 3');
  assert.equal(house[0]!.id, 'g-eden-house-3');
  assert.deepEqual(house[0]!.also, ['Eden House 3 Bedroom', 'Eden House 3 Kitchen', 'Eden House 3 Study', 'Eden house 3 courtyard']);
  // more words than a name (#2271's instruction): the longest name the words hold whole, then the shorter one
  assert.deepEqual(places('the north door of Eden House 3 Kitchen').slice(0, 2).map(r => r.id), ['g-eden-house-3-kitchen', 'g-eden-house-3']);
  // a unique name: first, and nothing shares it
  const library = places('eden library');
  assert.equal(library[0]!.id, 'g-eden-library-1');
  assert.equal(library[0]!.also, undefined);
});

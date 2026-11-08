// #1329 part 4 (Gene's Eden smoke test, bug 10): `caps --search "library"` matched 0 of ~14,400 offers while
// `resolve "walk to library"` found `walk:eden-library-1` (278 m). A far place's walk is made on demand, so it is in no menu;
// a capabilities search (`?all=1&search=`) now also names the known places the words match, with their walks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { bootEden } from '../test/eden-capabilities-timing.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json (lane/engine content)';

test('I7/I8: a search finds far places by name and alias, as resolve does, and says what it left out', { timeout: 600_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden();
  t.after(() => w.close());
  const menu = w.edge.capabilitiesPage(w.soul, { all: true }).capabilities, menuIds = new Set(menu.map((c) => c.id));
  const resolved = (text: string) => (w.edge.intents.dryRun(w.soul, { capability: text }) as { ok: boolean; would?: { capability: string } }).would?.capability;
  // the case: a far place the menu leaves out (Gene's library on the live Eden 2026; here the lighthouse and the big top)
  for (const [words, text] of [['lighthouse', 'go to the lighthouse'], ['big top', 'go to the big top']]) {
    const id = resolved(text)!; assert.ok(id, text);
    assert.ok(!menuIds.has(id), `${id} is in no menu (the case)`);
    const s = w.edge.capabilitiesPage(w.soul, { all: true, search: words });
    assert.ok(s.search!.places.includes(id), `${words}: ${JSON.stringify(s.search)}`);
    const walk = s.capabilities.find((c) => c.id === id)!;
    assert.ok(walk && walk.verb === 'walk' && walk.available, JSON.stringify(walk));
    assert.ok((walk.aliases ?? []).length, JSON.stringify(walk));
    assert.equal(new Set(s.capabilities.map((c) => c.id)).size, s.capabilities.length, 'no id twice');
    for (const c of menu) assert.ok(s.capabilities.some((x) => x.id === c.id), 'the whole menu is still there');
  }
  // a place on the menu already (the library, near here): named, not listed twice
  const lib = resolved('walk to library')!, sl = w.edge.capabilitiesPage(w.soul, { all: true, search: 'library' });
  assert.ok(sl.search!.places.includes(lib), JSON.stringify(sl.search));
  assert.equal(sl.capabilities.filter((c) => c.id === lib).length, 1);
  // the id a search names is one act takes (by id, as a dry run reads it)
  for (const id of w.edge.capabilitiesPage(w.soul, { all: true, search: 'lighthouse' }).search!.places) assert.equal((w.edge.intents.dryRun(w.soul, { capability: id }) as { ok: boolean }).ok, true, id);
  // review: a water place's walk is its shore's, as resolve answers; a place with no walk is named in the note, never silent
  const pondWalk = resolved('walk to Commons Pond'); assert.ok(pondWalk, 'resolve walks to the pond');
  assert.ok(w.edge.capabilitiesPage(w.soul, { all: true, search: 'Commons Pond' }).search!.places.includes(pondWalk!));
  for (const words of ['Koi Pond', 'West Lake', 'Southern Sea', 'Town Canal']) {
    const r = w.edge.capabilitiesPage(w.soul, { all: true, search: words }).search!;
    assert.ok(r.places.length > 0 || /no walk from here/.test(r.note ?? ''), `${words}: ${JSON.stringify(r)}`);
  }
  // an empty query is no search
  assert.equal(w.edge.capabilitiesPage(w.soul, { all: true, search: undefined }).search, undefined);
  // I8: no place: says so, not just an empty list
  const none = w.edge.capabilitiesPage(w.soul, { all: true, search: 'airport' }).search!;
  assert.deepEqual(none.places, []); assert.equal(none.truncated, false); assert.equal(none.query, 'airport'); assert.match(none.note ?? '', /No place you know is named "airport"/);
  // I8: more places match than are built: says how many and how to narrow
  const many = w.edge.capabilitiesPage(w.soul, { all: true, search: 'house' }).search!;
  assert.ok(many.placesMatched > 12, `house matches ${many.placesMatched} places`);
  assert.equal(many.places.length, 12); assert.equal(many.truncated, true); assert.match(many.note ?? '', /known places match "house"; 12 are listed/);
  // unchanged without search: no search field, the same menu
  assert.equal(w.edge.capabilitiesPage(w.soul, { all: true }).search, undefined);
});

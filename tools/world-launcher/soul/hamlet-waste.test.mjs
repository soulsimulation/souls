// #2452 (m4-hamlet-v1 score, findings 1, 2 and 4): calls an agent spent because the world said something unclearly. The
// pond's row walks to its bank (a walk into water is refused), listen's hint names the bank, a refused walk names the
// nearest place one reaches and says to refresh only a stale copy, and the waiting line leaves out messages in hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexCatalog, find, tokensOf } from './catalog.mjs';
import { wakeFound, waitingCount, unwalkableNext } from './eden.mjs';

// the hello-hamlet pond as its catalog publishes it: the water lies in its bank; a hall beside it says "into" and "pond"
const cat = { placeVerbs: ['walk'], acts: [], things: [], anywhere: [], kinds: {}, places: [
  { id: 'g-pond', name: 'Hamlet Pond', kind: 'water', parent: 'g-pond.shore-bank', at: [-17, 43.5], aliases: ['pond', 'water', 'lake'] },
  { id: 'g-pond.shore-bank', name: 'Hamlet Pond bank', kind: 'shore', parent: 'world', at: [-17, 43.5], aliases: ['pond bank', 'pond shore'] },
  { id: 'g-lab-pond-hall', ref: 'lab-pond-hall', name: 'Waterside Hall', kind: 'building', parent: 'world', at: [2, 40], aliases: ['pond hall'], what: 'A small gathering hall beside Hamlet Pond. Its doorway leads into one room.' },
  { id: 'g-cottage', ref: 'cottage', name: 'Cottage', kind: 'building', parent: 'world', at: [10, 10] },
] };
const ix = indexCatalog(cat), at = [0, 2];

test('A1: water no walk reaches gives its bank\'s walk, saying so; other places keep their own', () => {
  const rows = find(ix, 'pond', { at }).found, pond = rows.find((r) => r.id === 'g-pond');
  assert.equal(pond.act, 'walk:g-pond.shore-bank', 'no walk:g-pond');
  assert.equal(pond.actTo, 'Hamlet Pond bank'); assert.match(pond.note, /No walk goes into Hamlet Pond; this act walks to Hamlet Pond bank/);
  assert.ok(!rows.some((r) => r.act === 'walk:g-pond'), 'no row offers a walk into the water');
  assert.equal(rows.find((r) => r.id === 'g-lab-pond-hall').act, 'walk:lab-pond-hall');
  assert.equal(find(ix, 'cottage', { at }).found[0].act, 'walk:cottage');
});

test('A1 (finding 4): "Go into the pond." finds the pond first, and listen\'s hint names its bank', () => {
  assert.equal(find(ix, 'go into the pond', { at }).found[0].id, 'g-pond', 'not the hall whose words say "into"');
  const hint = wakeFound((w) => find(ix, w, { at, limit: 4 }).found, tokensOf, 'Go into the pond.');
  assert.equal(hint[0].act, 'walk:g-pond.shore-bank');
  assert.equal(hint[0].what, 'Hamlet Pond bank (no walk goes into Hamlet Pond)');
});

test('A1: a place.unwalkable refusal names the world\'s nearest place, and says to refresh only when the copy is stale', () => {
  const d = { code: 'place.unwalkable', reason: 'No walk reaches it…', next: 'walk:pond' };
  assert.deepEqual(unwalkableNext(d, () => false), { nearest: 'walk:pond' });
  const stale = unwalkableNext(d, () => true);
  assert.equal(stale.nearest, 'walk:pond'); assert.match(stale.refresh, /catalog --refresh: this copy of the catalog is older than the world's/);
  assert.deepEqual(unwalkableNext({ code: 'capability.unknown', next: 'x' }, () => true), {}, 'other refusals unchanged');
});

test('A2: the waiting line leaves out messages listen handed over and the one --for names', () => {
  const inbox = { queued: 2, latest: { id: 'm1' }, waiting: ['m1', 'm2'] };
  assert.equal(waitingCount(inbox, new Set()), 2);
  assert.equal(waitingCount(inbox, new Set(['m1'])), 1, 'm2 came after the last listen');
  assert.equal(waitingCount(inbox, new Set(['m1', 'm2'])), 0);
  assert.equal(waitingCount({ queued: 0 }, new Set()), 0);
  // a world that lists no ids: its one waiting message, when the agent holds it, is not news
  assert.equal(waitingCount({ queued: 1, latest: { id: 'm1' } }, new Set(['m1'])), 0);
  assert.equal(waitingCount({ queued: 2, latest: { id: 'm1' } }, new Set(['m1'])), 2);
});

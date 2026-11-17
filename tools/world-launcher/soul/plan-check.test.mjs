// #2498 F2 (the Eden harder-v1 errand, r2): `plan` took `walk:fire-circle`, an id no offer has (Eden has two fire circles), and
// the plan would have failed only on reaching it. plan now checks each step id against this machine's copy of the catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexCatalog } from './catalog.mjs';
import { planUnknown, planUnknownAnswer } from './eden.mjs';

// the Eden places and acts the errand needs, as its catalog publishes them
const ix = indexCatalog({ placeVerbs: ['walk', 'jog'], kinds: {}, anywhere: [{ id: 'sit-ground:here', verb: 'sit-ground', label: 'Sit down' }],
  places: [
    { id: 'g-place-social-eden-fire-circle', ref: 'place-social-eden-fire-circle', name: 'Commons Fire Circle', kind: 'social', at: [10, 10] },
    { id: 'g-place-region-campsite-fire-circle', ref: 'place-region-campsite-fire-circle', name: 'Campsite Fire Circle', kind: 'social', at: [300, 40] },
    { id: 'g-eden-library-1', name: 'Eden Library', kind: 'building', at: [60, 0] },
  ],
  things: [{ id: 'e_cbc3f855', kind: 'dining-table', name: 'table', place: 'g-place-social-eden-fire-circle', at: [11, 10] }, { id: 'e_7c0ffee0', kind: 'core-bench', name: 'bench', place: 'g-eden-library-1', at: [61, 0], seat: true }],
  acts: [
    { id: 'eat:eat.e_cbc3f855', verb: 'eat', label: 'Eat at the dining table', place: 'g-place-social-eden-fire-circle', at: [11, 10] },
    { id: 'read:read.e_243d6ce2', verb: 'read', label: 'Read a book', place: 'g-eden-library-1', at: [60, 1] },
  ] });

test('#2498 A3: a step id the copy knows nothing of is unknown; one it has, or cannot tell, is not', () => {
  assert.equal(planUnknown(ix, 'walk:fire-circle'), true, 'a walk to no place');
  assert.equal(planUnknown(ix, 'eat:the-cafe'), true, 'a verb on no place, thing or act');
  for (const id of ['walk:place-social-eden-fire-circle', 'walk:g-eden-library-1', 'eat:eat.e_cbc3f855', 'read:read.e_243d6ce2', 'sit:e_7c0ffee0', 'sit-ground:here', 'pray'])
    assert.equal(planUnknown(ix, id), false, `${id} is known or has no target`);
  // the copy cannot vouch for these, so they still run unchecked, as before
  for (const id of ['go-near:s_moss1', 'object:e_cbc3f855:wipe', 'play-music:e_7c0ffee0', 'look:g-eden-library-1', 'wave:s_x'])
    assert.equal(planUnknown(ix, id), false, `${id}: the copy cannot tell`);
  assert.equal(planUnknown(ix, 'greet:moss', [{ id: 'moss' }]), false, 'a Soul in the live copy');
  assert.equal(planUnknown(null, 'walk:fire-circle'), false, 'no copy: nothing is called unknown');
});

test('#2498 A3: the answer names the step, sends nothing, and gives the top find rows for its words', () => {
  const a = planUnknownAnswer(ix, 3, 'walk:fire-circle', { at: [0, 0] });
  assert.equal(a.accepted, false);
  assert.equal(a.code, 'capability.unknown');
  assert.equal(a.step, 3);
  assert.match(a.reason, /^Step 3: no offer here has the id walk:fire-circle\. Nothing was sent/);
  assert.deepEqual(a.found.map((r) => r.act), ['walk:place-social-eden-fire-circle', 'walk:place-region-campsite-fire-circle'], 'both fire circles, the nearer first');
  assert.ok(a.found.length <= 3);
  assert.match(a.next, /step 3's place/);
  const none = planUnknownAnswer(ix, 1, 'walk:zzz-nowhere', { at: [0, 0] });
  assert.equal(none.found, undefined);
  assert.match(none.next, /find "<words>"/);
});

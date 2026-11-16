// #2477 (harder-hamlet-v1 score, findings 1, 3 and 4): find listed go-near for a Soul in another room, which the world
// refuses (it offers go-near only within 60 m in the same room), and the refusal's next was a search for "go near s …". A
// plan step with its params written as text was refused without the object form. A promise of a later act needs its wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexCatalog, find, soulReach } from './catalog.mjs';
import { findNext, parsePlanSteps, secondsNext } from './eden.mjs';

// the hello-hamlet places as its catalog publishes them: the field is outdoors, the hall a room in a building with doors
const cat = { placeVerbs: ['walk'], acts: [], things: [], anywhere: [], kinds: {}, places: [
  { id: 'world', name: 'World', kind: 'outdoor', parent: null, at: [0, 0] },
  { id: 'field', name: 'Green field', kind: 'walkable', parent: 'world', at: [0, 0] },
  { id: 'g-lab-presentation-hall', ref: 'lab-presentation-hall', name: 'Presentation Hall', kind: 'building', parent: 'field', at: [14, -8], doors: [{ at: [14, -3], out: 'S' }] },
  { id: 'g-lab-presentation-hall.hall', ref: 'lab-presentation-hall/hall', name: 'Main Hall', kind: 'room', parent: 'g-lab-presentation-hall', at: [14, -8] },
] };
const ix = indexCatalog(cat);
const moss = { id: 's_4d7278ad7f', name: 'Moss', at: [14, -8], place: 'g-lab-presentation-hall.hall', doing: 'idle' };

test('A1: a Soul in another room gets the walk to its room, not a go-near the world refuses', () => {
  const row = find(ix, 'Moss', { at: [0, 2], here: 'field', souls: [moss] }).found[0];
  assert.equal(row.type, 'soul');
  assert.deepEqual(row.acts, ['walk:lab-presentation-hall/hall'], 'no go-near:, wave: or face: from outside the hall');
  assert.match(row.note, /Moss is in another room \(Main Hall, Presentation Hall\): go-near, wave and face are offered only within 60 m in the same room/);
  // in the same room the acts are the Soul's own, as the world offers them
  assert.deepEqual(find(ix, 'Moss', { at: [13, -8], here: 'g-lab-presentation-hall.hall', souls: [moss] }).found[0].acts, ['go-near:s_4d7278ad7f', 'wave:s_4d7278ad7f', 'face:s_4d7278ad7f']);
  // outdoors both, but over 60 m: a walk to its point
  const far = soulReach(ix, { ...moss, place: 'field', at: [90, 0] }, { here: 'field', at: [0, 0] });
  assert.deepEqual([far.acts, far.params], [['walk:field'], undefined]);
  // a copy that does not say where I am cannot tell: as before
  assert.deepEqual(find(ix, 'Moss', { at: [0, 2], souls: [moss] }).found[0].acts, ['go-near:s_4d7278ad7f', 'wave:s_4d7278ad7f', 'face:s_4d7278ad7f']);
});

test('A1: a refused act on a Soul names the walk to it, not a search for its id\'s words', () => {
  const refused = { code: 'capability.unknown', reason: '"go-near:s_4d7278ad7f" is not an offer on this Soul right now…' };
  const way = { act: 'walk:lab-presentation-hall/hall', name: 'Moss', where: 'Main Hall, Presentation Hall' };
  const next = findNext('go-near:s_4d7278ad7f', refused, way).next;
  assert.match(next, /act walk:lab-presentation-hall\/hall --wait, then go-near:s_4d7278ad7f: Moss is in Main Hall, Presentation Hall/);
  assert.doesNotMatch(next, /find "go near s/);
  assert.match(findNext('wave:s_4d7278ad7f', refused, { act: 'walk-to:here', params: { at: [90, 0] }, name: 'Moss', where: 'Green field' }).next, /act walk-to:here '\{"at":\[90,0\]\}' --wait/);
  assert.match(findNext('go-near:s_0000000000', refused, null).next, /find --kind soul/);
  assert.match(findNext('walk:pond', refused).next, /find "walk pond"$/, 'other ids keep their search');
});

test('A2: a plan step with its params as text is refused with the {"id","params"} form', () => {
  assert.throws(() => parsePlanSteps('["sit:e_9c01b32d {\\"seconds\\":3600}"]'), (e) => e.message.includes('{"id":"sit:e_9c01b32d","params":{"seconds":3600}}'));
  assert.throws(() => parsePlanSteps('["not an id"]'), /A step with params: \{"id":"<id>","params":\{…\}\}/);
  assert.deepEqual(parsePlanSteps('[{"id":"sit:e_9c01b32d","params":{"seconds":3600}}]').steps, [{ id: 'sit:e_9c01b32d', params: { seconds: 3600 } }]);
});

test('A3: the skill says a promised later act needs its wake', () => {
  const skill = readFileSync(new URL('./skill.md', import.meta.url), 'utf8');
  assert.match(skill, /^- Promise a later act only with its wake set \(`wake add`\); else say what's allowed\.$/m);
});

// PR #2479 finding: both refused-recover agents promised the owner a second sit later and set no wake for it
test('a sit refused for more seconds than the world takes names the capped act and the wake for the rest', () => {
  const d = { code: 'capability.params', reason: 'seconds must be an integer 1..3600 for this capability.' };
  const next = secondsNext('sit:e_9c01b32d', d, { seconds: 7200 }, Date.parse('2026-11-16T00:00:00Z')).next;
  assert.match(next, /^node eden\.mjs act sit:e_9c01b32d '\{"seconds":3600\}' --wait/);
  assert.match(next, /the other 3600 s is for later: promise it only after `node eden\.mjs wake add at 2026-11-16T01:01:00Z`/);
  assert.deepEqual(secondsNext('sit:e_9c01b32d', d, { seconds: 600 }), {}, 'within the cap: nothing to defer');
  assert.deepEqual(secondsNext('sit:e_9c01b32d', { code: 'capability.unknown' }, { seconds: 7200 }), {});
});

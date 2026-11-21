// Tests for where a carried thing is put down (Soul Actions SA-F11, #2883). Each test is one acceptance item of the issue;
// cases are data in tools/entry/cases/placements.json, and the list of words is the one file packages/form-rules/placements.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const doc = JSON.parse(readFileSync(new URL('./cases/placements.json', import.meta.url), 'utf8'));
const listFile = JSON.parse(readFileSync(root + 'packages/form-rules/placements.json', 'utf8'));
const load = name => { const {entry, errors} = F.parseEntry(readFileSync(root + doc.kinds[name], 'utf8')); assert.deepEqual(errors, []); assert.deepEqual(F.validateEntry(entry), [], name); return entry; };
const kinds = Object.fromEntries(Object.keys(doc.kinds).map(k => [k, load(k)]));
// A case names one copy of each kind, so a name is also its node.
const run = c => F.place(kinds[c.thing], c.place, {
  anchor: c.place.anchor && kinds[c.place.anchor],
  facingAnchor: c.place.facing?.toward && kinds[c.place.facing.toward],
  node: c.thing, anchorNode: c.place.anchor,
});

test('the words are the list file\'s, in its order, and the format holds no list of its own', () => {
  assert.deepEqual(F.PLACE_WORDS, Object.keys(listFile.words));
  assert.deepEqual(F.FACINGS, Object.keys(listFile.facings));
  assert.deepEqual([...F.PLACE_WORDS], ['on', 'in', 'here', 'next_to', 'in_front_of', 'behind', 'against', 'facing', 'middle']);
  const src = readFileSync(root + 'tools/entry/format.mjs', 'utf8');
  assert.ok(!/['"]in_front_of['"]/.test(src), 'a word is written in the list file and nowhere else');
});

test('A1: the chair\'s placements each name their anchor and facing, in the shared words', () => {
  for (const c of doc.placements.filter(c => c.thing === 'chair')) {
    const r = run(c);
    assert.equal(r.ok, true, c.say);
    assert.equal(r.at, c.place.at, c.say);
    assert.equal(r.anchor, c.anchor, c.say);
    assert.deepEqual(r.facing, c.facing, c.say);
    assert.equal(r.moves, c.moves, c.say);
  }
  assert.ok(doc.placements.filter(c => c.thing === 'chair').length >= 6);
  assert.deepEqual(F.moveBy(kinds.chair, {act: 'carry'}), {ok: true, how: 'two_hands', hands: 2}, 'the chair is moved by the SA-F10 words');
});

test('A2: "behind" a thing with no front is refused by name', () => {
  assert.equal(kinds.round_table.geometry.front, 'none');
  for (const c of doc.refused) {
    const r = run(c);
    assert.equal(r.ok, false, c.say);
    assert.equal(r.code, c.code, c.say);
    assert.ok(r.reason.includes(c.reason_has), `${c.say}: ${r.reason}`);
  }
  const behind = run(doc.refused[0]);
  assert.match(behind.reason, /"behind".*eden:round_table/);
  assert.equal(run({thing: 'chair', place: {at: 'behind', anchor: 'table'}}).ok, true, 'a table with a front has a behind');
});

test('A3: turning the sofa to face the window changes its facing and nothing else', () => {
  const turn = doc.placements.find(c => c.say === 'turn the sofa to face the window');
  const r = run(turn);
  assert.deepEqual([r.ok, r.at, r.moves], [true, 'facing', false]);
  const before = {at_mm: [1200, 0, -800], facing: {kind: 'as_it_was'}, on: null, holder: null};
  // What a turn does to a placed thing, as the data says it: its facing is replaced; where it is, is not touched.
  const after = {...before, ...(r.moves ? {at_mm: null, on: r.anchor} : {}), facing: r.facing};
  assert.deepEqual(after, {...before, facing: {kind: 'toward', anchor: 'eden:window'}});
  // The sofa keeps its way of moving: a turn leaves a kind as it was.
  assert.equal(F.moveBy(kinds.sofa, {act: 'push'}).how, 'pushed_by_one');
});

test('A4: a form\'s placement takes only words on the list, and a case that uses another word fails', () => {
  const humanoid = F.parseEntry(readFileSync(root + 'content/kinds/body/humanoid.json', 'utf8')).entry;
  const entryWith = (step) => {
    const e = structuredClone(humanoid);
    e.forms.put_down = {who: 'anyone', starts: 'act', takes: {thing: {type: 'thing'}, target: {type: 'thing'}, chosen: {type: 'thing', select: {of: 'things', in: 'here', anchor: 'me', order: 'nearest', rank: 1}}}, needs: [], steps: [step], effects: []};
    return F.validateEntry(e).filter(x => x.path.startsWith('forms.put_down'));
  };
  for (const c of doc.forms.accepted) assert.deepEqual(entryWith({step: 'put', place: c.place}), [], c.say);
  for (const c of doc.forms.refused) {
    const step = {step: 'put', place: c.place};
    if (c.slot_too) step.slot = 'nothing';
    const errors = entryWith(step);
    assert.ok(errors.some(x => x.path.endsWith(c.path) && x.reason.includes(c.reason_has)), `${c.say}: ${JSON.stringify(errors)}`);
  }
  // Every word any case or any shipped kind uses is on the list; the one case that is not is the refusal of an unlisted word.
  const used = [];
  for (const c of [...doc.placements, ...doc.refused]) { used.push(c.place.at); const f = c.place.facing; if (f) used.push(typeof f === 'string' ? f : Object.keys(f)[0]); }
  const unlisted = used.filter(w => !F.PLACE_WORDS.includes(w) && !F.FACINGS.includes(w));
  assert.deepEqual(unlisted.sort(), ['beside', 'sideways'], 'only the two refusals of unlisted words');
  assert.deepEqual(doc.refused.filter(c => unlisted.includes(c.place.at) || unlisted.includes(c.place.facing)).map(c => c.code).sort(), ['unknown_facing', 'unknown_word']);
  const dirs = readdirSync(root + 'content/kinds');
  for (const d of dirs) for (const f of readdirSync(root + 'content/kinds/' + d).filter(f => f.endsWith('.json'))) {
    const e = F.parseEntry(readFileSync(root + `content/kinds/${d}/${f}`, 'utf8')).entry;
    // A word is written on the list, or given when the form is done as an argument of type placement (the body's put).
    for (const form of Object.values(e.forms ?? {})) for (const s of form.steps ?? []) if (s.place) assert.ok(typeof s.place.at === 'string' ? F.PLACE_WORDS.includes(s.place.at) : form.takes?.[s.place.at?.arg]?.type === 'placement', `${d}/${f}`);
  }
  assert.deepEqual(doc.front.accepted, [...F.FRONTS]);
  const bad = structuredClone(kinds.table); bad.geometry.front = doc.front.refused[0].set;
  assert.ok(F.validateEntry(bad).some(x => x.path === 'geometry.front' && x.reason.includes(doc.front.refused[0].reason_has)));
});

test('a front is part of a kind\'s meaning: the hash changes with it', () => {
  const a = structuredClone(kinds.table), b = structuredClone(a); b.geometry.front = 'none';
  assert.notEqual(F.hashKinds([a]).get('eden:table').ref, F.hashKinds([b]).get('eden:table').ref);
});

test('a thing is by itself by its node, not its entry: two chairs of one kind may be put next to each other', () => {
  const chair = kinds.chair;
  const two = F.place(chair, {at: 'next_to'}, {anchor: chair, node: 'chair1', anchorNode: 'chair2'});
  assert.deepEqual([two.ok, two.at, two.anchor], [true, 'next_to', 'eden:chair']);
  assert.equal(F.place(chair, {at: 'on'}, {anchor: chair, node: 'chair2', anchorNode: 'chair1'}).ok, true, 'one chair on another of its kind');
  const self = F.place(chair, {at: 'next_to'}, {anchor: structuredClone(chair), node: 'chair1', anchorNode: 'chair1'});
  assert.deepEqual([self.ok, self.code], [false, 'self'], 'one node is itself, whatever entry object it is handed with');
});

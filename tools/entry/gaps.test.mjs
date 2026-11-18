// The four gaps SA-X0 (#3024) found when it converted five old pull requests: a need on the state of the place a thing
// stands in, a timer that replaces its pending one, a need that names its refusal's words, and both hands empty. Each
// is accepted by the check gate where it is well formed and refused where it is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as C from './check.mjs';
import {effects} from '../../packages/form-rules/src/effects.ts';
import {loadKinds} from '../../packages/form-rules/src/load.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const collector = () => read('content/kinds/water/rain_collector.json');
const findings = entry => C.checkText(JSON.stringify(entry)).findings;
const clean = entry => assert.deepEqual(findings(entry), []);
const refused = (entry, path, word) => {
  const f = findings(entry);
  assert.ok(f.some(x => x.path === path && (!word || x.reason.includes(word))), `expected a finding at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(f)}`);
};
const NEEDS = 'forms.collect.needs';

test('a need on the place: a field of the place at the end of a link from "place", most 1, never a field of the tree', () => {
  const c = collector();
  clean(c);
  assert.deepEqual(c.forms.collect.needs[3], {need: 'state', link: 'place', field: 'rain', at_least: 101, says: 'no_rain'});
  assert.deepEqual(c.links.place, {n: 1, from: 'place', most: 1, audience: {rule: 'everyone'}});
  const thing = collector(); thing.links.place.from = 'thing'; refused(thing, `${NEEDS}.3.link`, 'from "place"');
  const many = collector(); many.links.place.most = 2; refused(many, `${NEEDS}.3.link`, 'most 1');
  const none = collector(); none.forms.collect.needs[3].link = 'roof'; refused(none, `${NEEDS}.3.link`, 'link type');
  const float = collector(); float.forms.collect.needs[3].at_least = 100.5; refused(float, `${NEEDS}.3.at_least`, 'whole number');
  const both = collector(); both.forms.collect.needs[3].is = 1; refused(both, `${NEEDS}.3`, 'not both');
  const words = collector(); words.forms.collect.needs[3] = {need: 'state', link: 'place', field: 'rain', is: 'pouring down'}; refused(words, `${NEEDS}.3.is`);
});

test('a timer is named by the form it starts: lit again, the lamp\'s new timer replaces its pending one', () => {
  clean(read('content/kinds/lights/crank_lamp.json'));
  const kinds = loadKinds();
  const lamp = (timers) => ({actor: 'b1', now_us: 20000000, moves: {press: {reach_mm: 600}}, nodes: {
    room: {loose: ['b1', 'l1']}, l1: {kind: 'eden:crank_lamp', fields: {charge: 3}, timers},
    b1: {hands: {left: null, right: null}, effector_mm: [0, 250, 200]}}});
  const timers = s => effects({kinds, act: {this: 'l1', form: 'shine_5s'}, state: s, receipt: 'r'}).timers;
  assert.deepEqual(timers(lamp([{id: 't1', form: 'goes_dark', due_us: 30000000}])), [{node: 'l1', form: 'goes_dark', after_us: 5000000, event: 2, replaces: ['t1']}]);
  assert.deepEqual(timers(lamp([{id: 't9', form: 'other', due_us: 30000000}])), [{node: 'l1', form: 'goes_dark', after_us: 5000000, event: 2}]);
  assert.deepEqual(timers(lamp(undefined)), [{node: 'l1', form: 'goes_dark', after_us: 5000000, event: 2}]);
});

test('a need names the words of its refusal by a key of the text table, never the words', () => {
  const c = collector();
  assert.deepEqual(c.forms.collect.needs.map(n => n.says), ['put_down_first', 'uncover_first', 'no_room', 'no_rain']);
  for (const n of c.forms.collect.needs) assert.equal(typeof c.text[n.says], 'string');
  const missing = collector(); missing.forms.collect.needs[0].says = 'nowhere'; refused(missing, `${NEEDS}.0.says`, 'text table');
  const inline = collector(); inline.forms.collect.needs[0].says = 'Put it down first.'; refused(inline, `${NEEDS}.0.says`);
});

test('both hands empty: {"need": "hand", "empty": true}, beside one hand free and a hand holding a kind', () => {
  const c = collector();
  assert.deepEqual(c.forms.collect.needs[0], {need: 'hand', empty: true, says: 'put_down_first'});
  const twice = collector(); twice.forms.collect.needs[0] = {need: 'hand', empty: true, free: true}; refused(twice, `${NEEDS}.0`, 'exactly one');
  const no = collector(); no.forms.collect.needs[0] = {need: 'hand', empty: false}; refused(no, `${NEEDS}.0.empty`, 'true');
});

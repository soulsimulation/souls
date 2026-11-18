// Tests for the body's pick_up, put and push and the format words they need (Soul Actions, follow-up of SA-P9 #2889):
// a reparent or remove of a thing argument, a reparent into `here`, `held_by_actor` of a thing argument, the `moves`
// need and a placement word given as an argument. The rule and effect cases are in packages/form-rules/cases/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';
import {CARRIED, NEEDS, PUSHED} from '../../packages/form-rules/src/rules.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const body = F.parseEntry(readFileSync(root + 'content/kinds/body/humanoid.json', 'utf8')).entry;
const thing = {type: 'thing'};
const errorsOf = (form) => {
  const e = structuredClone(body);
  e.forms.probe = {who: 'anyone', starts: 'act', needs: [], steps: [], effects: [], ...form};
  return F.validateEntry(e).filter(x => x.path.startsWith('forms.probe'));
};

test('the body carries, pushes and puts down a thing argument, and its entry validates', () => {
  assert.deepEqual(F.validateEntry(body), []);
  const f = body.forms;
  assert.deepEqual(f.pick_up.effects, [{change: 'reparent', what: {arg: 'thing'}, into: 'actor_hand', event: 'picked_up'}]);
  assert.deepEqual(f.pick_up.needs.map(n => n.need), ['hand', 'moves', 'within_reach']);
  assert.deepEqual(f.put.needs, [{need: 'held_by_actor', thing: {arg: 'thing'}}]);
  assert.deepEqual(f.put.steps, [{step: 'put', place: {at: {arg: 'at'}, anchor: {arg: 'anchor'}}}]);
  assert.equal(f.put.takes.anchor.select.anchor, 'me', 'the anchor is described by a selector');
  assert.deepEqual(f.push.needs.find(n => n.need === 'moves'), {need: 'moves', thing: {arg: 'thing'}, by: 'push'});
  // Each form walks to the thing it reaches: the walk is taken as done (reach to a loose thing).
  for (const n of ['pick_up', 'push']) assert.ok(f[n].steps.some(s => s.step === 'walk_to' && s.point?.arg === 'thing'), n);
});

test('the rules and the format share one list of needs and one table of how things move', () => {
  assert.deepEqual([...NEEDS].sort(), [...F.NEEDS].sort());
  assert.deepEqual({...CARRIED}, {...F.CARRIED});
  assert.deepEqual({...PUSHED}, {...F.PUSHED});
});

test('the new words validate, and their misuse is refused by name', () => {
  assert.deepEqual(errorsOf({takes: {thing}, effects: [{change: 'remove', what: {arg: 'thing'}, event: 'gone'}]}), []);
  assert.deepEqual(errorsOf({takes: {thing}, needs: [{need: 'moves', thing: {arg: 'thing'}, by: 'carry'}]}), []);
  const refused = [
    [{takes: {thing: {type: 'count'}}, effects: [{change: 'reparent', what: {arg: 'thing'}, into: 'here', event: 'x'}]}, 'effects.0.what', 'must be of type thing'],
    [{effects: [{change: 'reparent', what: 'someone', into: 'here', event: 'x'}]}, 'effects.0.what', 'or a thing argument'],
    [{takes: {thing}, needs: [{need: 'moves', thing: {arg: 'thing'}, by: 'throw'}]}, 'needs.0.by', 'carry, push'],
    [{needs: [{need: 'moves', thing: 'chair', by: 'carry'}]}, 'needs.0.thing', 'an argument of type thing'],
    [{needs: [{need: 'held_by_actor', thing: {arg: 'nothing'}}]}, 'needs.0.thing', 'not in takes'],
    [{takes: {at: {type: 'thing'}}, steps: [{step: 'put', place: {at: {arg: 'at'}}}]}, 'steps.0.place.at', 'must be of type placement'],
    [{takes: {at: {type: 'placement'}}, steps: [{step: 'put', place: {at: {arg: 'at'}, facing: 'as_it_was'}}]}, 'steps.0.place.facing', 'takes no facing'],
  ];
  for (const [form, path, has] of refused) {
    const errors = errorsOf(form);
    assert.ok(errors.some(x => x.path === `forms.probe.${path}` && x.reason.includes(has)), `${path}: ${JSON.stringify(errors)}`);
  }
});

// Two needs the format takes (a field in a whole-number range; a hand free or holding a kind), and the kettle's
// fill from a tap. Proposed on #2842 by the rules' owner; the kettle could not be filled before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const load = p => { const {entry, errors} = F.parseEntry(readFileSync(root + p, 'utf8')); assert.deepEqual(errors, []); return entry; };
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(errors)}`);
};

const base = () => {
  const k = load('content/kinds/kitchen/kettle.json');
  k.state.charge = {n: 3, type: 'int', unit: 'mC', default: 0, audience: {rule: 'everyone'}};
  k.state.rest = {n: 4, type: 'duration', default: 0, audience: {rule: 'everyone'}};
  return k;
};
const withNeed = n => { const k = base(); k.forms.pour.needs.push(n); return k; };
const P = 'forms.pour.needs.2';

test('A1: a field in a range is accepted; a malformed range is refused', () => {
  for (const good of [
    {need: 'state', field: 'charge', at_most: 900},
    {need: 'state', field: 'charge', at_least: 100, at_most: 900},
    {need: 'state', field: 'rest', at_least: 5}]) assert.deepEqual(F.validateEntry(withNeed(good)), [], JSON.stringify(good));
  refused(withNeed({need: 'state', field: 'charge', at_most: 0.5}), `${P}.at_most`, 'whole number');
  refused(withNeed({need: 'state', field: 'charge', at_least: 9, at_most: 1}), P, 'nothing is in that range');
  refused(withNeed({need: 'state', field: 'charge', at_most: 9, is: 3}), P, 'not both');
  refused(withNeed({need: 'state', field: 'water', at_most: 9}), `${P}.field`, 'int or duration');
  refused(withNeed({need: 'state', field: 'charge', at_most: 9, extra: 1}), `${P}.extra`, 'unknown key');
  refused(withNeed({need: 'state', field: 'charge'}), P, 'exactly one');
});

test('A1: a hand free or holding a kind is accepted; a malformed one is refused; a held kind is a reference', () => {
  for (const good of [{need: 'hand', free: true}, {need: 'hand', holds: 'eden:kettle'}]) assert.deepEqual(F.validateEntry(withNeed(good)), [], JSON.stringify(good));
  refused(withNeed({need: 'hand'}), P, 'exactly one');
  refused(withNeed({need: 'hand', free: true, holds: 'eden:cup'}), P, 'exactly one');
  refused(withNeed({need: 'hand', free: false}), `${P}.free`);
  refused(withNeed({need: 'hand', holds: 'cup'}), `${P}.holds`, 'namespace:name');
  assert.ok(F.kindRefs(withNeed({need: 'hand', holds: 'eden:cup'})).includes('eden:cup'));
});

test('A2: the kettle fills from a tap (data: the nearest thing of kind eden:tap), so its tea how-to runs from the default state', () => {
  const kettle = load('content/kinds/kitchen/kettle.json'), tap = load('content/kinds/kitchen/tap.json');
  assert.deepEqual(F.validateEntry(tap), []);
  assert.equal(tap.points.outlet.role, 'outlet');
  assert.ok(F.kindRefs(kettle).includes('eden:tap'));
  assert.equal(kettle.state.water.default, 'empty');
  const fill = kettle.forms.fill;
  assert.deepEqual(fill.needs.find(n => n.need === 'state'), {need: 'state', field: 'water', is: 'empty'});
  assert.ok(fill.needs.some(n => n.need === 'held_by_actor'));
  assert.deepEqual(fill.steps, [{step: 'move', move: 'fill', toward: {arg: 'from'}}]);
  assert.deepEqual(fill.effects.map(e => [e.field, e.to]), [['water', 'cold']]);
  assert.deepEqual(kettle.howtos.tea.steps.map(s => s.form), ['fill', 'switch_on', 'pour']);
  // Without the tap in its selector the fill would be a magic refill: the selector names the kind.
  assert.equal(fill.takes.from.select.kind, 'eden:tap');
});

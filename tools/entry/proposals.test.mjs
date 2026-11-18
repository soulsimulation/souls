// What other lanes proposed on #2842 for the format, accepted as posted: an activity's roles (SA-G1a), a draw (SA-F13), a
// timed value (SA-F5a), a transfer with a room need and int bounds (SA-F2b), a body's soul link (SA-F7a) and a ground
// posture with no slot (SA-G3). One accepted and one refused case each.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const load = p => { const {entry, errors} = F.parseEntry(readFileSync(root + p, 'utf8')); assert.deepEqual(errors, []); return entry; };
const accepted = entry => assert.deepEqual(F.validateEntry(entry), []);
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(errors)}`);
};
const everyone = {rule: 'everyone'};
const thing = (kind, more) => ({format: F.FORMAT, kind, owner: 'thing', geometry: {bounds_mm: [4000, 2000, 6000]}, forms: {}, ...more});

const lecture = () => thing('eden:talk', {
  links: {speaker: {n: 1, from: 'body', most: 1, audience: everyone}, listener: {n: 2, from: 'body', most: 120, audience: everyone}},
  slots: {lectern: {admits: 'body', most: 1, at_mm: [0, 0, -2000]}},
  roles: {
    speaker: {need: 'required', places: {in: 'this', slots: ['lectern']}},
    listener: {need: 'optional', places: {in: 'here', posture: 'sit', within_mm: 12000}},
  },
});

test('roles (SA-G1a): an activity\'s roles are accepted; a role whose place is not a body slot of the kind is refused', () => {
  assert.equal(F.SECTIONS.roles, 17);
  accepted(lecture());
  const k = lecture();
  k.slots.shelf = {admits: 'thing', most: 1, at_mm: [0, 1000, 0]};
  k.roles.speaker.places.slots = ['shelf'];
  refused(k, 'roles.speaker.places.slots.0', 'admits a body');
  const n = lecture(); n.roles.listener.need = 'maybe';
  refused(n, 'roles.listener.need', 'required');
});

const die = outcomes => thing('eden:die', {
  geometry: {bounds_mm: [16, 16, 16]},
  state: {face: {n: 1, type: 'int', unit: 'count', default: 1, audience: everyone}, practice: {n: 2, type: 'int', unit: 'count', default: 1, audience: everyone}},
  forms: {roll: {who: 'holder', starts: 'act', needs: [{need: 'held_by_actor'}], steps: [], effects: [{change: 'draw', outcomes}]}},
});
const row = (name, weight, to) => ({name, weight, event: `rolled_${name}`, set: [{field: 'face', to}]});

test('draw (SA-F13): a weighted table of outcomes is accepted; a weight that is neither whole nor an int field is refused', () => {
  accepted(die([row('one', 1, 1), row('two', 1, 2), row('lucky', {field: 'practice'}, 6)]));
  refused(die([row('one', -1, 1)]), 'forms.roll.effects.0.outcomes.0.weight', 'whole number');
  refused(die([row('one', 1, 1), row('one', 1, 2)]), 'forms.roll.effects.0.outcomes.1.name', 'already');
});

const timedKettle = () => thing('eden:timed_kettle', {
  geometry: {bounds_mm: [310, 300, 240]},
  state: {heat: {n: 1, type: 'timed', unit: 'mC', default: {value: 20000, per_s: 0, set_us: 0}, min: 20000, max: 100000, audience: everyone}},
  forms: {pour_boiling: {who: 'anyone', starts: 'act', needs: [{need: 'state', field: 'heat', at_least: 100000}], steps: [], effects: []}},
});

test('timed (SA-F5a): a value with a rate and the time it was set is accepted, with a range need on it; a malformed one is refused', () => {
  accepted(timedKettle());
  const k = timedKettle(); k.state.heat.default = {value: 20000, per_s: 0};
  refused(k, 'state.heat.default.set_us', 'world time');
  const b = timedKettle(); b.state.heat.min = 200000;
  refused(b, 'state.heat.min', 'above max');
});

const kettle = () => {
  const k = load('content/kinds/kitchen/kettle.json');
  k.state.water_g = {n: 4, type: 'int', unit: 'g', default: 0, min: 0, max: 1700, audience: everyone};
  k.forms.top_up = {who: 'holder', starts: 'act', takes: {from: {type: 'thing'}}, needs: [{need: 'held_by_actor'}, {need: 'room'}], steps: [],
    effects: [{change: 'transfer', field: 'water_g', from: {arg: 'from'}, into: 'this', amount: 'room', event: 'topped_up'}]};
  return k;
};

test('transfer and room (SA-F2b): a fill to the brim is accepted; room with no transfer, and room into a field with no max, are refused', () => {
  accepted(kettle());
  const k = kettle();
  k.forms.switch_on.needs.push({need: 'room'});
  refused(k, 'forms.switch_on.needs.3', 'no transfer');
  const m = kettle(); delete m.state.water_g.max;
  refused(m, 'forms.top_up.effects.0.amount', 'has none');
  const b = kettle(); b.state.heating.max = 1;
  refused(b, 'state.heating.max', 'only an int');
});

const body = more => ({format: F.FORMAT, kind: 'eden:humanoid', owner: 'family', state: {}, links: {soul: {n: 1, from: 'soul', most: 1, audience: everyone}}, forms: {}, ...more});

test('soul link (SA-F7a): a body\'s family declares its link to its Soul; a thing that declares one is refused', () => {
  accepted(body());
  refused({...body(), owner: 'thing'}, 'links.soul', 'body\'s family');
  const b = body(); b.links.soul.from = 'body';
  refused(b, 'links.soul', 'from "soul"');
});

test('settle (SA-G3): a ground posture where the body stands, with no slot, is accepted; a posture that is not a ground one is refused', () => {
  const form = posture => ({forms: {sit_on_ground: {who: 'anyone', starts: 'act', needs: [], steps: [{step: 'settle', posture}], effects: []}}});
  accepted(body(form('sit')));
  accepted(body(form('lie')));
  refused(body(form('stand')), 'forms.sit_on_ground.steps.0.posture', 'ground posture');
});

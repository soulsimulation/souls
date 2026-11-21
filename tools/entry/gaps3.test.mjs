// Three gaps SA-X2 (#3035) handed back: a `set` whose field or value comes from an argument (a choice from the form's
// own closed list), a need that any of several fields differs from a value, and plant parts in the shape language.
// Each is accepted by the check gate where it is well formed and refused where it is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as C from './check.mjs';
import {decide} from '../../packages/form-rules/src/rules.ts';
import {effects} from '../../packages/form-rules/src/effects.ts';
import {loadKinds} from '../../packages/form-rules/src/load.ts';
import {KIT_ROLES} from '../../packages/generators/src/kit.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const shrub = () => read('content/kinds/garden/pruning_shrub.json');
const sand = () => read('content/kinds/land/sand_garden.json');
const findings = entry => C.checkText(JSON.stringify(entry)).findings;
const clean = entry => assert.deepEqual(findings(entry), []);
const refused = (entry, path, word) => {
  const f = findings(entry);
  assert.ok(f.some(x => x.path === path && (!word || x.reason.includes(word))), `expected a finding at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(f)}`);
};

test('a field argument: a closed list of the form\'s own fields, used for a set, a need and a place', () => {
  const s = shrub();
  clean(s);
  assert.deepEqual(Object.keys(s.forms), ['prune']);
  assert.deepEqual(s.forms.prune.takes.shoot, {type: 'field', of: ['left_low', 'right_low', 'left_mid', 'right_mid', 'left_high', 'right_high']});
  const T = 'forms.prune.takes.shoot';
  const none = shrub(); delete none.forms.prune.takes.shoot.of; refused(none, `${T}.of`, 'two or more');
  const one = shrub(); one.forms.prune.takes.shoot.of = ['left_low']; refused(one, `${T}.of`, 'two or more');
  const twice = shrub(); twice.forms.prune.takes.shoot.of = ['left_low', 'left_low']; refused(twice, `${T}.of`, 'different');
  const stranger = shrub(); stranger.forms.prune.takes.shoot.of[5] = 'trunk'; refused(stranger, `${T}.of.5`, 'not a state field');
  const mixed = shrub(); mixed.forms.prune.takes.shoot.of[5] = 'cuttings'; refused(mixed, `${T}.of`, 'one type');
  const select = shrub(); select.forms.prune.takes.shoot.select = {of: 'things', in: 'here', anchor: 'me', order: 'nearest', rank: 1}; refused(select, `${T}.select`, 'unknown key');
  const listed = shrub(); listed.forms.prune.takes.pot = {type: 'thing', of: ['left_low', 'right_low']}; refused(listed, 'forms.prune.takes.pot.of', 'unknown key');
  // a set's value fits every field the argument may name
  const word = shrub(); word.forms.prune.effects[0].to = 'gone'; refused(word, 'forms.prune.effects.0.to', 'not a value of field "left_low"');
  // only a field argument names a field; a count argument does not
  const count = shrub(); count.forms.prune.takes.shoot = {type: 'count'}; refused(count, 'forms.prune.effects.0.field', 'type field');
  // used as a place, every choice names a point of this kind
  const pointless = shrub(); delete pointless.points.right_high; refused(pointless, 'forms.prune.steps.1.at', 'choice "right_high"');
  // a field argument is not a value
  const asValue = shrub(); asValue.forms.prune.effects[0].to = {arg: 'shoot'}; refused(asValue, 'forms.prune.effects.0.to', 'names a field');
});

test('a value argument: a closed list of values, each a value of every field it may be written to or compared with', () => {
  const g = sand();
  clean(g);
  assert.deepEqual(Object.keys(g.forms), ['brush', 'smooth']);
  assert.deepEqual(g.forms.brush.effects[0], {change: 'set', field: {arg: 'cell'}, to: {arg: 'pattern'}, event: 'brushed'});
  const bad = sand(); bad.forms.brush.takes.pattern.of = ['along', 'zigzag']; refused(bad, 'forms.brush.effects.0.to', 'not a value of field "back_left"');
  const need = sand(); need.forms.brush.takes.pattern.of = ['along', 'zigzag']; refused(need, 'forms.brush.needs.0.not', 'not a value');
  const words = sand(); words.forms.brush.takes.pattern.of = ['along', 'a swirl']; refused(words, 'forms.brush.takes.pattern.of');
});

test('the rules and effects read a choice, and refuse one the form does not list', () => {
  const kinds = loadKinds();
  const hands = {left: null, right: null};
  const state = {actor: 'b1', nodes: {sh1: {kind: 'eden:pruning_shrub'}, b1: {hands}}};
  const done = effects({kinds, act: {this: 'sh1', form: 'prune', args: {shoot: 'right_mid'}}, state, receipt: 'r1'});
  assert.deepEqual(done.changes, [
    {change: 'set', node: 'sh1', field: 'right_mid', n: 31, to: 0},
    {change: 'set', node: 'sh1', field: 'cuttings', n: 34, to: 1},
  ]);
  // a field of the shrub the form does not list is never written: refused before any need is read
  const v = decide({kinds, act: {this: 'sh1', form: 'prune', args: {shoot: 'cuttings'}}, state, asker: {sees: ['public']}});
  assert.equal(v.reason, 'bad_input');
  assert.deepEqual(v.detail, {what: 'not_a_choice', arg: 'shoot', value: 'cuttings'});
  assert.equal(effects({kinds, act: {this: 'sh1', form: 'prune', args: {shoot: 'cuttings'}}, state, receipt: 'r2'}).reason, 'bad_input');
  const missing = decide({kinds, act: {this: 'sh1', form: 'prune', args: {}}, state, asker: {sees: ['public']}});
  assert.deepEqual(missing.detail, {what: 'argument_missing', arg: 'shoot'});
  // the fix for a cell already brushed that way is the same act, the other way
  const brushed = {actor: 'b1', nodes: {sg1: {kind: 'eden:sand_garden', fields: {front_left: 'across'}}, b1: {hands}}};
  const no = decide({kinds, act: {this: 'sg1', form: 'brush', args: {cell: 'front_left', pattern: 'across'}}, state: brushed, asker: {sees: ['public']}});
  assert.deepEqual(no.fix, {form: 'brush', args: {cell: 'front_left', pattern: 'along'}});
});

test('a need that any of several fields differs from a value: the sand is already smooth', () => {
  const g = sand();
  assert.deepEqual(g.forms.smooth.needs[1], {need: 'any', fields: ['back_left', 'back_right', 'front_left', 'front_right'], not: 'smooth', says: 'already_smooth'});
  assert.equal(g.text.already_smooth, 'The sand is already smooth.');
  const N = 'forms.smooth.needs.1';
  const one = sand(); one.forms.smooth.needs[1].fields = ['back_left']; refused(one, `${N}.fields`, 'two or more');
  const twice = sand(); twice.forms.smooth.needs[1].fields = ['back_left', 'back_left']; refused(twice, `${N}.fields`, 'different');
  const stranger = sand(); stranger.forms.smooth.needs[1].fields[3] = 'rake'; refused(stranger, `${N}.fields.3`, 'state field');
  const open = sand(); delete open.forms.smooth.needs[1].not; refused(open, `${N}.not`, 'differs from');
  const arg = sand(); arg.forms.smooth.needs[1].not = {arg: 'pattern'}; refused(arg, `${N}.not`, 'written out');
  const odd = sand(); odd.forms.smooth.needs[1].not = 'wavy'; refused(odd, `${N}.not`, 'not a value');
  const extra = sand(); extra.forms.smooth.needs[1].is = 'along'; refused(extra, `${N}.is`, 'unknown key');
  const words = sand(); words.forms.smooth.needs[1].says = 'smooth_already'; refused(words, `${N}.says`, 'text table');
  const kinds = loadKinds();
  const state = {actor: 'b1', nodes: {sg1: {kind: 'eden:sand_garden'}, b1: {hands: {left: null, right: null}}}};
  const no = decide({kinds, act: {this: 'sg1', form: 'smooth'}, state, asker: {sees: ['public']}});
  assert.equal(no.says, 'already_smooth');
  assert.equal(no.need, 1);
});

test('plant parts are roles of the shape language, and the garden and land entries draw on them, not on limbs', () => {
  for (const r of ['stem', 'leaf', 'bloom', 'fruit', 'root', 'shoot.1', 'shoot.6', 'furrow.1', 'furrow.4']) assert.ok(KIT_ROLES.includes(r), r);
  const LIMB = /^(?:arm|wing|ear|leg|head|blade)(?:\.|$)/;
  for (const p of ['garden/pruning_shrub', 'garden/cutting_donor', 'garden/nursery_pot', 'garden/tomato', 'land/sand_garden']) {
    const e = read(`content/kinds/${p}.json`);
    const roles = [...e.looks.shape.shapes.map(s => s.role), ...e.looks.table.map(r => r.part)].filter(Boolean);
    assert.deepEqual(roles.filter(r => LIMB.test(r)), [], p);
    for (const r of roles) assert.ok(KIT_ROLES.includes(r), `${p}: ${r}`);
  }
});

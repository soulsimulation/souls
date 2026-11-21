// Two gaps SA-X1 (#3036) handed back: a need on the state of the thing an argument names, and a transfer between two
// fields of one thing with a need on the sum of fields. Each is accepted by the check gate where it is well formed and
// refused where it is not; the amounts a two-field transfer moves balance like any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as C from './check.mjs';
import {apply, effects} from '../../packages/form-rules/src/effects.ts';
import {loadKinds} from '../../packages/form-rules/src/load.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const grinder = () => read('content/kinds/food/coffee_grinder.json');
const caddy = () => read('content/kinds/food/tea_caddy.json');
const skewer = () => read('content/kinds/food/marshmallow_skewer.json');
const findings = entry => C.checkText(JSON.stringify(entry)).findings;
const clean = entry => assert.deepEqual(findings(entry), []);
const refused = (entry, path, word) => {
  const f = findings(entry);
  assert.ok(f.some(x => x.path === path && (!word || x.reason.includes(word))), `expected a finding at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(f)}`);
};

test('a need on the named thing: {"need": "state", "of": {"arg": <a thing argument>}, "field", ...}', () => {
  const g = grinder();
  clean(g);
  const DOSE = 'forms.dose.needs';
  assert.deepEqual(g.forms.dose.needs[1], {need: 'state', of: {arg: 'mug'}, field: 'dirt', at_most: 0, says: 'wash_first'});
  const bare = grinder(); bare.forms.dose.needs[1].of = 'mug'; refused(bare, `${DOSE}.1.of`, 'thing argument');
  const unknown = grinder(); unknown.forms.dose.needs[1].of = {arg: 'cup'}; refused(unknown, `${DOSE}.1.of`, 'not in takes');
  const count = grinder(); count.forms.dose.takes.mug = {type: 'count'}; refused(count, `${DOSE}.1.of`, 'type thing');
  const both = grinder(); both.forms.dose.needs[1].link = 'place'; refused(both, `${DOSE}.1`, 'not both');
  const float = grinder(); float.forms.dose.needs[1].at_most = 0.5; refused(float, `${DOSE}.1.at_most`, 'whole number');
  const words = grinder(); words.forms.dose.needs[1] = {need: 'state', of: {arg: 'mug'}, field: 'dirt', is: 'a bit grubby'}; refused(words, `${DOSE}.1.is`);
});

test('a need on the sum of fields: two or more int fields of one unit, now or as the form\'s transfers leave them', () => {
  const c = caddy();
  clean(c);
  const BLEND = 'forms.blend.needs';
  assert.deepEqual(c.forms.blend.needs[2], {need: 'sum', fields: ['well_green', 'well_mint'], at_most: 4, after_moves: true, says: 'well_full'});
  const one = caddy(); one.forms.blend.needs[2].fields = ['well_green']; refused(one, `${BLEND}.2.fields`, 'two or more');
  const twice = caddy(); twice.forms.blend.needs[2].fields = ['well_green', 'well_green']; refused(twice, `${BLEND}.2.fields`, 'different');
  const none = caddy(); none.forms.blend.needs[2].fields = ['well_green', 'teapot']; refused(none, `${BLEND}.2.fields.1`, 'int state field');
  const units = caddy(); units.state.well_mint.unit = 'g'; refused(units, `${BLEND}.2.fields`, 'one unit');
  const open = caddy(); delete open.forms.blend.needs[2].at_most; refused(open, `${BLEND}.2`, 'at_least and/or at_most');
  const no = caddy(); no.forms.blend.needs[2].after_moves = false; refused(no, `${BLEND}.2.after_moves`, 'leave it out');
  const still = caddy(); still.forms.take.needs.push({need: 'sum', fields: ['green', 'mint'], at_least: 1, after_moves: true}); refused(still, 'forms.take.needs.1.after_moves', 'no transfer');
});

test('a transfer between two fields of one thing: from and into "this", into_field another int field of one unit', () => {
  const c = caddy();
  const E = 'forms.blend.effects.0';
  assert.deepEqual(c.forms.blend.effects[0], {change: 'transfer', field: 'green', from: 'this', into: 'this', into_field: 'well_green', amount: {arg: 'green'}, event: 'green_added'});
  const same = caddy(); same.forms.blend.effects[0].into_field = 'green'; refused(same, `${E}.into_field`, 'other than field');
  const away = caddy(); away.forms.blend.takes.jar = {type: 'thing'}; away.forms.blend.effects[0].into = {arg: 'jar'}; refused(away, `${E}.into_field`, 'both "this"');
  const unnamed = caddy(); delete unnamed.forms.blend.effects[0].into_field; refused(unnamed, `${E}.into`, 'into_field');
  const units = caddy(); units.state.well_green.unit = 'g'; refused(units, `${E}.into_field`, 'different units');
  clean(skewer());
});

test('a two-field transfer balances: the turn moves one side\'s gold to the other, and a tampered amount is refused', () => {
  const kinds = loadKinds();
  const state = {actor: 'b1', nodes: {sk1: {kind: 'eden:marshmallow_skewer', fields: {heat: 1}}, b1: {hands: {left: 'sk1', right: null}}}};
  const done = effects({kinds, act: {this: 'sk1', form: 'turn'}, state, receipt: 'r1'});
  assert.deepEqual(done.changes, [
    {change: 'set', node: 'sk1', field: 'heat', n: 28, to: 0, by: -1},
    {change: 'set', node: 'sk1', field: 'back', n: 30, to: 1, by: 1},
  ]);
  const ok = apply(state, done);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.state.nodes.sk1.fields, {heat: 0, back: 1});
  const tampered = structuredClone(done); tampered.changes[1].by = 2; tampered.changes[1].to = 2;
  assert.deepEqual(apply(state, tampered), {ok: false, reason: 'amounts_do_not_balance', change: 0});
});

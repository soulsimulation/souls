// Format gaps the boards (SA-X11, #3045) and fire and light (SA-X3, #3051) conversions handed back: a need that the
// actor is at an end of a link, most_per counted per parent, an unlink of every end on this thing, a create that sets
// the made thing's fields, a need that a thing is in no hand, and a turn move. Each is accepted by the check gate where
// it is well formed and refused where it is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as C from './check.mjs';
import {validateMove} from './move.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => JSON.parse(readFileSync(root + p, 'utf8'));
const findings = entry => C.checkText(JSON.stringify(entry)).findings;
const clean = entry => assert.deepEqual(findings(entry), []);
const refused = (entry, path, word) => {
  const f = findings(entry);
  assert.ok(f.some(x => x.path === path && (!word || x.reason.includes(word))), `expected a finding at ${path}${word ? ` (${word})` : ''}, got ${JSON.stringify(f)}`);
};

test('a linked or unlinked need with end "actor": the actor is (not) at an end of the link', () => {
  const note = () => read('content/kinds/pinboard/pinned_note.json');
  const n = note();
  clean(n);
  assert.deepEqual(n.forms.take_down.needs[0], {need: 'linked', link: 'author', end: 'actor', says: 'not_your_note'});
  for (const p of ['content/kinds/notebook/notebook_line.json', 'content/kinds/signup/slot.json', 'content/kinds/posters/poster.json']) clean(read(p));
  const other = note(); other.forms.take_down.needs[0].end = 'this'; refused(other, 'forms.take_down.needs.0.end', 'actor');
  const stray = note(); stray.forms.take_down.needs[0].who = 'actor'; refused(stray, 'forms.take_down.needs.0.who', 'unknown key');
});

test('most_per counted per parent, and the need that reads it', () => {
  const line = () => read('content/kinds/guestbook/guestbook_line.json');
  const l = line();
  clean(l);
  clean(read('content/kinds/poll/poll_option.json'));
  assert.deepEqual(l.links.signer, {n: 1, from: 'soul', most: 1, most_per: 1, per: 'parent', audience: {rule: 'everyone'}});
  const world = line(); delete world.links.signer.per; refused(world, 'forms.sign.needs.2.link', 'per parent');
  const bare = line(); delete bare.links.signer.most_per; refused(bare, 'links.signer.per', 'declare most_per');
  const where = line(); where.links.signer.per = 'room'; refused(where, 'links.signer.per', 'parent');
  const extra = line(); extra.forms.sign.needs[2].end = 'actor'; refused(extra, 'forms.sign.needs.2.end', 'unknown key');
});

test('an unlink of every end of a link on this thing; a link is always the actor\'s', () => {
  const poster = () => read('content/kinds/posters/poster.json');
  const p = poster();
  clean(p);
  assert.deepEqual(p.forms.take_down_out_of_date.effects[0], {change: 'unlink', link: 'author', from: 'all', event: 'old_poster_taken_down'});
  const link = poster(); link.forms.put_up.effects[0].from = 'all'; refused(link, 'forms.put_up.effects.0.from', 'actor');
  const other = poster(); other.forms.take_down_out_of_date.effects[0].from = 'b2'; refused(other, 'forms.take_down_out_of_date.effects.0.from', 'all');
});

test('a create that sets the made thing\'s fields from values or value arguments', () => {
  const bench = () => read('content/kinds/candles/candle_mold_bench.json');
  const candle = read('content/kinds/candles/molded_candle.json');
  const b = bench();
  clean(b);
  clean(candle);
  const E = 'forms.mold.effects.2';
  const twice = bench(); twice.forms.mold.effects[2].set.push({field: 'shape', to: 'pillar'}); refused(twice, `${E}.set.2.field`, 'already set');
  const empty = bench(); empty.forms.mold.effects[2].set = []; refused(empty, `${E}.set`);
  const words = bench(); words.forms.mold.effects[2].set[1].to = 'sky blue'; refused(words, `${E}.set.1.to`);
  const count = bench(); count.forms.mold.takes.colour = {type: 'count'}; refused(count, `${E}.set.1.to`, 'type value');
  // checked against the made kind by the check gate (refs), with the kinds loaded
  const rows = entry => {
    const loaded = new Map([[candle.kind, candle], [entry.kind, entry]]);
    return C.madeFields(entry, loaded);
  };
  assert.deepEqual(rows(b), []);
  const stranger = bench(); stranger.forms.mold.effects[2].set[0].field = 'scent';
  assert.ok(rows(stranger).some(f => f.rule === 'refs' && f.path === `${E}.set.0` && f.reason.includes('not a state field')));
  const green = bench(); green.forms.mold.takes.colour.of = ['red', 'green'];
  assert.ok(rows(green).some(f => f.rule === 'refs' && f.reason.includes('"green" is not a value of "colour"')));
  const flag = bench(); flag.forms.mold.effects[2].set[0].to = true;
  assert.ok(rows(flag).some(f => f.reason.includes('true is not a value of "shape"')));
  // the whole tree passes the gate, refs included
  const all = C.checkFiles(['content/kinds/candles/candle_mold_bench.json', 'content/kinds/candles/molded_candle.json'].map(p => root + p));
  assert.deepEqual(all.flatMap(r => r.findings), []);
});

test('a need that the thing is in no hand', () => {
  const lantern = () => read('content/kinds/lights/oil_lantern.json');
  const l = lantern();
  clean(l);
  assert.deepEqual(l.forms.light.needs.at(-1), {need: 'not_in_hand', says: 'place_first'});
  assert.equal(l.text.place_first, 'Place the lantern on a surface before working its wick.');
  const param = lantern(); param.forms.light.needs[3].hand = 'left'; refused(param, 'forms.light.needs.3.hand', 'unknown key');
});

test('turn is a move: a grip held while the thing turns; a rope pull is the tug move', () => {
  const turn = read('content/moves/turn.json');
  assert.deepEqual(validateMove(turn), []);
  assert.ok(turn.phases.slide_us > 0, 'a middle phase: the hand stays on the grip while the thing turns');
  assert.ok(read('tools/entry/cases/moves.json').pose.some(c => c.move === 'turn' && c.record.to_mm.join() === c.record.contact_mm.join()));
  const step = (p, form) => read(p).forms[form].steps.find(s => s.step === 'move');
  assert.equal(step('content/kinds/timers/sand_timer.json', 'flip').move, 'turn');
  assert.equal(step('content/kinds/bells/damper_bell.json', 'ring').move, 'tug');
});

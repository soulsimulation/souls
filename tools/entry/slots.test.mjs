// Tests for slots and named points (Soul Actions SA-D3, #2855). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';
import {marksOf, shapeInMetres, defOf} from './look.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const load = p => { const {entry, errors} = F.parseEntry(readFileSync(root + p, 'utf8')); assert.deepEqual(errors, []); return entry; };
const cases = JSON.parse(readFileSync(new URL('./cases/slots.json', import.meta.url), 'utf8'));
const copy = v => structuredClone(v);
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}, got ${JSON.stringify(errors)}`);
};

test('A1: the kettle declares grip, spout, button and stand, in whole millimetres, and the look gate marks each', () => {
  const kettle = load('content/kinds/kitchen/kettle.json');
  assert.deepEqual(F.validateEntry(kettle), []);
  const roles = Object.fromEntries(Object.entries(kettle.points).map(([n, p]) => [n, p.role]));
  assert.deepEqual(roles, {grip: 'grip', button: 'contact', spout: 'outlet', stand: 'stand'});
  const marks = marksOf(kettle);
  assert.deepEqual(marks.map(m => m.name).sort(), ['button', 'grip', 'spout', 'stand']);
  assert.deepEqual(marks.find(m => m.name === 'spout').at, [0.268, 0.196, 0]);
  // the shape is whole numbers (the format took it), and is drawn in metres and radians
  const def = defOf(kettle);
  assert.equal(def.make.args.shapes[0].profile[1][0], 0.084);
  assert.ok(Math.abs(def.make.args.shapes[5].roll + 52 * Math.PI / 180) < 1e-12);
  assert.throws(() => shapeInMetres({kind: 'box', wobble: 3}), /"wobble"/);
});

test('A1: a float in a shape is refused by the format like a float anywhere', () => {
  const kettle = load('content/kinds/kitchen/kettle.json');
  const f = copy(kettle); f.looks.shape.round = 0.006;
  refused(f, 'looks.shape.round', 'floating-point');
});

test('A2: a point or slot outside the bounds by more than the margin is refused; at the margin it is accepted', () => {
  const kettle = load('content/kinds/kitchen/kettle.json');
  const [w, h] = kettle.geometry.bounds_mm;
  const ok = copy(kettle); ok.points.grip.at_mm = [w / 2 + F.POINT_MARGIN_MM, h + F.POINT_MARGIN_MM, 0];
  assert.deepEqual(F.validateEntry(ok), []);
  const far = copy(kettle); far.points.grip.at_mm = [w / 2 + F.POINT_MARGIN_MM + 1, 150, 0];
  refused(far, 'points.grip.at_mm', 'x = ');
  const up = copy(kettle); up.points.spout.at_mm = [268, h + F.POINT_MARGIN_MM + 1, 0];
  refused(up, 'points.spout.at_mm', 'y = ');
  const stand = copy(kettle); stand.points.stand.at_mm = [0, 0, 100 + F.STAND_MARGIN_MM + 1];
  refused(stand, 'points.stand.at_mm', 'z = ');
  const slot = load('content/kinds/kitchen/saucer.json'); slot.slots.cup.at_mm = [0, 15, 400];
  refused(slot, 'slots.cup.at_mm', 'z = ');
  const bare = copy(kettle); delete bare.geometry;
  refused(bare, 'geometry.bounds_mm', 'bounds');
});

test('A3: a slot that admits a cup refuses a kettle (cases)', () => {
  for (const c of cases.admits) {
    const r = F.admits(load(c.entry), c.slot, c.offered);
    assert.equal(r.ok, c.ok, JSON.stringify(c));
    if (c.reason_has) assert.ok(r.reason.includes(c.reason_has), r.reason);
  }
  const saucer = load('content/kinds/kitchen/saucer.json');
  const bad = copy(saucer); bad.slots.cup.kinds = ['cup'];
  refused(bad, 'slots.cup.kinds', 'namespace:name');
  const body = load('content/kinds/seating/bench.json'); body.slots.left.kinds = ['eden:cup'];
  refused(body, 'slots.left.kinds', 'thing slot');
});

test('A4: a copy of a row of theatre seats names its row and its ends', () => {
  const seats = load('content/kinds/seating/theatre_seats.json');
  assert.deepEqual(F.validateEntry(seats), []);
  const rows = F.rowsOf(seats);
  for (const c of cases.rows) assert.deepEqual(rows[c.row], {slots: c.slots, first: c.first, last: c.last});
  // an end left unnamed, a middle seat naming one, and a repeated place are refused, naming the slot
  const a = copy(seats); delete a.slots.front_3.end;
  refused(a, 'slots.front_3.end', 'last');
  const b = copy(seats); b.slots.front_2.end = 'first';
  refused(b, 'slots.front_2.end', 'middle');
  const c = copy(seats); c.slots.back_2.place = 3;
  refused(c, 'slots.back_2.place', 'twice');
  const d = copy(seats); delete d.slots.back_1.row;
  refused(d, 'slots.back_1.place', 'row');
});

// `souls-god.mjs apply-batch` (named.mjs): a souls-named-batch/1 file resolved on a copy shaped as import-eden's Eden
// (a building's floors and rooms, things on the open ground, a roof terrace, a deck with its floor) and sent as edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { editsOf, planOf, quatOfYaw, resolveName, indexOf, sendPlan } from './named.mjs';

const S = 'ab'.repeat(16), id = (n) => `${S}-${n}`;
const hex = (t) => ({ hex: Buffer.from(t).toString('hex') });
const named = (t) => ({ hex: createHash('sha256').update(t).digest('hex') });
const I = [2 ** 30, 0, 0, 0];
const on = (parent, at, q = I) => ({ frame: id(parent), at, orientation: q, support: { which: 1, node: id(parent), height: 0 } });
const node = (n, parent, kind, fields, pose) => ({ id: id(n), kind, parent: parent === null ? null : id(parent), fields, ...(pose ? { pose } : {}) });
const thing = (name, def, more = {}) => ({ 1: hex(`e_${name}`), 2: hex(def), 4: named(name), ...more });
const ring = [[7500, -2800], [10500, -2800], [10500, -800], [7500, -800]];

/** Eden in small: two towers each with an `entrance-lamp`, a door and a deck on the ground, a planter on a roof. */
function world() {
  return { format: 'souls-world/1', words: {}, nodes: [
    node(0, null, 'souls:place', {}),
    node(1, 0, 'eden:ground', { 1: hex('ground'), 24: 64000, 25: [] }, on(0, [0, 0, 0])),
    node(2, 1, 'eden:tower@x', thing('tower-a', 'core-tower@3'), on(1, [82600000, 9810000, -150000000])),
    node(3, 2, 'eden:floor@x', { 1: hex('e_a/floor-0') }, on(2, [0, 0, 0])),
    node(4, 3, 'eden:room@x', { 1: hex('e_a/entrance'), 4: named('Entrance') }, on(3, [0, 100000, 0])),
    node(5, 4, 'eden:floor_lamp@x', thing('entrance-lamp', 'core-floor-lamp@2'), on(4, [-2020000, 0, -2020000])),
    node(6, 1, 'eden:tower@x', thing('tower-b', 'core-tower@3'), on(1, [0, 0, 50000000])),
    node(7, 6, 'eden:floor@x', { 1: hex('e_b/floor-0') }, on(6, [0, 0, 0])),
    node(8, 7, 'eden:room@x', { 1: hex('e_b/entrance') }, on(7, [0, 0, 0])),
    node(9, 8, 'eden:floor_lamp@x', thing('entrance-lamp', 'core-floor-lamp@2'), on(8, [-2020000, 0, -2020000])),
    node(10, 1, 'eden:door@x', thing('tower-a-door-1', 'core-door@2'), on(1, [82600000, 9810000, -147610000])),
    // a townhouse turned a quarter turn, its planter on its roof floor
    node(11, 1, 'eden:townhouse@x', thing('home-6', 'core-townhouse@3'), on(1, [121000000, 0, 6650000], quatOfYaw(Math.PI / 2))),
    node(12, 11, 'eden:floor@x', { 1: hex('e_h/floor-4') }, on(11, [0, 0, 0])),
    node(13, 12, 'eden:planter_box@1220aa', thing('home-6-roof-planter', 'core-planter-box@1', { 12: [[0, 0, 300, 300, 0, 0, 500, 0, 0]] }), on(12, [-1500000, 11620000, 3300000])),
    node(14, 1, 'eden:deck@x', thing('deck', 'core-deck@1', { 11: ring, 19: hex('{"height":0.24,"rails":false}') }), on(1, [0, 0, 0])),
    node(15, 14, 'eden:floor@x', { 1: hex('e_d/floor-0'), 14: [[240, ring]] }, on(14, [0, 0, 0])),
    node(16, 15, 'eden:podium@x', thing('podium', 'core-podium@1'), on(15, [9000000, 240000, -2000000])),
    node(17, 1, 'eden:place@x', { 1: hex('e_deck.area'), 4: named('deck'), 20: 'eden:area' }, on(1, [0, 0, 0])),
  ] };
}
const flat = (x, z) => 0;
const BATCH = { schema: 'souls-named-batch/1', ops: [
  { op: 'move', node: 'tower-a/entrance-lamp', room: 'entrance', from: [-2.02, 0, -2.02], at: [0.8, 0, -0.8] },
  { op: 'turn', node: 'tower-a', def: 'core/tower@3', at_ground: [82.6, -150], from_r: 0, r: 1.5708 },
  { op: 'move', node: 'tower-a-door-1', def: 'core/door@2', from: [82.6, 9.81, -147.61], at: [84.99, 9.81, -150], from_r: 0, r: 1.5708 },
  { op: 'move-to-ground', node: 'home-6/home-6-roof-planter', from_roof: [-1.5, 0, 3.3], at_ground: [125.99, 5.82], r: 1.571 },
  { op: 'set-param', node: 'deck', def: 'core/deck@1', param: 'height', from: 0.24, to: 0.2 },
  { op: 'move', node: 'podium', from: [9, 0.24, -2], at: [9, 0.2, -2] },
] };

test('a name is resolved on the copy by its template name, inside its building; never guessed', () => {
  const ix = indexOf(world());
  assert.equal(resolveName(ix, 'tower-a/entrance-lamp').node.id, id(5));
  assert.equal(resolveName(ix, 'tower-b/entrance-lamp').node.id, id(9));
  assert.deepEqual(resolveName(ix, 'entrance-lamp'), { status: 'ambiguous', detail: '2 things are named entrance-lamp', choices: [id(5), id(9)] });
  assert.equal(resolveName(ix, 'tower-c/entrance-lamp').status, 'unresolved');
  assert.equal(resolveName(ix, 'nothing-here').status, 'unresolved');
  // the deck's named place (an area derived from it) shares its name and is not it
  assert.equal(resolveName(ix, 'deck', 'core/deck@1').node.id, id(14));
  assert.equal(resolveName(ix, 'tower-a', 'core/tower@4').status, 'def-differs');
});

test('each op becomes the creator\'s operations, in the parent\'s frame, support kept', () => {
  const plan = planOf(BATCH, world(), flat);
  assert.deepEqual(plan.map((e) => e.status), ['ready', 'ready', 'ready', 'ready', 'ready', 'ready']);
  const [lamp, turn, door, planter, deck, podium] = plan;
  assert.deepEqual(lamp.ops, [{ op: 'move', node: id(5), atUm: [800000, 0, -800000], orientation: I, support: { which: 1, node: id(4), height: 0 } }]);
  // turned in place: the same spot, a quarter turn
  assert.deepEqual(turn.ops[0].atUm, [82600000, 9810000, -150000000]);
  assert.deepEqual(turn.ops[0].orientation, quatOfYaw(1.5708));
  assert.deepEqual(door.ops[0].atUm, [84990000, 9810000, -150000000]);
  // off the roof: removed, and placed again on the open ground with its fields and name
  assert.deepEqual(planter.ops.map((o) => o.op), ['remove', 'place']);
  assert.equal(planter.ops[1].in, id(1));
  assert.deepEqual(planter.ops[1].atUm, [125990000, 0, 5820000]);
  assert.deepEqual(planter.ops[1].fields[4], named('home-6-roof-planter'));
  assert.deepEqual(planter.ops[1].fields[12], [[0, 0, 300, 300, 0, 0, 500, 0, 0]]);
  // the deck's params; its floor, now a step high, is ground cover: it goes, and the podium on it stands on the open
  // ground, placed where the file's later move puts it (a point in the world's frame)
  assert.equal(Buffer.from(deck.ops[0].value.hex, 'hex').toString(), '{"height":0.2,"rails":false}');
  assert.deepEqual(deck.ops.slice(1).map((o) => [o.op, o.in ?? o.node]), [['place', id(1)], ['remove', id(15)]]);
  assert.deepEqual(deck.ops[1].atUm, [9000000, 200000, -2000000]);
  assert.deepEqual(deck.ops[1].fields[4], named('podium'));
  assert.deepEqual([podium.status, podium.ops, podium.with], ['ready', [], 4]);
  // raised (or lowered above a step), the floor stays and its walked surface goes with the height
  const higher = planOf({ ops: [{ op: 'set-param', node: 'deck', param: 'height', from: 0.24, to: 0.3 }] }, world(), flat)[0];
  assert.deepEqual(higher.ops[1], { op: 'set', node: id(15), field: 14, value: [[300, ring]] });
});

test('a thing already where the op puts it sends nothing; one moved since is reported and skipped', () => {
  const w = world();
  const at = (n) => w.nodes.find((x) => x.id === id(n)).pose;
  at(5).at = [800000, 0, -800000];
  at(2).orientation = quatOfYaw(1.5708);
  at(16).at = [9000000, 200000, -2000000];
  w.nodes.find((x) => x.id === id(14)).fields[19] = hex('{"height":0.2}');
  at(10).at = [80000000, 9810000, -147610000]; // moved by hand since
  const plan = planOf(BATCH, w, flat);
  assert.deepEqual(plan.map((e) => e.status), ['already', 'already', 'moved-since', 'ready', 'already', 'already']);
  assert.deepEqual(plan.filter((e) => e.status !== 'ready').flatMap((e) => e.ops), []);
  // the planter, placed on the ground under its name, is already there on a second run
  const ground = w.nodes.findIndex((x) => x.id === id(13));
  w.nodes[ground] = { ...w.nodes[ground], parent: id(1), pose: on(1, [125990000, 0, 5820000], quatOfYaw(1.571)) };
  assert.equal(planOf(BATCH, w, flat)[3].status, 'already');
});

test('edits carry at most 256 operations each, in file order, each place named within its edit', () => {
  const plan = Array.from({ length: 300 }, (_, i) => ({ i, status: 'ready', ops: i % 100 === 0 ? [{ op: 'remove', node: `n${i}` }, { op: 'place', name: 1, kind: 'k' }, { op: 'set', node: 1, field: 11, value: [] }] : [{ op: 'move', node: `n${i}` }] }));
  const edits = editsOf(plan);
  assert.deepEqual(edits.map((e) => e.ops.length), [256, 50]);
  assert.deepEqual(edits[0].ops.filter((o) => o.op === 'place').map((o) => o.name), [1, 2, 3]);
  assert.deepEqual(edits[0].ops.filter((o) => o.op === 'set').map((o) => o.node), [1, 2, 3]);
  assert.equal(edits.flatMap((e) => e.entries).length, 300);
});

test('an edit the world refuses is sent again an op at a time, so each op has its own outcome', async () => {
  const plan = planOf(BATCH, world(), flat), sent = [];
  const ask = async (req) => { sent.push(req.ops.length); return req.ops.some((o) => o.node === id(10)) ? { ok: false, code: 'edit.would-bury' } : { ok: true }; };
  assert.equal(await sendPlan(plan, ask), 6);
  assert.deepEqual(plan.map((e) => e.status), ['applied', 'applied', 'refused', 'applied', 'applied', 'applied']);
  assert.equal(plan[2].code, 'edit.would-bury');
  assert.equal(sent[0], 8); // one edit first: 1 + 1 + 1 + 2 + 3 operations; the podium goes with the deck's
});

test('the open ground\'s height is read from the export\'s tiles, as the engine reads it', async () => {
  const { liftOf } = await import('./named.mjs');
  // one 64 m tile, 2 x 2 cells: heights 1, 2 m along x at z 0, 3, 4 m at z 64 m (3 x 3 samples, little-endian i32 mm)
  const h = Buffer.alloc(9 * 4);
  [1000, 1500, 2000, 2000, 2500, 3000, 3000, 3500, 4000].forEach((v, i) => h.writeInt32LE(v, i * 4));
  const w = { nodes: [{ id: id(1), fields: { 24: 64000, 25: [[0, 0, { hex: h.toString('hex') }, { hex: '00000000' }]] } }] };
  const lift = await liftOf(w);
  assert.equal(lift(0, 0), 1_000_000);
  assert.equal(lift(32_000_000, 32_000_000), 2_500_000);
  assert.equal(lift(-1, 0), null);
});

test('a turn past half a turn is written with the pose\'s sign rule: the first non-zero part positive', () => {
  for (const r of [3.1416, 4.7122, -1.571, 6.2]) {
    const q = quatOfYaw(r);
    assert.ok(q.find((c) => c !== 0) > 0, `${r}: ${q}`);
    assert.ok(Math.abs(Math.abs(q[2] / 2 ** 30) - Math.abs(Math.sin(r / 2))) < 1e-6);
  }
  const lighthouse = planOf({ ops: [{ op: 'turn', node: 'tower-a', at_ground: [82.6, -150], from_r: 0, r: 3.1416 }] }, world(), flat)[0];
  assert.ok(lighthouse.ops[0].orientation.find((c) => c !== 0) > 0);
});

test('an edit the world does not answer in time is never sent again: its ops are unanswered', async () => {
  const plan = planOf(BATCH, world(), flat);
  let sent = 0;
  assert.equal(await sendPlan(plan, async () => { sent++; return { ok: false, code: 'edit.unanswered' }; }), 1);
  assert.equal(sent, 1);
  assert.deepEqual([...new Set(plan.map((e) => e.status))], ['unanswered']);
});

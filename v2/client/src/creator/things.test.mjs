import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneFile, moveByOps } from './things.mjs';
import { importOf } from './genesis.mjs';

// A world: root, the open ground, a bench resting on it, a house on it with a room holding a chair, a doorway between
// the room and a place on the ground.
const pose = (at, extra = {}) => ({ frame: null, at, orientation: [1_000_000, 0, 0, 0], support: { which: 1, node: 'g', height: 0 }, ...extra });
const nodes = [
  { id: 'w', kind: 'eden:world@1', parent: null, fields: { 89: 'souls:dusk' } },
  { id: 'g', kind: 'eden:ground@1', parent: 'w', fields: { 24: 24000 } },
  { id: 'p', kind: 'eden:place@1', parent: 'g', fields: { 11: [[0, 0], [1000, 0], [1000, 1000]] } },
  { id: 'b', kind: 'eden:bench@1', parent: 'g', fields: { 1: { hex: '6262' } }, pose: pose([10_000_000, 2_000_000, 5_000_000]) },
  { id: 'h', kind: 'eden:house@1', parent: 'g', fields: {}, pose: pose([40_000_000, 1_000_000, 0]) },
  { id: 'r', kind: 'eden:room@1', parent: 'h', fields: { 22: [[{ id: 'l' }, 'x', 0, 0, 0, 900, 2000]] }, pose: pose([0, 0, 0], { support: { which: 1, node: 'h', height: 0 } }), links: [{ id: 'l', type: 'eden:doorway', ends: ['r', 'p'], owner: 0 }] },
  { id: 'c', kind: 'eden:chair@1', parent: 'r', fields: {}, pose: pose([1_000_000, 0, 0], { support: { which: 1, node: 'r', height: 0 } }) },
];
// The ground rises 1 mm a metre eastward: µm in, µm out.
const lift = (x) => Math.round(x / 1000);

test('move --by keeps facing, support and height over the ground; what is inside rides along', () => {
  const out = moveByOps(nodes, ['b', 'h', 'c'], [3, -1], { ground: 'g', lift });
  assert.equal(out.ops.length, 2, 'the chair rides with its house');
  assert.deepEqual(out.ops[0], { op: 'move', node: 'b', atUm: [13_000_000, 2_003_000, 4_000_000], orientation: [1_000_000, 0, 0, 0], support: { which: 1, node: 'g', height: 0 } });
  assert.equal(moveByOps(nodes, ['b'], [1, 0], { yaw: Math.PI, ground: 'g', lift }).ops[0].orientation[2], 1 << 30);
  assert.equal(moveByOps(nodes, ['b'], [1, 0], { ground: 'g', lift: () => null }).code, 'move.off-the-ground');
  assert.equal(moveByOps(nodes, ['nope'], [1, 0], {}).code, 'move.where');
  assert.deepEqual(moveByOps(nodes, ['p'], [1, 2], {}).ops, [{ op: 'set', node: 'p', field: 11, value: [[1000, 2000], [2000, 2000], [2000, 3000]] }]);
});

test('clone copies a thing and all in it, with its doorway, one step away, as an import', () => {
  const made = cloneFile(nodes, 'h', { count: 2, ground: 'g', lift, width: 4000 });
  const copies = made.file.nodes.filter((n) => n.id.startsWith('clone-'));
  assert.equal(copies.length, 6);
  const tops = copies.filter((n) => n.parent === 'g');
  assert.deepEqual(tops.map((n) => n.pose.at), [[46_000_000, 1_006_000, 0], [52_000_000, 1_012_000, 0]]);
  const plan = importOf(made.file, { nodes });
  const first = plan.next();
  assert.deepEqual(first.map((o) => [o.op, o.kind, o.in]), [['place', 'eden:house@1', 'g'], ['place', 'eden:house@1', 'g']]);
  plan.took({ 1: 'H1', 2: 'H2' });
  const rooms = plan.next();
  assert.deepEqual(rooms.map((o) => [o.kind, o.in, o.support.node]), [['eden:room@1', 'H1', 'H1'], ['eden:room@1', 'H2', 'H2']]);
  plan.took({ 1: 'R1', 2: 'R2' });
  assert.deepEqual(plan.next().map((o) => [o.kind, o.in]), [['eden:chair@1', 'R1'], ['eden:chair@1', 'R2']]);
  plan.took({ 1: 'C1', 2: 'C2' });
  const links = plan.next();
  assert.deepEqual(links.map((o) => [o.op, o.ends]), [['link', ['R1', 'p']], ['link', ['R2', 'p']]]);
  plan.took({});
  assert.equal(plan.next(), null);
  assert.equal(plan.left(), 0);
  assert.equal(cloneFile(nodes, 'b', { at: [1, 2] }).file.nodes.find((n) => n.id === 'clone-0-b').pose.at[0], 1_000_000);
  assert.equal(cloneFile(nodes, 'b', { count: 101 }).code, 'clone.count');
  assert.equal(cloneFile(nodes, 'w').code, 'clone.where');
});

test('select by kind, name, parent, area and distance; a removal leaves out what goes with its parent', async () => {
  const { selectOf, removeOps, spotsOf } = await import('./things.mjs');
  const spots = spotsOf(nodes);
  assert.deepEqual([spots.get('c').x, spots.get('c').z], [41, 0], 'the chair is 1 m along its house at 40 m');
  assert.deepEqual([spots.get('p').x, spots.get('p').z].map((v) => Math.round(v * 1000)), [667, 333], 'a shape at its points\' middle');
  assert.deepEqual(selectOf(nodes, { kind: 'chair' }).map((r) => r.id), ['c']);
  assert.deepEqual(selectOf(nodes, { name: 'BB' }).map((r) => r.id), ['b']);
  assert.deepEqual(selectOf(nodes, { in: 'h' }).map((r) => r.id), ['c'], 'rooms and floors are a building\'s own parts');
  assert.deepEqual(selectOf(nodes, { area: [30, -5, 50, 5] }).map((r) => r.id), ['h', 'c']);
  assert.deepEqual(selectOf(nodes, { near: [10, 5], radius: 1 }).map((r) => r.id), ['b']);
  assert.deepEqual(removeOps(nodes, ['h', 'c', 'b']), [{ op: 'remove', node: 'h' }, { op: 'remove', node: 'b' }]);
});

test('select --near and --area find what stands in a room on a building\'s floor, at its place on the ground (#5006 row 30)', async () => {
  const { selectOf, spotsOf } = await import('./things.mjs');
  // as the template's halls are: a hall at (14, -8), its floor, a room on it with its outline in its own frame, a chair
  // 1.4 m north of the room's middle; a second hall turned a quarter, its chair 1 m along the room's x
  const q = (yaw) => [Math.round(Math.cos(yaw / 2) * (1 << 30)), 0, Math.round(Math.sin(yaw / 2) * (1 << 30)), 0];
  const at = (x, y, z, yaw = 0) => ({ frame: null, at: [x, y, z], orientation: q(yaw), support: { which: 1, node: 'g', height: 0 } });
  const box = [[-4780, -3780], [4780, -3780], [4780, 3780], [-4780, 3780]];
  const hall = [
    { id: 'w', kind: 'eden:world@1', parent: null, fields: {} },
    { id: 'g', kind: 'eden:ground@1', parent: 'w', fields: {} },
    { id: 'h', kind: 'eden:hall@1', parent: 'g', fields: {}, pose: at(14_000_000, 0, -8_000_000) },
    { id: 'f', kind: 'eden:floor@1', parent: 'h', fields: {}, pose: at(0, 0, 0) },
    { id: 'r', kind: 'eden:room@1', parent: 'f', fields: { 11: box }, pose: at(0, 100_000, 0) },
    { id: 'c', kind: 'eden:chair@1', parent: 'r', fields: {}, pose: at(0, 0, -1_400_000) },
    { id: 'h2', kind: 'eden:hall@1', parent: 'g', fields: {}, pose: at(-30_000_000, 0, 0, Math.PI / 2) },
    { id: 'f2', kind: 'eden:floor@1', parent: 'h2', fields: {}, pose: at(0, 0, 0) },
    { id: 'r2', kind: 'eden:room@1', parent: 'f2', fields: { 11: box }, pose: at(0, 100_000, 0) },
    { id: 'c2', kind: 'eden:chair@1', parent: 'r2', fields: {}, pose: at(1_000_000, 0, 0) },
  ];
  const spots = spotsOf(hall), round = (s) => [s.x, s.z].map((v) => Math.round(v * 100) / 100 + 0);
  assert.deepEqual(round(spots.get('r')), [14, -8], 'the room at its middle, in the hall');
  assert.deepEqual(round(spots.get('c')), [14, -9.4], 'the chair in the room, where the hall is');
  assert.deepEqual(round(spots.get('c2')), [-30, -1], 'a turned hall turns what is in it');
  assert.deepEqual(selectOf(hall, { near: [14, -8], radius: 3 }).map((r) => r.id), ['h', 'c']);
  assert.deepEqual(selectOf(hall, { area: [13, -10, 15, -9] }).map((r) => r.id), ['c']);
  assert.deepEqual(selectOf(hall, { near: [0, -1.4], radius: 1 }), [], 'nothing is matched in the room\'s own frame');
});

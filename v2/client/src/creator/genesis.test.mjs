// A creator's world import (#3728): the plan an export file makes against a world, with no daemon and no world.
// The served proof (full Eden exported and imported through `node eden.mjs god`) is in the pull request.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FORMAT, OPS_MOST, batchValue, depthOf, importOf } from './genesis.mjs';
import { requestOf } from './souls-god.mjs';

const S = '0'.repeat(32), T = 'f'.repeat(32);
const node = (id, kind, parent, fields = {}, extra = {}) => ({ id, kind, parent, fields, pose: { frame: parent, at: [1000, 0, 2000], orientation: [1073741824, 0, 0, 0], support: { which: 1, node: parent, height: 0 } }, ...extra });
const world = (scope, rest = []) => ({ format: FORMAT, nodes: [
  { id: `${scope}-0`, kind: 'souls:place@1', parent: null, fields: { 60: 1, 89: 'souls:eden-summer' } },
  node(`${scope}-1`, 'eden:ground@1', `${scope}-0`, { 24: 64000, 25: [[0, 0, { hex: '00' }, { hex: '01' }]] }),
  ...rest,
] });
const drain = (plan, answer = (ops) => Object.fromEntries(ops.filter((o) => o.op === 'place').map((o) => [o.name, `${T}-${100 + o.name}`]))) => {
  const edits = [];
  for (let ops; (ops = plan.next());) { edits.push(ops); plan.took(answer(ops)); }
  return edits;
};

test('a world into itself: every node is matched by id and nothing is sent', () => {
  const w = world(S, [node(`${S}-2`, 'eden:bench@1', `${S}-1`, { 4: { hex: 'aa' } })]);
  const plan = importOf(w, w);
  assert.deepEqual(drain(plan), []);
  assert.equal(plan.counts.matched, 3);
});

test('into a new world: the root and the one ground are matched, their differing fields set, the rest placed parents first', () => {
  const file = world(S, [
    node(`${S}-2`, 'eden:house@1', `${S}-1`),
    node(`${S}-3`, 'eden:floor@1', `${S}-2`, { 14: [[100, [[0, 0], [1, 1]]]] }),
    node(`${S}-4`, 'eden:chair@1', `${S}-3`, { 9: [{ id: `${S}-2` }, 1] }),
  ]);
  file.nodes[0].fields[89] = 'souls:dusk';
  file.nodes[1].fields[25] = [[0, 0, { hex: '02' }, { hex: '01' }]];
  const plan = importOf(file, world(T));
  const edits = drain(plan);
  // The palette and the tiles (sets), then one edit per level: house, floor, chair.
  assert.deepEqual(edits[0].map((o) => [o.op, o.node, o.field]), [['set', `${T}-0`, 89], ['set', `${T}-1`, 25]]);
  assert.deepEqual(edits.slice(1).map((ops) => ops.map((o) => o.op)), [['place'], ['place', 'set'], ['place']]);
  const [house, floor, chair] = edits.slice(1).map((ops) => ops[0]);
  assert.equal(house.in, `${T}-1`);
  assert.deepEqual(house.support, { which: 1, node: `${T}-1`, height: 0 });
  assert.deepEqual(house.atUm, [1000, 0, 2000]);
  assert.equal(floor.in, `${T}-101`);
  // The floor's outlines are 4 deep: set on the new node in the same edit, not carried by the place.
  assert.equal(floor.fields[14], undefined);
  assert.deepEqual(edits[2][1], { op: 'set', node: 1, field: 14, value: [[100, [[0, 0], [1, 1]]]] });
  // An id in a field is the node it became.
  assert.deepEqual(chair.fields[9], [[{ hex: T }, 101], 1]);
  assert.equal(plan.left(), 0);
  assert.equal(plan.counts.placed, 3);
});

test('a field naming a link is not brought over, and is counted', () => {
  const file = world(S, [node(`${S}-2`, 'eden:door@1', `${S}-1`, { 7: { id: `${S}-900` }, 5: 0 }, { links: [] }), { ...node(`${S}-3`, 'eden:room@1', `${S}-1`), links: ['eden:doorway'] }]);
  const plan = importOf(file, world(T));
  const [ops] = drain(plan);
  assert.deepEqual(ops[0].fields, { 5: 0 });
  assert.equal(plan.counts.links, 1);
  assert.deepEqual(Object.fromEntries(plan.counts.droppedFields), { 'eden:door 7': 1 });
});

test('a level of more than OPS_MOST places goes in several edits, each within the limit', () => {
  const many = Array.from({ length: OPS_MOST + 10 }, (_, k) => node(`${S}-${k + 2}`, 'eden:tree@1', `${S}-1`));
  const edits = drain(importOf(world(S, many), world(T)));
  assert.deepEqual(edits.map((e) => e.length), [OPS_MOST, 10]);
});

test('values: bytes, ids, depth', () => {
  assert.deepEqual(batchValue({ hex: 'ab' }, new Map()), { hex: 'ab' });
  assert.equal(batchValue([{ id: 'x-1' }], new Map()), null);
  assert.equal(depthOf([[1, [[2, 3]]]]), 4);
  assert.equal(depthOf({ hex: '00' }), 0);
  assert.throws(() => importOf({ format: 'genesis/1' }, world(T)), { code: 'import.format' });
});

test('the command: export and import take a file, made absolute', () => {
  assert.match(requestOf(['export']).req.file, /\/world\.souls\.json$/);
  assert.equal(requestOf(['import', '/w/a.json']).req.file, '/w/a.json');
  assert.throws(() => requestOf(['import']), { code: 'usage' });
});

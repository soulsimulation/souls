// A creator's where, clear and free (#3699 follow-on), read from the page's drawn world. The browser is a stand-in here:
// its page runs `gatherSpace` against a small drawn world in this process.
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blocking, clearOf, freeOf, gatherSpace, inside, overlap, parseSpace, runSpace, whereOf } from './space.mjs';

// The plaza (an area, 40 m square around 0,0); a house's room from x 10 to 20, z -5 to 5; a 2 x 1 m bench at 0,-3;
// a lamp with no solids at 4,0; a Soul at 1,1.
function drawn() {
  const frame = (x, y, z) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] });
  const nodes = new Map([
    ['s.0', { id: 's.0', kind: 'eden:ground@x', parent: null, at: null }],
    ['s.1', { id: 's.1', kind: 'eden:place@x', parent: 's.0', at: null, outline: [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]] }],
    ['s.2', { id: 's.2', kind: 'eden:room@x', parent: 's.0', at: null, outline: [[10000, -5000], [20000, -5000], [20000, 5000], [10000, 5000]] }],
    ['s.3', { id: 's.3', kind: 'eden:bench@x', parent: 's.1', at: null, solids: [[0, 0, 1000, 500, 0, 0, 450]] }],
    ['s.4', { id: 's.4', kind: 'eden:lamp@x', parent: 's.1', at: null }],
    ['s.5', { id: 's.5', kind: 'souls:body@x', parent: 's.1', at: 1 }],
  ]);
  const pos = { 's.3': [0, 0, -3], 's.4': [4, 0, 0], 's.5': [1, 0, 1] };
  const names = { 's.1': 'plaza', 's.2': 'house room', 's.3': 'bench 3', 's.4': 'lamp 4', 's.5': 'Bea' };
  const roles = { 's.1': 'place', 's.2': 'place', 's.5': 'soul' };
  const spot = (id) => ({ id, name: names[id], role: roles[id] ?? 'thing' });
  globalThis.v2 = {
    world: { nodes, tracks: new Map(), frame: (id) => frame(...(pos[id] ?? [0, 0, 0])) },
    director: { t: 5 },
    capture: {
      where: () => [...nodes.keys()].filter((id) => names[id]).map(spot),
      aim: (asked) => { const id = [...nodes.keys()].find((k) => k === asked || names[k] === asked); return id ? { spot: spot(id), aim: null } : null; },
    },
  };
  const page = { evaluate: async (f, arg) => f(arg), goto: async () => {}, waitForFunction: async () => {} };
  return { chromium: { launchPersistentContext: async () => ({ pages: () => [page], clearCookies: async () => {}, close: async () => {} }) } };
}

globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };

test('the arguments, as today\'s', () => {
  assert.deepEqual(parseSpace('where', ['3,-4']), { verb: 'where', at: '3,-4', page: null });
  assert.deepEqual(parseSpace('clear', ['plaza', '--size', '10x8']).size, [10, 8]);
  assert.deepEqual(parseSpace('free', ['10x8', '--near', 'plaza']), { verb: 'free', at: 'plaza', size: [10, 8], page: null });
  for (const [v, a] of [['where', []], ['clear', ['1,1']], ['clear', ['1,1', '--size', '10']], ['free', ['10x8']], ['reach', ['a', 'b']]]) {
    assert.throws(() => parseSpace(v, a), { code: 'usage' }, `${v} ${a.join(' ')}`);
  }
});

test('plan geometry', () => {
  const sq = [[0, 0], [2, 0], [2, 2], [0, 2]];
  assert.ok(inside(sq, [1, 1]) && !inside(sq, [3, 1]));
  assert.ok(overlap(sq, [[1, 1], [3, 1], [3, 3], [1, 3]]), 'corners inside');
  assert.ok(overlap(sq, [[-1, 0.5], [3, 0.5], [3, 1.5], [-1, 1.5]]), 'edges cross, no corner inside');
  assert.ok(!overlap(sq, [[3, 0], [4, 0], [4, 1], [3, 1]]));
});

test('where: the room and areas holding the point, and the nearest things', () => {
  drawn();
  const at = whereOf(gatherSpace(['15,0', 80]));
  assert.deepEqual(at.room, { id: 's-2', name: 'house room' });
  assert.deepEqual(at.areas.map((a) => a.name), ['plaza']);
  assert.deepEqual(at.nearest.map((n) => n.name), ['lamp 4', 'Bea', 'bench 3']);
  assert.equal(at.nearest[1].soul, true);
  const bench = whereOf(gatherSpace(['bench 3', 80]));
  assert.deepEqual([bench.at, bench.of.id, bench.room, bench.nearest[0].name], [[0, -3], 's-3', null, 'Bea'], 'not itself');
  assert.equal(gatherSpace(['nowhere', 80]).code, 'nothing-by-that-name');
});

test('clear: a footprint over a bench, a lamp or a room is not; open plaza is', () => {
  drawn();
  const g = (at) => gatherSpace([at, 80]);
  assert.deepEqual(clearOf(g('0,-3'), [1, 1]).blocked_by.map((b) => b.name), ['bench 3']);
  assert.deepEqual(clearOf(g('4,0'), [0.4, 0.4]).blocked_by.map((b) => b.name), ['lamp 4'], 'a thing with no solids is a small disc');
  assert.deepEqual(clearOf(g('9,0'), [4, 2]).blocked_by, [{ id: 's-2', name: 'house room', room: true }]);
  assert.equal(clearOf(g('-8,8'), [6, 6]).clear, true);
  assert.equal(clearOf(g('1,1'), [1, 1]).clear, true, 'a Soul stands on ground; it never fills it');
  assert.equal(blocking(g('bench 3'), [0, -3], [1, 1]).length, 0, 'the asked-about thing aside');
});

test('free: the nearest free footprint outward from the point', () => {
  drawn();
  const f = freeOf(gatherSpace(['0,-3', 140]), [2, 2]);
  assert.equal(f.distance, 2);
  assert.equal(clearOf({ ...gatherSpace(['0,-3', 140]), point: f.at }, [2, 2]).clear, true);
  const none = freeOf(gatherSpace(['15,0', 140]), [30, 30], 3);
  assert.deepEqual([none.at, none.within], [null, 3]);
});

test('read through the page, answered as JSON', async () => {
  const pw = drawn(), home = mkdtempSync(join(tmpdir(), 'space-'));
  const a = await runSpace('clear', ['0,-3', '--size', '1x1', '--page', 'https://soul.example/v2/'], { home, pw });
  assert.deepEqual([a.ok, a.clear, a.t], [true, false, 5]);
  const w = await runSpace('where', ['lamp 4', '--page', 'https://soul.example/v2/'], { home, pw });
  assert.deepEqual(w.areas.map((x) => x.name), ['plaza']);
  await assert.rejects(runSpace('where', ['nowhere', '--page', 'https://soul.example/v2/'], { home, pw }), { code: 'nothing-by-that-name' });
  await assert.rejects(runSpace('where', ['1,1', '--page', 'https://soul.example/v2/'], { home, pw: null }), { code: 'no-browser' });
});

// A creator's where, clear and free (#3699 follow-on), read from the page's drawn world, and (#5006 finding 5) from the
// creator's copy with no browser, as `look` in words is. The browser is a stand-in here: its page runs `gatherSpace`
// against a small drawn world in this process.
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blocking, clearOf, copySpace, freeOf, gatherSpace, inside, overlap, parseSpace, runLook, runSpace, whereOf } from './space.mjs';

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

// #5006 finding 5: the same reads from the creator's copy (the daemon's `space` answer), with no browser.
const Q = 2 ** 30, YAW90 = [Math.round(Math.cos(Math.PI / 4) * Q), 0, Math.round(Math.sin(Math.PI / 4) * Q), 0];
const um = (x, y, z) => [x * 1e6, y * 1e6, z * 1e6];
/** drawn()'s world as the copy holds it, and a cottage turned a quarter at 100,0: a room, a table, a cup in its slot. */
function copied() {
  return [
    { id: 'w-0', name: 'the world', kind: 'souls:place@x', parent: null },
    { id: 'k-0', name: 'kind 0', kind: 'souls:kind@x', parent: 'w-0' },
    { id: 's-0', name: 'ground 0', kind: 'eden:ground@x', parent: 'w-0' },
    { id: 's-1', name: 'plaza', kind: 'eden:place@x', parent: 's-0', outline: [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]], aliases: ['the square'] },
    { id: 's-2', name: 'house room', kind: 'eden:room@x', parent: 's-0', outline: [[10000, -5000], [20000, -5000], [20000, 5000], [10000, 5000]] },
    { id: 's-3', name: 'bench 3', kind: 'eden:bench@x', parent: 's-1', pos: um(0, 0, -3), solids: [[0, 0, 1000, 500, 0, 0, 450]] },
    { id: 's-4', name: 'lamp 4', kind: 'eden:lamp@x', parent: 's-1', pos: um(4, 0, 0) },
    { id: 's-5', name: 'Bea', kind: 'souls:body@x', parent: 's-1', pos: um(1, 0, 1), soul: 'ab-1' },
    { id: 's-6', name: 'footpath 6', kind: 'eden:footpath@x', parent: 's-0', line: [[0, 0], [5000, 0]] },
    { id: 'b-1', name: 'cottage 1', kind: 'eden:cottage@x', parent: 's-0', pos: um(100, 0, 0), rot: YAW90, solids: [[2000, 1000, 2100, 1100, 0, 0, 3000]] },
    { id: 'b-2', name: 'floor 2', kind: 'eden:floor@x', parent: 'b-1' },
    { id: 'b-3', name: 'kitchen', kind: 'eden:room@x', parent: 'b-2', outline: [[0, 0], [4000, 0], [4000, 2000], [0, 2000]] },
    { id: 'b-4', name: 'table 4', kind: 'eden:table@x', parent: 'b-3', pos: um(1, 0, 1), slots: [[1, 500, 0, 0, 90000, 1]], solids: [[0, 0, 500, 250, 0, 0, 700]] },
    { id: 'b-5', name: 'cup 5', kind: 'eden:cup@x', parent: 'b-4', slot: 1 },
  ];
}
const asking = (nodes = copied()) => { const asked = []; const ask = async (r) => { asked.push(r.op); return r.op === 'space' ? { ok: true, nodes, at: 42 } : { ok: false, code: 'unknown-op' }; }; return { ask, asked }; };

test('the copy gives the page\'s answers for the same world', () => {
  const s = copySpace(copied()), g = (at, reach = 80) => s.gather(at, reach);
  const at = whereOf(g('15,0'));
  assert.deepEqual(at.room, { id: 's-2', name: 'house room' });
  assert.deepEqual(at.areas.map((a) => a.name), ['plaza']);
  assert.deepEqual(at.nearest.map((n) => n.name), ['lamp 4', 'Bea', 'bench 3'], 'no world, ground, kind, area or footpath among things');
  assert.equal(at.nearest[1].soul, true);
  assert.deepEqual(clearOf(g('0,-3'), [1, 1]).blocked_by.map((b) => b.name), ['bench 3']);
  assert.deepEqual(clearOf(g('4,0'), [0.4, 0.4]).blocked_by.map((b) => b.name), ['lamp 4']);
  assert.deepEqual(clearOf(g('9,0'), [4, 2]).blocked_by, [{ id: 's-2', name: 'house room', room: true }]);
  assert.equal(clearOf(g('2.5,0.5'), [1, 0.4]).clear, true, 'a footpath and a Soul never fill ground');
  const f = freeOf(g('0,-3', 140), [2, 2]);
  assert.equal(f.distance, 2);
  assert.equal(clearOf({ ...g('0,-3', 140), point: f.at }, [2, 2]).clear, true);
});

test('frames compose as the engine\'s: a turned building, its room\'s own outline, a cup in a turned slot', () => {
  const s = copySpace(copied()), g = (at) => s.gather(at, 80);
  assert.deepEqual(whereOf(g('101,-2')).room, { id: 'b-3', name: 'kitchen' }, 'the room is x 100..102, z -4..0 once turned');
  assert.equal(whereOf(g('103,1')).room, null);
  assert.deepEqual(whereOf(g('cup 5')).at, [101, -1.5], 'table at 101,-1; its slot 0.5 m along its x, turned to -z');
  assert.deepEqual(whereOf(g('table 4')).nearest[0], { id: 'b-5', name: 'cup 5', distance: 0.5 });
  // The table is 1 x 0.5 m in its own frame: turned, 0.5 m across x and 1 m along z.
  assert.deepEqual(clearOf(g('101.4,-1'), [0.2, 0.2]).blocked_by.map((b) => b.name).sort(), ['cottage 1', 'kitchen']);
  assert.deepEqual(clearOf(g('101,-0.6'), [0.1, 0.1]).blocked_by.map((b) => b.name).sort(), ['cottage 1', 'kitchen', 'table 4']);
});

test('a name is an id, a name or an alias in any case, or the one name holding the words; several are refused', () => {
  const s = copySpace([...copied(), { id: 's-7', name: 'bench 7', kind: 'eden:bench@x', parent: 's-1', pos: um(-6, 0, 0) }]);
  assert.equal(s.gather('s.3', 80).named.id, 's-3');
  assert.equal(s.gather('KITCHEN', 80).named.id, 'b-3');
  assert.deepEqual(s.gather('the square', 80).point, [0, 0], 'an area at its outline\'s middle');
  assert.equal(s.gather('cottage', 80).named.id, 'b-1');
  assert.equal(s.gather('nowhere', 80).code, 'nothing-by-that-name');
  assert.throws(() => s.gather('bench', 80), (e) => e.code === 'name-ambiguous' && e.choices.map((c) => c.id).join() === 's-3,s-7');
});

test('where, clear and free from the copy need no browser and no page', async () => {
  const home = mkdtempSync(join(tmpdir(), 'space-')), { ask, asked } = asking();
  const w = await runSpace('where', ['kitchen'], { home, ask, pw: null });
  assert.deepEqual([w.ok, w.from, w.version, w.of.id, w.room.id], [true, 'copy', 42, 'b-3', 'b-3']);
  const c = await runSpace('clear', ['-8,8', '--size', '6x6'], { home, ask, pw: null });
  assert.deepEqual([c.clear, c.blocked_by], [true, []]);
  const f = await runSpace('free', ['2x2', '--near', '0,-3'], { home, ask, pw: null });
  assert.equal(f.distance, 2);
  assert.deepEqual(asked, ['space', 'space', 'space']);
  await assert.rejects(runSpace('where', ['nowhere'], { home, ask, pw: null }), { code: 'nothing-by-that-name' });
  await assert.rejects(runSpace('where', ['1,1'], { home, ask: async () => ({ ok: false, code: 'unknown-op' }), pw: null }), { code: 'unknown-op' }, 'an older daemon says so');
  // --page still reads the page drawn here
  await assert.rejects(runSpace('where', ['1,1', '--page', 'https://soul.example/v2/'], { home, ask, pw: null }), { code: 'no-browser' });
});

test('look with no picture answers in words from the copy: what, where, what is in it, what is around', async () => {
  const home = mkdtempSync(join(tmpdir(), 'look-')), { ask } = asking();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'https://soul.example/w/local' } } }));
  const l = await runLook(['cottage 1'], { home, ask, pw: null, cwd: home });
  assert.deepEqual([l.ok, l.picture, l.name], [true, null, 'cottage 1']);
  assert.match(l.why, /^no-browser: /);
  assert.deepEqual(l.words.of, { id: 'b-1', name: 'cottage 1', kind: 'eden:cottage' });
  assert.deepEqual(l.words.at, [100, 0]);
  assert.deepEqual(l.words.holds.shown.map((h) => [h.name, h.in ?? null]), [['table 4', 'kitchen'], ['cup 5', 'table 4'], ['kitchen', 'floor 2']]);
  assert.deepEqual(l.words.holds.shown[0].at, [101, -1]);
  assert.deepEqual(l.words.nearest.map((n) => n.name).slice(0, 2), ['table 4', 'cup 5']);
  // A page that draws nothing (the world's own page has no capture) answers the same way.
  const pw = drawn();
  const blank = { chromium: { launchPersistentContext: async () => ({ pages: () => [{ evaluate: async () => true, goto: async () => {}, waitForFunction: async () => { throw new Error('timeout'); } }], clearCookies: async () => {}, close: async () => {} }) } };
  const b = await runLook(['kitchen'], { home, ask, pw: blank, cwd: home });
  assert.match(b.why, /^page-not-drawing: /);
  assert.deepEqual([b.words.of.id, b.words.room.id], ['b-3', 'b-3']);
  const down = { chromium: { launchPersistentContext: async () => ({ pages: () => [{ evaluate: async () => true, goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED at http://127.0.0.1/'); } }], clearCookies: async () => {}, close: async () => {} }) } };
  assert.match((await runLook(['kitchen'], { home, ask, pw: down, cwd: home })).why, /^page-not-reachable: the page did not load: net::ERR_CONNECTION_REFUSED/);
  // A place given as x,z, with no name: where it is and what is around.
  const p = await runLook(['0,-2'], { home, ask, pw: null, cwd: home });
  assert.deepEqual([p.words.of, p.words.nearest[0].name], [undefined, 'bench 3']);
  // With no creator here it is today's shoot: no browser gives its note, a page that draws nothing its refusal.
  assert.match((await runLook(['kitchen'], { home, pw: null, cwd: home })).note, /no Soul/);
  await assert.rejects(runLook(['kitchen'], { home, pw: blank, cwd: home }), { code: 'page-not-drawing' });
  assert.ok(pw, 'drawn() stand-in left as it was');
});

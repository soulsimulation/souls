// #2509: the raw-HTTP driver's pure parts: one documentation address per raw Soul, the paced words resolved from the
// catalog, the raw loop's seeded draws equal to the real paced loop's (so base and candidate arms replay the same acts), and
// the per-tenth report, busiest first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docAddress, wordIds, rawPacedLoop, pacedLoop, byTenth, shapeOf, shapePlan, shapeIds, rawShapedLoop } from './load.mjs';
import { SHAPES } from '../../bench/capacity/profiles/shapes.mjs';
import { rng } from '../lib/hash.mjs';

test('#2509 raw Souls: one documentation-range address each, none twice, at most 762', () => {
  const xs = Array.from({ length: 762 }, (_, i) => docAddress(i));
  assert.equal(new Set(xs).size, 762); assert.equal(xs[0], '192.0.2.1'); assert.equal(xs[254], '198.51.100.1'); assert.equal(xs[761], '203.0.113.254');
  assert.throws(() => docAddress(762));
});

test('#2509 a raw Soul makes the same seeded choices as a real paced Soul in its place, and replays them run to run', async () => {
  const cat = { places: [{ id: 'p1', ref: 'bandstand', name: 'Bandstand' }, { id: 'p2', ref: 'old-windmill', name: 'Old windmill' }, { id: 'p3', ref: 'library-1', name: 'Library' }],
    acts: [{ id: 'eat.e1', verb: 'eat', label: 'Eat' }, { id: 'read.e2', verb: 'read', label: 'Read' }], things: [{ id: 'bench-1', seat: true }] };
  const ids = wordIds(cat);
  assert.deepEqual(ids.bandstand, ['walk:bandstand']); assert.deepEqual(ids.windmill, ['walk:old-windmill']); assert.deepEqual(ids.bench, ['sit:bench-1']); assert.deepEqual(ids['sit on the floor'], ['sit-ground:here']);
  // every paced word resolves (as `find` finds rows for each in the fake below), so both loops make the same draws
  const all = Object.fromEntries(Object.keys(ids).map((w) => [w, [`id:${w}`]]));
  const rawRun = async (seed) => { const sent = []; const call = async (url, o = {}) => { if (o.method === 'POST') sent.push(o.body.capability.slice(3)); return { status: 200, data: { accepted: true }, timing: 'world;dur=5, queue;dur=1' }; };
    await rawPacedLoop({ base: 'http://w', soul: { i: 0, address: docAddress(0), token: 't' }, ids: all, until: Date.now() + 400, r: rng(seed), counts: { cmds: 0, acts: 0, refused: 0 }, actSec: 0.02, call }); return sent; };
  const a = await rawRun(7), b = await rawRun(7);
  assert.ok(a.length >= 4 && b.length >= 4); assert.deepEqual(a.slice(0, 4), b.slice(0, 4), 'the same seed sends the same acts');
  const words = []; const cli = async (_f, args) => { if (args[0] === 'find') words.push(args[1]); return args[0] === 'find' ? { data: { found: [{ act: 'x' }] } } : { data: { accepted: true } }; };
  await pacedLoop({ folder: '.', until: Date.now() + 400, r: rng(7), counts: { cmds: 0, acts: 0, refused: 0, closed: 0 }, actSec: 0.02, cli });
  assert.ok(words.length >= 4); assert.deepEqual(a.slice(0, 4), words.slice(0, 4), 'a raw Soul draws the words a real paced Soul would');
});

test('#2509 per tenth of agents by activity, busiest first, with the slow-down refusals that held an agent back', () => {
  const agents = Array.from({ length: 20 }, (_, i) => ({ intended: i < 2 ? 40 : 10, achieved: i < 2 ? 20 : 10, raw: i >= 3, waits: [i], slowDown: i < 2 ? 5 : 0 }));
  const t = byTenth(agents);
  assert.equal(t.length, 10); assert.deepEqual(t[0], { tenth: 1, agents: 2, raw: 0, intended: 80, achieved: 40, share: 0.5, waitP50: 0, slowDown: 10 });
  assert.equal(t[9].share, 1);
});

// #2556: the load shapes drive the raw Souls. A1 every shape is accepted and the same seed gives the same schedule; A2
// `uniform` is the paced loop unchanged: its raw acts for a fixed seed are the ones the code before #2556 sent.
test('#2556 A1 --shape accepts every shape of the shapes module; one repeat seed, one schedule', () => {
  assert.throws(() => shapeOf('lumpy'), /known shapes/);
  for (const name of Object.keys(SHAPES.agents)) {
    assert.equal(shapeOf(name), name === 'uniform' ? null : name);
    const a = shapePlan(name, 21, 120, 1), b = shapePlan(name, 21, 120, 1), c = shapePlan(name, 21, 120, 2);
    assert.deepEqual(a, b, `${name}: the same seed gives the same schedule`);
    assert.notDeepEqual(a.agents, c.agents, `${name}: another repeat gives another schedule`);
    assert.equal(a.agents.length, 21);
  }
});

test('#2556 A2 --shape uniform sends the acts the code before the shapes did, for a fixed seed', async () => {
  assert.equal(shapeOf('uniform'), null); assert.equal(shapeOf(undefined), null);
  const all = Object.fromEntries(Object.keys(wordIds({})).map((w) => [w, [`id:${w}`, `id:${w}:2`, `id:${w}:3`]]));
  // recorded from rawPacedLoop at the raw driver's head (#2509), before this change
  const before = {
    7: ['id:pond:3', 'id:library:2', 'id:eat:3', 'id:windmill:3', 'id:fire circle:2', 'id:eat', 'id:fire circle:3', 'id:windmill', 'id:eat:3', 'id:garden:2'],
    1003: ['id:pond:3', 'id:garden:2', 'id:pond', 'id:pond:2', 'id:pond:3', 'id:library', 'id:lake:3', 'id:music:3', 'id:eat:3', 'id:garden'] };
  for (const [seed, want] of Object.entries(before)) {
    const sent = []; const call = async (_u, o = {}) => { if (o.method === 'POST') sent.push(o.body.capability); return { status: 200, data: { accepted: true }, timing: '' }; };
    await rawPacedLoop({ base: 'http://w', soul: { i: 0, address: docAddress(0), token: 't' }, ids: all, until: Date.now() + 600, r: rng(Number(seed)), counts: { cmds: 0, acts: 0, refused: 0 }, actSec: 0.02, call });
    assert.deepEqual(sent.slice(0, 10), want, `seed ${seed}`);
  }
});

test('#2556 a raw Soul follows its agent of the schedule: arrivals re-read, kinds by route and id, gathered walks, nothing after the window', async () => {
  const cat = { places: [{ id: 'b', ref: 'bandstand', kind: 'building', outline: [[0, 0], [10, 0], [10, 10], [0, 10]] }, { id: 'n', ref: 'near', kind: 'building', outline: [[20, 0], [30, 0], [30, 10], [20, 10]] }, { id: 'f', ref: 'far', kind: 'building', outline: [[200, 0], [210, 0], [210, 10], [200, 10]] }],
    acts: [{ id: 'read.e2', verb: 'read' }], anywhere: [{ id: 'wave:here', verb: 'wave' }], things: [] };
  const ids = shapeIds(cat, 30);
  assert.equal(ids.named, 'walk:bandstand'); assert.deepEqual(ids.gathered, ['walk:bandstand', 'walk:near']);
  const agent = { stays: [[0, 0.05], [0.08, 10]], acts: [{ at: 0.01, kind: 'say', pick: 0 }, { at: 0.02, kind: 'walk', place: 'gathered', pick: 3 }, { at: 0.03, kind: 'gesture', pick: 0 },
    { at: 0.09, kind: 'eat', pick: 1 }, { at: 0.1, kind: 'walk', place: 'spread', pick: 2 }, { at: 0.11, kind: 'read', pick: 5 }, { at: 5, kind: 'read', pick: 0 }] };
  const sent = [], call = async (u, o = {}) => { sent.push(o.method === 'POST' ? (o.body.capability ?? `say:${o.body.text}`) : u.slice(8)); return { status: 200, data: { accepted: true }, timing: 'world;dur=3, queue;dur=1' }; };
  const counts = { cmds: 0, acts: 0, refused: 0 }, fallback = {}, http = [], t0 = Date.now();
  await rawShapedLoop({ base: 'http://w', soul: { i: 0, address: docAddress(0), token: 't' }, ids, agent, t0, until: t0 + 400, counts, http, fallback, call });
  assert.deepEqual(sent, ['say:hello from the load shapes', 'walk:near', 'wave:here', '/v1/edge/catalog', '/v1/edge/live', 'walk:near', 'walk:far', 'read.e2']);
  assert.deepEqual(fallback, { eat: 1 }); assert.equal(counts.acts, 6); assert.equal(counts.says, 1);
  assert.equal(http.filter((x) => x.method === 'POST').length, 6, 'speech and acts are in the trace, so tenths count them');
});

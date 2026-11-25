// #4176: doors, lamps and the weather of a v2 world, as the old page's entity layer draws them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setWeatherInForce } from '@souls/world-compiler/weather-rules';
import { CHUNK, V2Bridge } from './bridge.ts';
import { TICK_US } from './takes.ts';
import { appendEdge, thingState, weatherOf, WorldState, type LayerLike, type WorldDiff } from './world-state.ts';

const node = (id: string, kind: string, origin: string, fields: Record<number, unknown>) => ({ id, kind, parent: 'w.1', origin, fields });
const world = (sky: Record<number, unknown>) => ({ id: 'w.1', kind: 'souls:world', parent: null, sky });
const SKY = { 60: 86_400, 61: Date.UTC(2026, 5, 1) * 1000, 62: [[0, 0]] };
const part = (nodes: unknown[], removed: string[] = []) => ({ t: 'part', p: { number: 1, from: 0, to: 500_000, nodes, removed, samples: [] } });

/** A layer as WorldEntityLayer keeps it, applying world diffs in sequence as its applyDiff does (state replaced whole). */
function layer(entities: { id: string; state?: Record<string, unknown> }[], weather?: unknown) {
  const l = { seq: 7, model: { entities: new Map(entities.map((e) => [e.id, e])), state: { weather } } };
  const apply = (d: WorldDiff | null) => {
    if (!d) return;
    assert.equal(d.seq, l.seq + 1, 'next in the layer\'s sequence: never a gap (a resync)');
    l.seq = d.seq;
    for (const id of d.diff.removes) l.model.entities.delete(id);
    for (const e of d.diff.upserts as { id: string }[]) l.model.entities.set(e.id, e);
    if (d.diff.world) l.model.state = { ...l.model.state, ...d.diff.world };
  };
  return { l: l as LayerLike & typeof l, apply };
}

test('a door\'s and a lamp\'s v2 fields are the state the old page draws them by', () => {
  assert.deepEqual(thingState(node('a.1', 'eden:door@ab', 'e_door', { 6: 1, 7: 3 })), { open: true });
  assert.deepEqual(thingState(node('a.2', 'eden:desk_lamp', 'e_lamp', { 28: 0 })), { on: false });
  assert.deepEqual(thingState(node('a.3', 'eden:floor_lamp', 'e_fl', { 28: 2 })), { level: 2 });
  assert.deepEqual(thingState(node('a.7', 'eden:shop_door', 'e_shopdoor', { 6: 0 })), { open: false }, 'a door kind');
  assert.equal(thingState(node('a.8', 'eden:shelf', 'e_shelf', { 6: 1 })), null, 'field 6 on a thing that is not a door is not a door');
  assert.deepEqual(thingState(node('a.4', 'mars:thing', 'e_m', { 27: 'eden:pendant', 28: 1 })), { on: true }, 'a borrowed entry');
  assert.equal(thingState(node('a.5', 'eden:table', 'e_t', { 28: 1 })), null, 'not a door or a lamp');
  assert.equal(thingState(node('a.6', 'eden:door', 'e_d', {})), null, 'no field yet: drawn as the layer has it');
});

test('a door opened and a lamp lit on v2 are drawn so with the part that says it, and back when they change back', () => {
  const ws = new WorldState(), { l, apply } = layer([{ id: 'e_door', state: { open: false, locked: false } }, { id: 'e_lamp', state: { on: false } }]);
  ws.receive(part([node('a.1', 'eden:door', 'e_door', { 6: 0 }), node('a.2', 'eden:desk_lamp', 'e_lamp', { 28: 0 })]));
  assert.equal(ws.diff(l, 0), null, 'the layer already draws it');
  ws.receive(part([node('a.1', 'eden:door', 'e_door', { 6: 1 }), node('a.2', 'eden:desk_lamp', 'e_lamp', { 28: 1 })]));
  const d = ws.diff(l, 0)!;
  assert.deepEqual(d.diff.upserts, [{ id: 'e_door', state: { open: true, locked: false } }, { id: 'e_lamp', state: { on: true } }]);
  assert.equal(d.by, 'engine');
  assert.equal(d.tick, 500_000 / TICK_US, 'drawn when the picture reaches the part that says it, never before (light-diff-clock)');
  apply(d);
  assert.equal(ws.diff(l, 0), null, 'once drawn, no diff again');
  ws.receive(part([node('a.1', 'eden:door', 'e_door', { 6: 0 })]));
  apply(ws.diff(l, 0));
  assert.equal(l.model.entities.get('e_door')!.state!.open, false);
  assert.equal(l.model.entities.get('e_lamp')!.state!.on, true);
  ws.receive(part([], ['a.2']));
  assert.equal(ws.things.has('e_lamp'), false, 'a removed node is no longer v2\'s word');
});

test('a thing the layer does not hold, or a layer with no model yet, makes no diff', () => {
  const ws = new WorldState();
  ws.receive(part([node('a.1', 'eden:door', 'e_elsewhere', { 6: 1 })]));
  assert.equal(ws.diff(layer([]).l, 0), null);
  assert.equal(ws.diff({ seq: 1, model: null }, 0), null);
  assert.equal(ws.diff(undefined, 0), null);
});

test('the weather follows v2\'s fields 75-79: recorded frames of a change replace the captured rain', () => {
  const captured = { kind: 'rain', clouds: 0.9, rain: 0.8, wind: 0.3, until: 999_999 };
  const ws = new WorldState(), { l, apply } = layer([], captured);
  ws.receive(part([world({ ...SKY, 75: 'souls:clear', 76: 10, 77: 0, 78: 10, 79: 3_600_000_000 })]));
  apply(ws.diff(l, 0));
  assert.deepEqual(l.model.state.weather, { kind: 'clear', clouds: 0.1, rain: 0, wind: 0.1, fog: 0, intensity: 1 });
  assert.equal(ws.diff(l, 0), null);
  ws.receive(part([world({ ...SKY, 75: 'souls:storm', 76: 100, 77: 90, 78: 80, 79: 7_200_000_000 })]));
  apply(ws.diff(l, 0));
  const w = l.model.state.weather as unknown as { kind: string; until: number; rain: number };
  assert.equal(w.kind, 'storm');
  assert.equal(w.rain, 0.9);
  assert.equal(w.until, 7_200_000_000 / TICK_US, 'a wet kind ends at v2\'s next change, as a take tick');
  assert.ok(setWeatherInForce(w, 7_200_000_000 / TICK_US - 1) && !setWeatherInForce(w, 7_200_000_000 / TICK_US));
  ws.receive(part([world({ ...SKY, 75: 'souls:fog', 76: 60, 77: 0, 78: 5 })]));
  apply(ws.diff(l, 0));
  assert.deepEqual(l.model.state.weather, { kind: 'fog', clouds: 0.6, rain: 0, wind: 0.05, fog: 1, intensity: 1 });
});

test('a world with a calendar and no weather yet reads clear; a node with no calendar is no sky', () => {
  assert.deepEqual(weatherOf(SKY), { kind: 'clear', clouds: 0, rain: 0, wind: 0, fog: 0, intensity: 1 });
  assert.equal(weatherOf({ 1: 2 }), null);
  assert.equal(weatherOf(undefined), null);
});

test('the sky\'s clock follows v2\'s calendar fields 60-61 in the chunks', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const day = 3_600; // a world day of one hour: 24 civil hours an hour
  const body = { id: 'b.1', kind: 'souls:humanoid', parent: 'w.1', slot: null, pos: [0, 0, 0], rot: [2 ** 30, 0, 0, 0], at: 0, soul: 'soul-a-1', name: 'Ada' };
  const w = { id: 'w.1', kind: 'souls:world', parent: null, slot: null, pos: [0, 0, 0], rot: [2 ** 30, 0, 0, 0], at: null, sky: { 60: day, 61: Date.UTC(2026, 5, 1) * 1000 } };
  b.receive({ t: 'part', p: { number: 1, from: 0, to: 500_000, nodes: [w, body], removed: [], samples: [] } } as never);
  b.receive({ t: 'part', p: { number: 2, from: 500_000, to: 600 * 1_000_000, nodes: [], removed: [], samples: [] } } as never);
  const last = b.view.takes.chunks.at(-1)!, end = last.toTick;
  const env = (last.take as { finalState: { env: { datetime: string } } }).finalState.env;
  assert.equal(end % CHUNK, 0);
  // the chunks' clock is the newest chunk end's civil time: origin + t · 86,400 / day
  const want = new Date(Date.UTC(2026, 5, 1) + Math.floor((b.view.takes.serverTick * TICK_US * 86_400) / day) / 1000).toISOString();
  assert.equal(env.datetime, want);
});

test('each diff is appended to the page\'s edge log once, beside the messages already there', () => {
  const ws = new WorldState(), { l, apply } = layer([{ id: 'e_door', state: { open: false } }]);
  ws.receive(part([node('a.1', 'eden:door', 'e_door', { 6: 1 })]));
  let log: unknown[] = [{ type: 'edge', kind: 'said', at: 1 }];
  const d = ws.next(l, 0)!;
  log = appendEdge(log, d);
  assert.equal(ws.next(l, 0), null, 'not applied yet: the same seq is not sent again');
  ws.receive(part([node('a.1', 'eden:door', 'e_door', { 6: 0 })]));
  assert.equal(ws.next(l, 0), null, 'nor a newer state under the same seq');
  apply(d);
  const d2 = ws.next(l, 0)!;
  assert.equal(d2.seq, d.seq + 1);
  assert.deepEqual(d2.diff.upserts, [{ id: 'e_door', state: { open: false } }], 'what is still unlike v2 goes in the next');
  log = appendEdge(log, d2);
  assert.deepEqual(log, [{ type: 'edge', kind: 'said', at: 1 }, d, d2], 'other edge messages are kept');
  assert.equal(appendEdge(Array.from({ length: 300 }, (_, i) => i), 300).length, 300, 'the last 300, as the socket keeps them');
});

// B2-2 (0.132 #4239): a thing a Soul takes from one table and puts on another.
const R = 2 ** 30, ID: [number, number, number, number] = [R, 0, 0, 0];
const yawQ = (yaw: number): [number, number, number, number] => [Math.round(Math.cos(yaw / 2) * R), 0, Math.round(Math.sin(yaw / 2) * R), 0];
const at = (id: string, kind: string, parent: string | null, pos: [number, number, number], extra: Record<string, unknown> = {}) =>
  ({ id, kind, parent, slot: null, pos, rot: ID, ...extra });
const ROOM = [
  at('w.1', 'souls:world', null, [0, 0, 0]),
  at('g.1', 'souls:ground', 'w.1', [0, 0, 0]),
  at('t.1', 'eden:table', 'g.1', [1_000_000, 0, 2_000_000], { origin: 'e_tablea', slots: [[1, 0, 750, 0, 0, 2]] }),
  at('t.2', 'eden:table', 'g.1', [5_000_000, 0, 2_000_000], { origin: 'e_tableb', rot: yawQ(Math.PI / 2) }),
  at('b.1', 'souls:humanoid', 'g.1', [3_000_000, 0, 2_000_000], { soul: 'soul-a-1', slots: [[4, 300, 1_000, 0, 0, 1]] }),
];
const CUP = { id: 'c.1', kind: 'eden:cup', origin: 'e_cup' };
const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < 1e-6);

test('a cup taken from one table and put on another is drawn on the second, where v2 has it', () => {
  const ws = new WorldState();
  const { l, apply } = layer([{ id: 'e_cup', in: { parent: 'e_tablea', slot: 'top' }, p: [0, 0], r: 0.25, state: { tea: 1 } } as never]);
  ws.receive({ t: 'snapshot', s: { nodes: [...ROOM, { ...CUP, parent: 't.1', slot: 1, pos: [0, 0, 0], rot: ID }], removed: [] } });
  assert.equal(ws.diff(l, 0), null, 'as captured: the layer draws it where it is');
  // taken: in the Soul's hand (the bodies' adapter draws what is held), so the layer's copy on the table goes
  ws.receive(part([{ ...CUP, parent: 'b.1', slot: 4, pos: [0, 0, 0], rot: ID }]));
  const taken = ws.diff(l, 0)!;
  assert.deepEqual(taken.diff.removes, ['e_cup'], 'a thing in a hand is not also drawn where it was taken from');
  assert.deepEqual(taken.diff.upserts, []);
  assert.equal(taken.tick, 500_000 / TICK_US, 'gone from the table when the picture reaches the part that takes it');
  apply(taken);
  assert.equal(ws.diff(l, 0), null, 'once gone, no diff again while it is held');
  // put down on the other table, half a metre along its top and turned a quarter more
  ws.receive(part([{ ...CUP, parent: 't.2', slot: null, pos: [500_000, 760_000, 0], rot: yawQ(Math.PI / 2) }]));
  const d = ws.diff(l, 0)!;
  assert.equal(d.diff.upserts.length, 1);
  const e = d.diff.upserts[0] as { id: string; in: { parent: string }; p: number[]; r: number; state: unknown };
  assert.equal(e.id, 'e_cup');
  assert.deepEqual(e.in, { parent: 'world' }, 'at the world\'s root, so its pose is its own');
  // table B at (5, 0, 2) turned a quarter: its +x is the world's -z
  assert.ok(near(e.p, [5, 0.76, 1.5]), `at the second table's top: ${e.p}`);
  assert.ok(Math.abs(e.r - Math.PI) < 1e-6, 'the table\'s turn and its own');
  assert.deepEqual(e.state, { tea: 1 }, 'the rest of the record as the layer had it');
  assert.equal(d.tick, 500_000 / TICK_US, 'drawn when the picture reaches the part that puts it down');
  apply(d);
  assert.equal(ws.diff(l, 0), null, 'once drawn there, no diff again');
  // taken again and put back on the first table's slot
  ws.receive(part([{ ...CUP, parent: 'b.1', slot: 4, pos: [0, 0, 0], rot: ID }]));
  const again = ws.diff(l, 0)!;
  assert.deepEqual(again.diff.removes, ['e_cup'], 'in the hand again: not drawn on the second table');
  apply(again);
  ws.receive(part([{ ...CUP, parent: 't.1', slot: 1, pos: [0, 0, 0], rot: ID }]));
  apply(ws.diff(l, 0));
  const back = l.model.entities.get('e_cup') as unknown as { p: number[]; r: number };
  assert.ok(near(back.p, [1, 0.75, 2]) && Math.abs(back.r) < 1e-6, `back on the first table's slot: ${back.p}`);
});

test('a book picked up and put back where it was is drawn there again; one the stream no longer holds is removed', () => {
  const ws = new WorldState();
  const { l, apply } = layer([{ id: 'e_book', in: { parent: 'e_tablea', slot: 'top' }, p: [0, 0], r: 0 }, { id: 'e_cup', in: { parent: 'world' }, p: [1, 0, 2], r: 0 }] as never);
  const BOOK = { id: 'k.1', kind: 'eden:book', origin: 'e_book' };
  ws.receive({ t: 'snapshot', s: { nodes: [...ROOM, { ...BOOK, parent: 't.1', slot: 1, pos: [0, 0, 0], rot: ID }, { ...CUP, parent: 'g.1', slot: null, pos: [1_000_000, 0, 2_000_000], rot: ID }], removed: [] } });
  assert.equal(ws.diff(l, 0), null);
  ws.receive(part([{ ...BOOK, parent: 'b.1', slot: 4, pos: [0, 0, 0], rot: ID }]));
  apply(ws.diff(l, 0));
  assert.equal(l.model.entities.has('e_book'), false, 'held: not drawn on the table');
  ws.receive(part([{ ...BOOK, parent: 't.1', slot: 1, pos: [0, 0, 0], rot: ID }]));
  const back = ws.diff(l, 0)!;
  assert.deepEqual(back.diff.upserts, [{ id: 'e_book', in: { parent: 'e_tablea', slot: 'top' }, p: [0, 0], r: 0 }], 'put back on its captured spot: drawn as captured');
  apply(back);
  assert.equal(ws.diff(l, 0), null, 'drawn again: nothing more');
  // eaten, put away: the stream no longer holds it
  ws.receive(part([], ['c.1']));
  const gone = ws.diff(l, 0)!;
  assert.deepEqual(gone.diff.removes, ['e_cup']);
  apply(gone);
  assert.equal(ws.diff(l, 0), null);
});

test('a thing already in a hand in the first state the page receives is not drawn where the scene has it', () => {
  const ws = new WorldState(), { l } = layer([{ id: 'e_cup', in: { parent: 'e_tablea', slot: 'top' }, p: [0, 0], r: 0 }] as never);
  // the body comes after the cup in the snapshot: the hand is judged once every frame is in
  ws.receive({ t: 'snapshot', s: { nodes: [{ ...CUP, parent: 'b.1', slot: 4, pos: [0, 0, 0], rot: ID }, ...ROOM], removed: [] } });
  assert.deepEqual(ws.diff(l, 0)!.diff.removes, ['e_cup']);
});

test('a moved thing keeps its tilt and its door or lamp state goes in the same upsert; things that never moved make no diff', () => {
  const ws = new WorldState();
  const { l } = layer([{ id: 'e_lamp', in: { parent: 'world' }, p: [1, 0, 2], r: [0, 0.1, 0], state: { on: false } }, { id: 'e_tablea', in: { parent: 'world' }, p: [1, 0, 2] }] as never);
  const lamp = { id: 'l.1', kind: 'eden:desk_lamp', origin: 'e_lamp', fields: { 28: 0 } };
  ws.receive({ t: 'snapshot', s: { nodes: [...ROOM, { ...lamp, parent: 'g.1', slot: null, pos: [1_000_000, 0, 2_000_000], rot: ID }], removed: [] } });
  assert.equal(ws.diff(l, 0), null, 'nothing has moved or changed: the tables and the lamp as captured');
  ws.receive(part([{ ...lamp, fields: { 28: 1 }, parent: 'g.1', slot: null, pos: [2_000_000, 0, 2_000_000], rot: ID }]));
  const up = ws.diff(l, 0)!.diff.upserts as { id: string; p: number[]; r: number[]; state: unknown }[];
  assert.equal(up.length, 1);
  assert.ok(near(up[0].p, [2, 0, 2]));
  assert.deepEqual(up[0].r, [0, 0.1, 0], 'its yaw from v2, its tilt as the layer had it');
  assert.deepEqual(up[0].state, { on: true });
  ws.receive(part([], ['l.1']));
  assert.equal(ws.moved.has('e_lamp'), false, 'a removed node is no longer v2\'s word');
});

test('a cup already on the other table in the first state the page receives is drawn there; things where the scene has them are not touched', () => {
  const ws = new WorldState(), { l, apply } = layer([
    { id: 'e_cup', in: { parent: 'e_tablea', slot: 'top' }, p: [0, 0], r: 0, state: {} },
    { id: 'e_tablea', in: { parent: 'world' }, p: [1, 0, 2], r: 0 },
    { id: 'e_tableb', in: { parent: 'world' }, p: [5, 0, 2], r: Math.PI / 2 + 0.0001 },
  ] as never);
  // the captured scene's world poses (WorldModel.worldPose): the cup on table A's slot, 0.75 m up
  const poses: Record<string, { x: number; y: number; z: number; yaw: number; s: number }> = {
    e_cup: { x: 1, y: 0.75, z: 2, yaw: 0, s: 1 }, e_tablea: { x: 1, y: 0, z: 2, yaw: 0, s: 1 }, e_tableb: { x: 5.0004, y: 0, z: 2, yaw: Math.PI / 2 + 0.0001, s: 1 } };
  Object.assign(l.model, { worldPose: (e: { id: string }) => poses[e.id] });
  assert.equal(ws.diff(l, 0), null, 'nothing from the stream yet');
  ws.receive({ t: 'snapshot', s: { nodes: [...ROOM, { ...CUP, parent: 't.2', slot: null, pos: [500_000, 760_000, 0], rot: ID }], removed: [] } });
  const d = ws.diff(l, 0)!;
  assert.deepEqual((d.diff.upserts as { id: string }[]).map((e) => e.id), ['e_cup'], 'only the cup: the tables are where the scene has them, to the rounding');
  const e = d.diff.upserts[0] as { in: unknown; p: number[]; r: number };
  assert.deepEqual(e.in, { parent: 'world' });
  assert.ok(near(e.p, [5, 0.76, 1.5]) && Math.abs(e.r - Math.PI / 2) < 1e-6, `on table B: ${e.p}`);
  apply(d);
  assert.equal(ws.diff(l, 0), null, 'once drawn there, no diff again');
  // and it is followed from there as any moved thing
  ws.receive(part([{ ...CUP, parent: 't.1', slot: 1, pos: [0, 0, 0], rot: ID }]));
  apply(ws.diff(l, 0));
  assert.ok(near((l.model.entities.get('e_cup') as unknown as { p: number[] }).p, [1, 0.75, 2]), 'put back on table A');
});

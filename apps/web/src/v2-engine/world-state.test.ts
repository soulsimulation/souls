// #4176: doors, lamps and the weather of a v2 world, as the old page's entity layer draws them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setWeatherInForce } from '@souls/world-compiler/weather-rules';
import { V2Bridge } from './bridge.ts';
import { TICK_US, TICKS } from './takes.ts';
import { thingState, weatherOf, WorldState, type LayerLike, type WorldDiff } from './world-state.ts';

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
    for (const e of d.diff.upserts as { id: string }[]) l.model.entities.set(e.id, e);
    if (d.diff.world) l.model.state = { ...l.model.state, ...d.diff.world };
  };
  return { l: l as LayerLike & typeof l, apply };
}

test('a door\'s and a lamp\'s v2 fields are the state the old page draws them by', () => {
  assert.deepEqual(thingState(node('a.1', 'eden:door@ab', 'e_door', { 6: 1, 7: 3 })), { open: true });
  assert.deepEqual(thingState(node('a.2', 'eden:desk_lamp', 'e_lamp', { 28: 0 })), { on: false });
  assert.deepEqual(thingState(node('a.3', 'eden:floor_lamp', 'e_fl', { 28: 2 })), { level: 2 });
  assert.deepEqual(thingState(node('a.7', 'eden:shop', 'e_shopdoor', { 6: 0, 2: 'x' })), { open: false }, 'any imported door (field 6), whatever its kind');
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
  assert.equal(end % TICKS, 0);
  // the chunks' clock is the newest chunk end's civil time: origin + t · 86,400 / day
  const want = new Date(Date.UTC(2026, 5, 1) + Math.floor((b.view.takes.serverTick * TICK_US * 86_400) / day) / 1000).toISOString();
  assert.equal(env.datetime, want);
});

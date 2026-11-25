// A thing's v2 kind state drawn by its old def: the fire put out and lit again, a lamp switched, a door opened, a basket
// filled. The state fields are named by the content kinds' entries (as the build's kind-state.json names them, read here from
// `content/kinds` the same way) and given to the core library's defs by their own keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreLibrary, type StoredDef } from '@souls/world-compiler';
import * as THREE from 'three';
import { glowKind } from '../gen-mesh/motion.ts';
import { drawnState, thingState, WorldState, type KindFields, type LayerLike, type WorldDiff } from './world-state.ts';

const KINDS = new URL('../../../../content/kinds/', import.meta.url).pathname;
/** vite.config.ts `kindBounds`'s kind-state.json, from the same files. */
function kindState(): Record<string, KindFields> {
  const out: Record<string, KindFields> = {};
  for (const family of readdirSync(KINDS)) for (const f of readdirSync(join(KINDS, family))) {
    if (!f.endsWith('.json')) continue;
    const e = JSON.parse(readFileSync(join(KINDS, family, f), 'utf8'));
    if (typeof e.kind !== 'string' || e.owner !== 'thing' || e.roles || !Array.isArray(e.geometry?.bounds_mm)) continue;
    for (const [k, d] of Object.entries((e.state ?? {}) as Record<string, { n?: number; type?: string; default?: unknown; values?: string[] }>)) {
      if (typeof d.n !== 'number' || (d.type !== 'bool' && d.type !== 'int' && d.type !== 'enum')) continue;
      const dflt = typeof d.default === 'boolean' ? Number(d.default) : typeof d.default === 'number' || typeof d.default === 'string' ? d.default : null;
      (out[e.kind] ??= {})[k] = (d.values ? [d.n, d.type, dflt, d.values] : [d.n, d.type, dflt]) as KindFields[string];
    }
  }
  return out;
}
const TABLE = kindState();
const lib = coreLibrary();
const newest = (name: string): StoredDef => lib.all().filter((d) => d.name === name).sort((a, b) => b.version - a.version)[0];
const node = (id: string, kind: string, origin: string, fields: Record<number, unknown>) => ({ id, kind, parent: 'w.1', origin, fields });
/** A thing's look state: its v2 fields through its entry's names to its old def's keys. */
const look = (kind: string, def: string, fields: Record<number, unknown>) => drawnState(thingState(node('n', kind, 'e_x', fields), TABLE)!, newest(def));

test('a fire, a lamp, a door, a basket and a radio: v2 fields drawn by the old def\'s own state keys', () => {
  assert.deepEqual(look('eden:campfire@ab', 'core-campfire', { 28: 1 }), { on: true }, 'a campfire\'s entry says lit; its def burns by on');
  assert.deepEqual(look('eden:campfire@ab', 'core-campfire', { 28: 0 }), { on: false }, 'put out');
  assert.deepEqual(look('eden:candle_stand', 'core-candle-stand', { 28: 0 }), { on: false });
  assert.deepEqual(look('eden:candle', 'core-candle', { 28: 1 }), { lit: true }, 'the same name where the def has it');
  assert.deepEqual(look('eden:desk_lamp', 'core-desk-lamp', { 28: 0 }), { on: false });
  assert.deepEqual(look('eden:floor_lamp', 'core-floor-lamp', { 28: 2 }), { on: true }, 'a floor lamp\'s brightness level is its on');
  assert.deepEqual(look('eden:floor_lamp', 'core-floor-lamp', { 28: 0 }), { on: false });
  assert.deepEqual(look('eden:door', 'core-door', { 6: 1, 24: 0 }), { open: true, locked: false });
  assert.deepEqual(look('eden:harvest_basket', 'core-harvest-basket', { 28: 3 }), { fruit: 3 }, 'a basket\'s fill');
  assert.deepEqual(look('eden:radio', 'core-radio', { 28: 1, 29: 'eden:dance_band' }), { on: true, station: 'dance band' });
  assert.deepEqual(look('mars:chair_x', 'core-campfire', { 27: 'eden:campfire', 28: 1 }), { on: true }, 'a borrowed entry');
  assert.deepEqual(look('eden:fridge', 'core-door', { 28: 1, 29: 4 }), { open: true }, 'a key the def does not draw is left out');
  assert.deepEqual(drawnState({ lit: true, tint: '#ff0000' }, { state: {} }), { tint: '#ff0000' }, 'a tint is kept on a def with no state');
  assert.deepEqual(drawnState({ lit: true }, undefined), { lit: true }, 'no def known: kept as v2 names it');
});

test('the campfire put out and lit again on v2: the layer draws its def\'s on, each time the stream says so', () => {
  const def = newest('core-campfire'), entities = new Map([['e_fire', { id: 'e_fire', def: def.ref, state: { on: true } as Record<string, unknown> }]]);
  const l = { seq: 3, model: { entities, resolvedDef: (ref: string) => lib.get(ref) } } as LayerLike & { seq: number };
  const apply = (d: WorldDiff | null) => { assert.ok(d); l.seq = d.seq; for (const e of d.diff.upserts as { id: string; def: string; state: Record<string, unknown> }[]) entities.set(e.id, e); };
  const ws = new WorldState();
  const part = (lit: number) => ({ t: 'part', p: { number: 1, from: 0, to: 500_000, nodes: [node('a.1', 'eden:campfire@ab', 'e_fire', { 28: lit })], removed: [] } });
  // the fallback table (no build here) knows a campfire too
  ws.receive(part(1));
  assert.equal(ws.diff(l, 0), null, 'lit, as the layer draws it');
  ws.receive(part(0));
  apply(ws.diff(l, 0));
  assert.equal(entities.get('e_fire')!.state.on, false, 'put out: no flames, smoke or light');
  assert.equal(ws.diff(l, 0), null);
  ws.receive(part(1));
  apply(ws.diff(l, 0));
  assert.equal(entities.get('e_fire')!.state.on, true, 'lit again');
});

test('a campfire never lit is out on v2 (its entry\'s default): drawn out, though the captured scene holds no state for it', () => {
  assert.deepEqual(look('eden:campfire@ab', 'core-campfire', {}), { on: false }, 'the default, where the node holds no field 28');
  assert.deepEqual(look('eden:lamp_post', 'core-lamp-post', {}), { on: true }, 'a lamp post is on by default');
  const lib2 = coreLibrary(), fire = newest('core-campfire'), post = newest('core-lamp-post');
  const entities = new Map<string, { id: string; def: string; state?: Record<string, unknown> }>([['e_fire', { id: 'e_fire', def: fire.ref }], ['e_post', { id: 'e_post', def: post.ref }]]);
  const l = { seq: 1, model: { entities, resolvedDef: (ref: string) => lib2.get(ref) } } as LayerLike;
  const ws = new WorldState();
  ws.receive({ t: 'part', p: { nodes: [{ id: 'a.1', kind: 'eden:campfire@ab', parent: 'w.1', origin: 'e_fire' }, { id: 'a.2', kind: 'eden:lamp_post', parent: 'w.1', origin: 'e_post' }], removed: [] } });
  const d = ws.diff(l, 0)!;
  assert.deepEqual(d.diff.upserts, [{ id: 'e_fire', def: fire.ref, state: { on: false } }], 'the fire is put out; the lamp post, drawn on already, is not sent');
});

test('a fire whose def says lit, put out, glows no more (its light and glow read lit as well as on)', () => {
  const fire = lib.get('core-campfire@1')!, e = (state?: Record<string, unknown>) => ({ id: 'e_f', def: fire.ref, in: { parent: 'world' }, by: 'v2', born: 0, v: 1, ...(state ? { state } : {}) }) as never;
  assert.ok(fire.state?.lit, 'this def keys its fire by lit');
  assert.notEqual(glowKind(new THREE.Group(), e(), fire), 'off', 'lit when the thing holds no state');
  assert.equal(glowKind(new THREE.Group(), e({ lit: false }), fire), 'off', 'put out');
  assert.equal(glowKind(new THREE.Group(), e({ on: false }), newest('core-campfire')), 'off');
});

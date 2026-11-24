// W2 (0.135): the old page's first picture from the stream's nodes alone (stream-scene.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, TILE_N } from '@souls/ground';
import { WorldModel } from '@souls/world-compiler';
import { entryLooks, libraryDef, SceneFromStream, solidsDef, streamSnapshot, tileHeights } from './stream-scene.ts';
import { fixTerrain, fixedTerrain } from './scene-offer.ts';
import type { NodeRec } from './source.ts';

const Q = 2 ** 30;
const at = (id: string, kind: string, parent: string | null, pos: [number, number, number], extra: Partial<NodeRec> = {}): NodeRec =>
  ({ id, kind, parent, slot: null, pos, rot: [Q, 0, 0, 0], at: null, ...extra });
/** One terrain tile (0, 0): every height `mm`, as import-eden writes it (little-endian i32 mm, TILE_N² of them). */
const tile = (mm: number): [number, number, Uint8Array, Uint8Array] => {
  const b = new Uint8Array(TILE_N * TILE_N * 4), v = new DataView(b.buffer);
  for (let i = 0; i < TILE_N * TILE_N; i++) v.setInt32(i * 4, mm, true);
  return [0, 0, b, new Uint8Array(64 * 64)];
};
const turned = (yaw: number): [number, number, number, number] => [Math.round(Math.cos(yaw / 2) * Q), 0, Math.round(Math.sin(yaw / 2) * Q), 0];

/** A hamlet as import-eden writes it: the world, its open ground, a pond, a hall with its floor, room and a bench in the
 *  room, a door, a kind the library does not have (drawn from its solids), a room's window and a derived place. */
const WORLD: NodeRec[] = [
  at('w', 'souls:place@1', null, [0, 0, 0], { sky: { 60: 86_400, 89: 'souls:dusk' } }),
  at('g', 'eden:ground@1', 'w', [0, 0, 0], { origin: 'ground', tileSize: 64_000, tiles: [tile(1500)] }),
  at('pond', 'eden:pond@1', 'g', [0, 0, 0], { origin: 'e_pond1', def: 'core-pond@1', outline: [[10_000, 10_000], [20_000, 10_000], [20_000, 20_000]], waterLevel: -200 }),
  at('hall', 'eden:hall@1', 'g', [30_000_000, 0, 5_000_000], { origin: 'e_hall1', def: 'core-hall@4', rot: turned(Math.PI / 2) }),
  at('floor', 'eden:floor@1', 'hall', [0, 0, 0], { origin: 'e_hall1/floor-0', surfaces: [[100, [[-4780, -3780], [4780, -3780], [4780, 3780], [-4780, 3780]]]] }),
  at('room', 'eden:room@1', 'floor', [0, 100_000, 0], { origin: 'e_hall1/hall' }),
  at('win', 'eden:window@1', 'room', [0, 0, -3_890_000], { origin: 'e_hall1/window-1' }),
  at('bench', 'eden:bench@1', 'room', [2_000_000, 0, 0], { origin: 'e_bench1', def: 'core-bench@1' }),
  at('door', 'eden:door@1', 'g', [1_000_000, 0, 2_000_000], { origin: 'e_door1', def: 'core-door@2', fields: { 6: 1 } }),
  at('odd', 'eden:lab_thing@1220abcd', 'g', [5_000_000, 0, 5_000_000], { origin: 'e_odd1', def: 'lab-thing@1', solids: [[0, 0, 500, 250, 0, 0, 2000, 0, 0]] }),
  at('shore', 'eden:place@1', 'g', [0, 0, 0], { origin: 'e_pond1.shore', outline: [[0, 0], [1, 0], [1, 1]] }),
  at('soul', 'souls:humanoid@1', 'g', [0, 0, 0], { soul: 's_1' }),
];

test('a hamlet from its stream: things at their world pose by their library defs, the pond a water, a building sized by its floor', () => {
  const s = streamSnapshot(WORLD, 'hamlet');
  const byId = new Map(s.entities.map((e) => [e.id, e]));
  assert.deepEqual([...byId.keys()].sort(), ['e_bench1', 'e_door1', 'e_hall1', 'e_odd1', 'e_pond1'], 'floors, rooms, windows, places and bodies are not things');
  assert.equal(byId.get('e_hall1')!.def, 'core-hall@4');
  assert.deepEqual(byId.get('e_hall1')!.params, { w: 10, d: 8, floors: 1 }, 'the size of the hall from its floor, inside walls 0.22 m thick');
  assert.ok(Math.abs((byId.get('e_hall1')!.r as number) - Math.PI / 2) < 1e-6);
  // the bench is in the hall's room: drawn at the world root, where the frames put it (the hall turned a quarter)
  const bench = byId.get('e_bench1')!;
  assert.deepEqual(bench.in, { parent: 'world' });
  assert.deepEqual((bench.p as number[]).map((v) => Math.round(v * 1000) / 1000), [30, 0.1, 3]);
  assert.deepEqual(byId.get('e_pond1')!.shape, { area: [[10, 10], [20, 10], [20, 20]] });
  assert.deepEqual(s.ground.waters, [{ id: 'e_pond1', area: [[10, 10], [20, 10], [20, 20]], level: -0.2 }]);
  // the library has no `lab-thing`: its solids, as boxes, and the hatch names it
  assert.match(byId.get('e_odd1')!.def, /^v2-eden-lab-thing-/);
  assert.ok(s.plain.some((p) => p.startsWith('eden:lab_thing: its solids')));
  assert.deepEqual(s.state, { sky: { palette: 'dusk' }, time: { clock: 'real' } });
  assert.equal(s.heights.get('0,0')![0], 1.5);
  // the snapshot is one the old page's model reads
  const m = WorldModel.fromSnapshot({ constants: s.constants, state: s.state, seed: s.seed, seq: 0, editSeq: 0, defs: s.defs, entities: s.entities, ground: s.ground } as never);
  assert.equal(m.entities.size, 5);
});

test('W3: a thing\'s recorded params (field 19) are drawn as the import carried them', () => {
  const params = { w: 12, d: 9, floors: 2, material: 'brick', roof: 'flat' };
  const s = streamSnapshot(WORLD.map((n) => (n.id === 'hall' ? { ...n, params } : n)), 'hamlet');
  assert.deepEqual(s.entities.find((e) => e.id === 'e_hall1')!.params, params, 'not the floor-derived size');
  assert.ok(!s.plain.some((p) => p.startsWith('params')), 'a world whose import carries params names no params hatch');
  assert.ok(streamSnapshot(WORLD, 'hamlet').plain.some((p) => p.startsWith('params')), 'one imported before W3 does');
});

test('the terrain draws the stream\'s heights, flat at the base off its tiles', () => {
  const t = new Terrain({ schema: 'ground/1', base: 0, extent: [-64, -64, 64, 64], landforms: [], waters: [] });
  fixTerrain(t, tileHeights(WORLD[1]));
  assert.ok(fixedTerrain(t));
  assert.equal(t.sample(10, 10), 1.5);
  assert.equal(t.peek(10, 10), 1.5);
  assert.equal(t.sample(-10, -10), 0);
  assert.equal(tileHeights({ ...WORLD[1], tileSize: 32_000 }).size, 0, 'tiles of another size are not the page\'s');
});

test('a kind draws by its imported ref, else by the newest library def of its name', () => {
  assert.equal(libraryDef('eden:bench@1', 'core-bench@1')?.ref, 'core-bench@1');
  assert.match(libraryDef('eden:lamp_post@99')?.ref ?? '', /^core-lamp-post@\d+$/);
  assert.equal(libraryDef('eden:no_such_kind@1'), undefined);
  assert.equal(solidsDef('eden:x@12', []), null);
});

test('the scene is offered once the stream has shown the open ground', () => {
  const scene = new SceneFromStream('hamlet');
  scene.receive({ t: 'snapshot', s: { nodes: [WORLD[0]], removed: [] } });
  assert.equal((globalThis as { __soulsStreamScene?: unknown }).__soulsStreamScene, undefined);
  scene.receive({ t: 'part', p: { nodes: WORLD.slice(1), removed: [] } });
  assert.equal((globalThis as { __soulsStreamScene?: { entities: number } }).__soulsStreamScene?.entities, 5);
  // K1: flat ground with no terrain tiles (N2's test world) is the open ground too
  delete (globalThis as { __soulsStreamScene?: unknown }).__soulsStreamScene;
  const flat = new SceneFromStream('flat');
  flat.receive({ t: 'snapshot', s: { nodes: [WORLD[0], { ...WORLD[1], tiles: undefined, tileSize: undefined }], removed: [] } });
  assert.deepEqual((globalThis as { __soulsStreamScene?: { tiles: number } }).__soulsStreamScene?.tiles, 0);
});

test('a placed kind with no library def draws its entry\'s bounds; one with a library def is left to the library', () => {
  const looks = entryLooks({ 'eden:planter': [1200, 600, 500], 'eden:lamp_post': [400, 4330, 400] });
  const planter = JSON.parse(new TextDecoder().decode(looks.get('eden:planter')));
  assert.deepEqual(planter, { format: 'souls-entry/1', kind: 'eden:planter', geometry: { bounds_mm: [1200, 600, 500] } });
  assert.equal(looks.get('eden:lamp_post'), undefined, 'the library draws a lamp post');
});

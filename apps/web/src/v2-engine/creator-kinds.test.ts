// 0.133 V1: a creator's kind that exists only in the new format becomes the old page's def and entity, drawn by the
// entity layer like any other (creator-kinds.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldModel } from '@souls/world-compiler';
import { CreatorKinds, entityId, kindDef } from './creator-kinds.ts';
import { WorldState, type LayerLike } from './world-state.ts';

const Q = 2 ** 30;
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** A birdbath as `souls-god define-kit` writes it: kit parts in mm (one by `from`/`to`), a palette. */
const KIT = { format: 'souls-entry/1', kind: 'atelier:birdbath', owner: 'thing', geometry: { bounds_mm: [600, 900, 600],
  parts: [{ kind: 'cyl', at: [0, 400, 0], r: 80, h: 800, tint: 'stone' }, { kind: 'cyl', from: [0, 800, 0], to: [0, 900, 0], r: 300, tint: 'water' }],
  palette: { stone: '#9a9488', water: '#5b8fb0' } }, motion: { how: 'fixed' }, text: { card: 'A stone birdbath.' } };
/** A lantern whose look is an uploaded model (K3, #3725): the allowed upload's hash. */
const SHA = 'ab'.repeat(32), MODEL = { format: 'souls-entry/1', kind: 'atelier:lantern', owner: 'thing', geometry: { bounds_mm: [300, 500, 300] }, looks: { model: `upload:1220${SHA}` } };
const node = (id: string, kind: string, pos: [number, number, number], extra = {}) => ({ id, kind, parent: 'root', pos, rot: [Q, 0, 0, 0] as [number, number, number, number], slot: null, ...extra });
const root = { id: 'root', kind: 'souls:world', parent: null, pos: [0, 0, 0] as [number, number, number], rot: [Q, 0, 0, 0] as [number, number, number, number], slot: null };

test('a kind record is the old page\'s def: kit parts in metres and radians, or a mesh by its upload\'s sha', () => {
  const kit = kindDef('atelier:birdbath@1a2b3c4d5e6f7a8b', bytes(KIT))!;
  assert.equal(kit.def.ref, 'v2-atelier-birdbath-3c4d5e6f7a8b@1');
  assert.deepEqual(kit.def.size.box, [0.6, 0.9, 0.6]);
  assert.equal(kit.def.make.kind, 'gen');
  const shapes = (kit.def.make as unknown as { args: { shapes: Record<string, unknown>[] } }).args.shapes;
  assert.deepEqual(shapes[0], { kind: 'cyl', at: [0, 0.4, 0], r: 0.08, h: 0.8, tint: 'stone' });
  assert.deepEqual(shapes[1].at, [0, 0.85, 0], 'a from/to part stands at their middle');
  assert.equal(shapes[1].h, 0.1);
  assert.deepEqual(kit.def.palette, { stone: '#9a9488', water: '#5b8fb0' });
  const mesh = kindDef('atelier:lantern@99', bytes(MODEL))!;
  assert.deepEqual(mesh.def.make, { kind: 'mesh', asset: SHA, collide: 'box' });
  assert.equal(mesh.model, `1220${SHA}`);
  assert.equal(kindDef('atelier:x@1', bytes({ format: 'other' })), null);
  assert.equal(kindDef('atelier:x@1', new TextEncoder().encode('{bad')), null);
  // the old world model takes the def and builds the thing's shape from it, as from any kit def
  const m = new WorldModel({ constants: { ground: 'land' }, seed: 'v1-creator-kinds' });
  m.defs.set(kit.def.ref, kit.def);
  const baked = m.bake(m.resolvedDef(kit.def.ref)!, {}, 0);
  assert.ok(baked.colliders.length > 0, 'its kit parts are solid, as a kit def\'s are');
});

test('things of a defined kind become entities at their world pose, once; a removed thing is removed', () => {
  const models: [string, string][] = [];
  const k = new CreatorKinds((h) => `/v2/uploads/${h}`, (sha, url) => models.push([sha, url]));
  const layer = { seq: 7, model: { entities: new Map<string, { id: string }>(), defs: new Map<string, unknown>() } };
  assert.equal(k.next(layer, 1), null, 'nothing defined yet');
  k.apply([root, node('kb', 'souls:kind', [0, 0, 0], { defines: 'atelier:birdbath@aa', entry: bytes(KIT) }), node('kl', 'souls:kind', [0, 0, 0], { defines: 'atelier:lantern@bb', entry: bytes(MODEL) }),
    node('aa11.3', 'atelier:birdbath@aa', [2_000_000, 0, -1_000_000]), node('aa11.4', 'atelier:lantern@bb', [3_000_000, 0, 0])], []);
  assert.deepEqual(models, [[SHA, `/v2/uploads/1220${SHA}`]], 'the model is fetched where the world serves uploads');
  const d = k.next(layer, 2, 9)!;
  assert.equal(d.seq, 10, 'after the diff already made this turn');
  assert.equal(d.diff.defs.length, 2);
  const up = d.diff.upserts as { id: string; def: string; p: number[]; in: { parent: string } }[];
  assert.deepEqual(up.map((e) => [e.id, e.p, e.in.parent]), [[entityId('aa11.3'), [2, 0, -1], 'world'], [entityId('aa11.4'), [3, 0, 0], 'world']]);
  assert.match(up[0].id, /^e_[a-z0-9]{4,12}$/);
  for (const e of up) layer.model.entities.set(e.id, e);
  for (const d2 of d.diff.defs as { ref: string }[]) layer.model.defs.set(d2.ref, d2);
  assert.equal(k.next(layer, 3), null, 'drawn already: nothing sent again');
  layer.model.defs.clear();
  assert.equal(k.next(layer, 3)!.diff.defs.length, 2, 'a layer that lost the defs (a resync) is sent them again');
  for (const d2 of d.diff.defs as { ref: string }[]) layer.model.defs.set(d2.ref, d2);
  k.apply([], ['aa11.3']);
  const gone = k.next(layer, 4)!;
  assert.deepEqual(gone.diff.removes, [entityId('aa11.3')]);
  assert.deepEqual(gone.diff.defs, []);
});

test('V2: a creator\'s thing of a kind the world has is drawn with that kind\'s old def; one of the world\'s own it removes goes', () => {
  const k = new CreatorKinds();
  const bench = { id: 'e_bench1', def: 'core/bench@1', in: { parent: 'world' }, p: [1, 0, 1] };
  const layer = { seq: 3, model: { entities: new Map<string, { id: string }>([['e_bench1', bench]]), defs: new Map<string, unknown>() } };
  // the world's own bench (its node's origin is its old entity), and a creator's new one beside it
  k.apply([root, node('aa11.5', 'eden:bench@1220aa', [1_000_000, 0, 1_000_000], { origin: 'e_bench1' }), node('cc22.7', 'eden:bench', [4_000_000, 0, 2_000_000])], []);
  const d = k.next(layer, 1)!;
  assert.deepEqual(d.diff.defs, [], 'the world has the def already');
  assert.deepEqual(d.diff.upserts, [{ id: entityId('cc22.7'), def: 'core/bench@1', in: { parent: 'world' }, p: [4, 0, 2], r: 0 }]);
  for (const e of d.diff.upserts as { id: string }[]) layer.model.entities.set(e.id, e);
  // moved by the creator: sent again at its new place
  k.apply([node('cc22.7', 'eden:bench', [5_000_000, 0, 2_000_000])], []);
  assert.deepEqual((k.next(layer, 2)!.diff.upserts as { p: number[] }[]).map((e) => e.p), [[5, 0, 2]]);
  // the world's own bench removed by the creator: it leaves the layer, and the creator's goes when removed too
  k.apply([], ['aa11.5', 'cc22.7']);
  const gone = k.next(layer, 3)!;
  assert.deepEqual(gone.diff.removes.sort(), [entityId('cc22.7'), 'e_bench1'].sort());
  layer.model.entities.delete('e_bench1'); layer.model.entities.delete(entityId('cc22.7'));
  assert.equal(k.next(layer, 4), null, 'nothing more once the layer dropped them');
});

test('W2: a creator\'s thing of a kind nothing in the world shows is drawn by its library def, sent with the diff', () => {
  const k = new CreatorKinds();
  const layer = { seq: 5, model: { entities: new Map<string, { id: string }>(), defs: new Map<string, unknown>() } };
  // a lamp post placed while the world runs (no origin: not of the captured scene), and the world's node (no thing)
  k.apply([root, node('dd33.9', 'eden:lamp_post@1220dd', [2_000_000, 0, 3_000_000])], []);
  const d = k.next(layer, 1)!;
  assert.equal(d.diff.upserts.length, 1, 'the lamp post, not the world node');
  const lamp = d.diff.upserts[0] as { id: string; def: string; p: number[] };
  assert.equal(lamp.id, entityId('dd33.9'));
  assert.match(lamp.def, /^core-lamp-post@\d+$/);
  assert.deepEqual(lamp.p, [2, 0, 3]);
  assert.deepEqual((d.diff.defs as { ref: string }[]).map((x) => x.ref), [lamp.def], 'the layer is sent the def it does not hold');
});

test('W2: a content kind\'s own shape draws only what no old or library def draws', () => {
  const k = new CreatorKinds();
  const stump = { id: 'e_stump1', def: 'mars-stump@2', in: { parent: 'world' }, p: [0, 0, 0] };
  const layer = { seq: 1, model: { entities: new Map<string, { id: string }>([['e_stump1', stump]]), defs: new Map<string, unknown>() } };
  const shape = (kind: string) => ({ id: `entry:${kind}`, kind: 'souls:kind', parent: null, pos: [0, 0, 0] as [number, number, number], rot: [Q, 0, 0, 0] as [number, number, number, number], slot: null,
    defines: kind, entry: bytes({ format: 'souls-entry/1', kind: kind.split('@')[0], geometry: { bounds_mm: [400, 300, 400] } }) });
  k.apply([root, shape('mars:stump@1220ee'), shape('mars:crate_x@1220ff'),
    node('aa.1', 'mars:stump@1220ee', [0, 0, 0], { origin: 'e_stump1' }), node('bb.2', 'mars:stump@1220ee', [1_000_000, 0, 0]), node('cc.3', 'mars:crate_x@1220ff', [2_000_000, 0, 0])], []);
  const ups = k.next(layer, 1)!.diff.upserts as { id: string; def: string }[];
  assert.equal(ups.find((u) => u.id === entityId('bb.2'))?.def, 'mars-stump@2', 'the world\'s own stumps\' def, not the entry\'s box');
  assert.match(ups.find((u) => u.id === entityId('cc.3'))?.def ?? '', /^v2-mars-crate-x-/, 'a kind nothing else draws: its entry\'s box');
});

test('a content kind with its own shape (looks.shape) draws as it, in its state; one arriving later replaces its box', async () => {
  const { readFileSync } = await import('node:fs');
  const zoe = JSON.parse(readFileSync(new URL('../../../../content/kinds/optical_toys/zoetrope.json', import.meta.url), 'utf8'));
  const d = kindDef('eden:zoetrope@1220abcdef012345', bytes(zoe))!;
  const args = (d.def.make as unknown as { args: { shapes: Record<string, unknown>[]; looks_table?: unknown[] } }).args;
  assert.equal(args.shapes.length, zoe.looks.shape.shapes.length, 'every shape of the entry, not one box');
  assert.deepEqual(args.shapes[0], { kind: 'box', at: [0, 0.45, 0], size: [0.1, 0.9, 0.1], tint: 'wood' }, 'in metres, its palette key kept');
  assert.equal(args.shapes[4].yaw, Math.PI / 6, 'millidegrees as radians');
  assert.equal(args.shapes.at(-1)!.role, 'lid', 'a role the looks table moves is kept');
  assert.equal(args.looks_table?.length, 2, 'the looks table rides in the make');
  assert.equal(d.def.palette?.wood, '#79563c');
  assert.deepEqual(Object.keys(d.def.state ?? {}).sort(), ['released', 'strip']);
  assert.doesNotMatch(d.def.ref, /-box@/);
  // its state from its node's fields (by the entry's numbers), as the picture reads it
  const k = new CreatorKinds();
  const layer = { seq: 1, model: { entities: new Map<string, { id: string }>(), defs: new Map<string, unknown>() } };
  const plainEntry = bytes({ format: 'souls-entry/1', kind: 'eden:zoetrope', geometry: { bounds_mm: [500, 1400, 400] } });
  k.apply([root, node('entry:eden:zoetrope@1220ab', 'souls:kind', [0, 0, 0], { defines: 'eden:zoetrope@1220ab', entry: plainEntry }),
    node('z.1', 'eden:zoetrope@1220ab', [1_000_000, 0, 0], { fields: { 28: 2, 29: 1 } })], []);
  const first = k.next(layer, 1)!.diff.upserts as { def: string; state?: unknown }[];
  assert.match(first[0].def, /-box@1$/, 'its bounds as one box until its look is here');
  for (const e of first) layer.model.entities.set(entityId('z.1'), e as never);
  k.apply([node('entry:eden:zoetrope@1220ab', 'souls:kind', [0, 0, 0], { defines: 'eden:zoetrope@1220ab', entry: bytes(zoe) })], []);
  const then = k.next(layer, 2)!;
  const up = then.diff.upserts as { def: string; state?: Record<string, unknown> }[];
  assert.doesNotMatch(up[0].def, /-box@/, 'drawn again from its shape');
  assert.deepEqual(up[0].state, { strip: 2, released: true });
  assert.equal(then.diff.defs.length, 1, 'the new def goes with it');
  k.apply([node('z.1', 'eden:zoetrope@1220ab', [1_000_000, 0, 0], { fields: { 28: 0, 29: 0 } })], []);
  assert.deepEqual((k.next(layer, 3)!.diff.upserts as { state?: unknown }[])[0].state, { strip: 0, released: false }, 'a changed state is sent');
});

test('a road a creator lays (place --path) is drawn along its line by its library def; on a world with roads, by theirs', () => {
  const k = new CreatorKinds();
  const layer = { seq: 2, model: { entities: new Map<string, { id: string; def?: string }>(), defs: new Map<string, unknown>() } };
  // as shapes.mjs lays it: at the ground's origin, its line (16), width (17) and ribbon outline (11) in mm
  const road = node('ee44.1', 'eden:footpath@1220ab', [0, 0, 0], { line: [[0, 0], [9000, 0]], lineWidth: 2000, outline: [[0, 1000], [9000, 1000], [9000, -1000], [0, -1000]] });
  k.apply([root, road], []);
  const d = k.next(layer, 1)!;
  const up = d.diff.upserts as { id: string; def: string; shape: unknown; p?: unknown }[];
  assert.equal(up.length, 1);
  assert.match(up[0].def, /^core-footpath@\d+$/);
  assert.deepEqual(up[0].shape, { path: [[0, 0], [9, 0]], width: 2 }, 'its line in metres, world, and its width');
  assert.equal(up[0].p, undefined, 'world-frame geometry: no pose of its own');
  assert.deepEqual((d.diff.defs as { ref: string }[]).map((x) => x.ref), [up[0].def]);
  layer.model.entities.set(up[0].id, up[0]);
  for (const x of d.diff.defs as { ref: string }[]) layer.model.defs.set(x.ref, x);
  assert.equal(k.next(layer, 2), null, 'drawn already');
  // on a world whose own roads the layer draws (Eden's), the creator's road takes their def
  const k2 = new CreatorKinds(), eden = { id: 'e_path01', def: 'core-footpath@1', in: { parent: 'world' }, shape: { path: [[0, 5], [5, 5]] } };
  const layer2 = { seq: 1, model: { entities: new Map<string, { id: string; def?: string }>([['e_path01', eden]]), defs: new Map<string, unknown>() } };
  k2.apply([root, node('ab.1', 'eden:footpath@1220ab', [0, 0, 0], { origin: 'e_path01', line: [[0, 5000], [5000, 5000]] }), road], []);
  const d2 = k2.next(layer2, 1)!;
  assert.deepEqual(d2.diff.defs, []);
  assert.deepEqual((d2.diff.upserts as { def: string }[]).map((u) => u.def), ['core-footpath@1']);
});

test('a piece furnish places in a room (named `<room>-<item>` in field 1, as today names it) is drawn, at its world pose; the building\'s rooms and windows are not', () => {
  const k = new CreatorKinds();
  const cottage = { id: 'e_cot1', def: 'core-cottage@3', in: { parent: 'world' }, p: [44, 0, 10] };
  const layer = { seq: 4, model: { entities: new Map<string, { id: string }>([['e_cot1', cottage]]), defs: new Map<string, unknown>() } };
  // as import-eden writes a cottage: the thing (its old entity), its floor, its bedroom and a window, under the bedroom
  // the bunk furnish placed (#5006: `e_…/bedroom-bed`) and a lamp a creator placed there by hand (no name)
  const under = (id: string, kind: string, parent: string, pos: [number, number, number], origin?: string) => ({ ...node(id, kind, pos, origin ? { origin } : {}), parent });
  k.apply([root, under('c.1', 'eden:cottage@1220c1', 'root', [44_000_000, 0, 10_000_000], 'e_cot1'),
    under('c.2', 'eden:floor@1220c2', 'c.1', [0, 0, 0], 'e_cot1/floor-0'), under('c.3', 'eden:room@1220c3', 'c.2', [-2_665_000, 100_000, -1_420_000], 'e_cot1/bedroom'),
    under('c.4', 'eden:window@1220c4', 'c.3', [1_000_000, 900_000, 1_300_000], 'e_cot1/window-1'),
    under('f.82', 'eden:bunk@1220b5', 'c.3', [-228_000, 0, -315_000], 'e_cot1/bedroom-bed'), under('h.1', 'eden:lamp_post@1220dd', 'c.3', [500_000, 0, 500_000])], []);
  const d = k.next(layer, 1)!;
  const up = d.diff.upserts as { id: string; def: string; p: number[] }[];
  assert.deepEqual(up.map((e) => e.id).sort(), [entityId('f.82'), entityId('h.1')].sort(), 'the furnished bunk and the hand-placed lamp; not the cottage, its floor, room or window');
  const bunk = up.find((e) => e.id === entityId('f.82'))!;
  assert.match(bunk.def, /^core-bunk@\d+$/, 'drawn by its library def, as the template\'s own furniture is');
  assert.deepEqual(bunk.p.map((v) => +v.toFixed(3)), [41.107, 0.1, 8.265], 'in the bedroom, through the cottage\'s floor');
  for (const e of up) layer.model.entities.set(e.id, e);
  k.apply([], ['f.82']);
  assert.deepEqual(k.next(layer, 2)!.diff.removes, [entityId('f.82')], 'removed with its node');
});

// A creator's move to another parent is a remove and a new place under the same origin (live Eden, 27 Nov: 35 roof
// planters and the commons podium set on the ground). The removed node's origin is still a held node's: the layer's
// entity is that thing's, and world-state.ts moves it. Removing it here left nothing to draw it again.
test('a thing of the world\'s own removed and placed again under its origin in one part keeps its entity', () => {
  const k = new CreatorKinds();
  const planter = { id: 'e_planter1', def: 'core/planter@1', in: { parent: 'world' }, p: [1, 3, 1] };
  const layer = { seq: 3, model: { entities: new Map<string, { id: string }>([['e_planter1', planter]]), defs: new Map<string, unknown>() } };
  k.apply([root, node('aa11.5', 'eden:planter@1220aa', [1_000_000, 3_000_000, 1_000_000], { origin: 'e_planter1' })], []);
  assert.equal(k.next(layer, 1), null, 'as captured');
  k.apply([node('cc22.9', 'eden:planter@1220aa', [6_000_000, 0, 2_000_000], { origin: 'e_planter1' })], ['aa11.5']);
  assert.equal(k.next(layer, 2), null, 'a held node has the origin: its entity stays in the layer');
  assert.ok(layer.model.entities.has('e_planter1'));
  // removed for good later: it goes, as any of the world's own things a creator removes
  k.apply([], ['cc22.9']);
  assert.deepEqual(k.next(layer, 3)!.diff.removes, ['e_planter1']);
});

// The same, through the page's two readers in the order use-v2-souls.ts runs them (WorldState's diff, then this
// module's after it), against a layer that applies each diff in sequence as WorldEntityLayer's applyDiff does.
test('a thing moved from a roof to the ground in one part is drawn once, on the ground (WorldState and CreatorKinds together)', () => {
  const ws = new WorldState(), k = new CreatorKinds();
  const poses: Record<string, { x: number; y: number; z: number; yaw: number; s: number }> = { e_planter1: { x: 1, y: 3, z: 1, yaw: 0, s: 1 } };
  const l = { seq: 7, model: { entities: new Map<string, { id: string; in?: unknown; p?: number[] }>([['e_planter1', { id: 'e_planter1', in: { parent: 'world' }, p: [1, 3, 1] }]]),
    defs: new Map<string, unknown>(), state: {}, worldPose: (e: { id: string }) => poses[e.id] } };
  const layer = l as unknown as LayerLike;
  const turn = (nodes: unknown[], removed: string[]) => {
    ws.receive({ t: 'part', p: { number: 1, from: 0, to: 500_000, nodes, removed, samples: [] } } as never);
    k.apply(nodes as never, removed);
    const diff = ws.next(layer, 0), made = k.next(layer, 0, diff?.seq);
    for (const d of [diff, made]) {
      if (!d) continue;
      assert.equal(d.seq, l.seq + 1, 'next in the layer\'s sequence');
      l.seq = d.seq;
      for (const id of d.diff.removes) l.model.entities.delete(id);
      for (const e of d.diff.upserts as { id: string }[]) l.model.entities.set(e.id, { ...l.model.entities.get(e.id), ...e });
    }
    return { diff, made };
  };
  const ground = { id: 'g.1', kind: 'souls:ground', parent: 'root', pos: [0, 0, 0], rot: [Q, 0, 0, 0], slot: null };
  const roof = { ...node('r.1', 'eden:house@1220bb', [1_000_000, 0, 1_000_000], { origin: 'e_house' }), parent: 'g.1' };
  const on = (id: string, parent: string, pos: [number, number, number]) => ({ ...node(id, 'eden:planter@1220aa', pos, { origin: 'e_planter1' }), parent });
  assert.deepEqual(turn([root, ground, roof, on('aa11.5', 'r.1', [0, 3_000_000, 0])], []), { diff: null, made: null }, 'as captured: on the roof');
  const moved = turn([on('cc22.9', 'g.1', [6_000_000, 0, 2_000_000])], ['aa11.5']);
  assert.equal(moved.made, null, 'CreatorKinds does not remove an origin a held node has');
  const e = l.model.entities.get('e_planter1');
  assert.ok(e, 'still drawn');
  assert.deepEqual([e.in, e.p!.map((v) => +v.toFixed(3))], [{ parent: 'world' }, [6, 0, 2]], 'on the ground, where v2 placed it');
  assert.deepEqual(turn([], []), { diff: null, made: null }, 'once drawn there, nothing more');
});

test('held pictures resolve the exact loaded bowl revision, canonical grip and changing soup state', async () => {
  const {readFileSync} = await import('node:fs');
  const bowl = JSON.parse(readFileSync(new URL('../../../../content/kinds/food/soup_bowl.json',import.meta.url),'utf8'));
  const k = new CreatorKinds();
  k.apply([node('entry:bowl','souls:kind',[0,0,0],{defines:'eden:soup_bowl@aa',entry:bytes(bowl)})],[]);
  const entry = {id:'bowl',kind:'eden:soup_bowl@aa',parent:'body',slot:7,pos:[0,0,0],rot:[Q,0,0,0]} as const;
  for (const quantity of [2,1,0,2]) {
    const held = k.held({...entry,fields:{28:quantity}})!;
    assert.deepEqual(held.grip,[.12,.06,0]); assert.equal(held.state.soup,quantity);
    assert.deepEqual(held.points.bite.at,[-.11,.1,0]);
    assert.equal(held.def.make.kind,'gen'); assert.doesNotMatch(held.def.ref,/-box@/);
  }
  assert.equal(k.held({...entry,fields:{28:{big:'9007199254740993'}}}),null,'lossless large integer is unsupported, never default full soup');
  assert.equal(k.held({...entry,fields:{28:{value:{big:'9007199254740993'},per_s:-1,set_us:{big:'10000000'}}}}),null,'timed state requires its authoritative clock, not a default');
  assert.equal(k.held({...entry,kind:'eden:soup_bowl@bb'}),null);
  assert.equal(k.held({...entry,kind:'eden:soup_bowl'}),null);
  k.apply([],['entry:bowl']); assert.equal(k.held(entry),null);
});

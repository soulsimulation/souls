// 0.133 V1: a creator's kind that exists only in the new format becomes the old page's def and entity, drawn by the
// entity layer like any other (creator-kinds.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldModel } from '@souls/world-compiler';
import { CreatorKinds, entityId, kindDef } from './creator-kinds.ts';

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

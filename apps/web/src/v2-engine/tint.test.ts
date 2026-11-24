// R4 (0.134): a creator's tint (v2 field 145) reaches the old page's entity as `state.tint`, and the look conventions
// multiply its picture by it: the whole thing, or one part by its role; an undo (no rows) draws it as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyLook, recolourOf } from '../gen-mesh/vocab-look.ts';
import { meshFor, type MeshCtx } from '../gen-mesh/registry.ts';
import { MaterialLib } from '../gen-mesh/materials.ts';
import '../gen-mesh/kit.mesh.ts';
import { thingState, tintState, WorldState, type LayerLike, type WorldDiff } from './world-state.ts';

const chair = (tint?: [string, number][]) => ({ id: 'a.1', kind: 'eden:chair', parent: 'w.1', origin: 'e_chair', ...(tint ? { tint } : {}) });
const part = (nodes: unknown[]) => ({ t: 'part', p: { number: 1, from: 0, to: 500_000, nodes, removed: [], samples: [] } });

/** The chair's picture as the layer builds it for an entity's state: a seat and a back, each its own white mesh. */
function draw(state: Record<string, unknown>) {
  const mesh = (role: string) => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#ffffff' })); m.userData.role = role; return m; };
  const root = new THREE.Group(), seat = mesh('seat'), back = mesh('back');
  root.add(seat, back);
  applyLook(root, { def: { params: {}, state: {}, components: {} }, params: {}, entity: { id: 'e_chair', state }, args: {}, baked: { box: [1, 1, 1] } } as unknown as MeshCtx);
  const hex = (m: THREE.Mesh) => '#' + (m.material as THREE.MeshStandardMaterial).color.getHexString();
  return { seat: hex(seat), back: hex(back) };
}

test('R4: a part named by a kit\'s palette key takes the recolour, and a recoloured kit is not the plain one\'s cached picture', () => {
  const def = { hash: 'r4-kit', ref: 'r4-kit@1', name: 'r4-kit', description: 'a kit',  make: { kind: 'gen', gen: 'kit/2' }, tags: [], components: {}, params: {}, state: {}, palette: { wood: '#9a6b46', iron: '#2f3633' } } as unknown as MeshCtx['def'];
  const args = { v: 2, round: 0, shapes: [{ kind: 'box', at: [0, 0.5, 0], size: [1, 0.1, 0.4], tint: 'wood' }, { kind: 'box', at: [0, 0.2, 0], size: [0.1, 0.4, 0.1], tint: 'iron', material: 'metal' }] };
  // the entity layer's tint (WorldEntityLayer build): a recoloured palette key first, then params and the def's palette
  const colours = (state: Record<string, unknown>) => {
    const parts = recolourOf(state.tint)?.parts ?? {}, palette = (def as unknown as { palette: Record<string, string> }).palette;
    const ctx = { def, entity: { id: 'e_kit', state }, params: {}, args, baked: { box: [1, 1, 1] }, materials: new MaterialLib(),
      tint: (key: string | undefined, fallback: string) => (key ? parts[key] ?? palette[key] ?? fallback : fallback) } as unknown as MeshCtx;
    const obj = meshFor(def)!.build(ctx)!, out = new Set<string>(), c = new THREE.Color();
    obj.traverse((o) => { const g = (o as THREE.Mesh).geometry, col = g?.attributes?.color; if (!(o as THREE.Mesh).isMesh || !col || o.userData.shadowProxy) return; for (let i = 0; i < col.count; i++) out.add('#' + c.fromBufferAttribute(col as THREE.BufferAttribute, i).getHexString()); });
    return out;
  };
  const plain = colours({}), blue = colours({ tint: 'wood=#3060ff' });
  assert.ok(!plain.has('#3060ff'), 'the def draws its wood');
  assert.ok(blue.has('#3060ff'), `the wood is the recolour: ${[...blue]}`);
  assert.ok(!colours({}).has('#3060ff'), 'the plain kit is drawn plain again');
});

test('R4: a tint\'s rows are the entity\'s state.tint; none is no state, and an undone tint is empty', () => {
  assert.equal(tintState([['part:seat', 0xff], ['tint:whole', 0xff0000]]), '#ff0000 seat=#0000ff');
  assert.equal(tintState([]), '');
  assert.equal(tintState(undefined), undefined);
  assert.equal(thingState(chair()), null, 'never recoloured: drawn as the layer has it');
  assert.deepEqual(thingState(chair([['tint:whole', 0x00ff00]])), { tint: '#00ff00' });
  assert.deepEqual(recolourOf('#ff0000 seat=#0000ff'), { all: '#ff0000', parts: { seat: '#0000ff' } });
  assert.equal(recolourOf(''), null);
});

test('R4: a recolour on v2 is drawn on the old page, the whole thing or one part, and drawn as before once undone', () => {
  const ws = new WorldState();
  const l = { seq: 3, model: { entities: new Map<string, { id: string; state?: Record<string, unknown> }>([['e_chair', { id: 'e_chair' }]]) } };
  const apply = (d: WorldDiff | null) => { assert.ok(d, 'a diff'); l.seq = d.seq; for (const e of d.diff.upserts as { id: string }[]) l.model.entities.set(e.id, e); };
  const drawn = () => draw(l.model.entities.get('e_chair')!.state ?? {});
  assert.deepEqual(drawn(), { seat: '#ffffff', back: '#ffffff' }, 'as the def draws it');

  ws.receive(part([chair([['tint:whole', 0xff0000]])]));
  apply(ws.diff(l as unknown as LayerLike, 0));
  assert.deepEqual(drawn(), { seat: '#ff0000', back: '#ff0000' }, 'the whole chair');

  ws.receive(part([chair([['tint:whole', 0xff0000], ['part:seat', 0x00ff00]])]));
  apply(ws.diff(l as unknown as LayerLike, 0));
  assert.deepEqual(drawn(), { seat: '#000000', back: '#ff0000' }, 'the seat multiplied by both');

  ws.receive(part([chair([['part:seat', 0x00ff00]])]));
  apply(ws.diff(l as unknown as LayerLike, 0));
  assert.deepEqual(drawn(), { seat: '#00ff00', back: '#ffffff' }, 'only the seat');

  ws.receive(part([chair([])]));
  apply(ws.diff(l as unknown as LayerLike, 0));
  assert.deepEqual(drawn(), { seat: '#ffffff', back: '#ffffff' }, 'undone: as before');
  assert.equal(ws.diff(l as unknown as LayerLike, 0), null, 'drawn: no diff again');
});

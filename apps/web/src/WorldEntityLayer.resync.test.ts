// Offline: node --import=./tools/test-harness/web-loader.mjs --test apps/web/src/WorldEntityLayer.resync.test.ts
// Lane PERF-SNAPSHOT: a resync applies the snapshot as a delta (applyDelta): an unchanged thing is not drawn again and
// stays frozen; a changed one is re-posed or rebuilt; a missing one goes; a snapshot behind the socket never steps back.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { registerHooks } from 'node:module';
import { WorldModel, coreLibrary, applyBatch, type Entity } from '@souls/world-compiler';
import { diffSnapshots, type PlainSnapshot, type SnapshotDelta, type SnapshotDecoder } from './snapshot-delta.ts';

type Drawn = { settled?: boolean; frozen?: THREE.Object3D[]; removing?: boolean; dur: number; obj: THREE.Object3D; to: { p: THREE.Vector3; s: number } };
type Inner = { snapshotDecoder: () => Promise<SnapshotDecoder>; model: WorldModel; draw: (e: Entity, ease: boolean) => void; drawn: Map<string, Drawn>; now: number; seq: number; signal: AbortSignal; touched: Set<string>; groundTouched: boolean; applyDelta: (d: SnapshotDelta, asked: Set<string>, signal: AbortSignal) => Promise<void> };

const plain = (m: WorldModel, seq: number): PlainSnapshot => { const s = m.snapshot(); return { contract: 'world/1', seq, counter: s.seq, seed: s.seed, constants: s.constants, state: s.state, ground: s.ground, defs: structuredClone(s.defs) as never, entities: structuredClone(s.entities) as never, builds: [], buildsRev: 0, now: 0 }; };

async function fixture() {
  (globalThis as { location?: unknown }).location ??= new URL('http://offline.invalid/w/fixture');
  const index = new URL('./gen-mesh/index.ts', import.meta.url).href;
  const hook = registerHooks({ load(url, ctx, next) { return url === index ? { format: 'module', shortCircuit: true, source: "export { meshFor } from './registry.ts';" } : next(url, ctx); } });
  const { WorldEntityLayer } = await import('./WorldEntityLayer.ts').finally(() => hook.deregister()); await import('./gen-mesh/kit.mesh.ts');
  const model = new WorldModel({ constants: { ground: 'land', extent: 350 }, seed: 'resync' }); model.library = coreLibrary();
  const r = applyBatch(model, { ops: [{ op: 'place', def: 'core/floor-lamp@2', name: 'a', p: [3, 0] }, { op: 'place', def: 'core/floor-lamp@2', name: 'b', p: [-3, 0] }] }, 'god', 1);
  assert.equal(r.result.accepted, true, JSON.stringify(r.result));
  const layer = new WorldEntityLayer((p) => p), inner = layer as unknown as Inner;
  inner.model = model; layer.active = true; layer.freezeSettled = true; inner.seq = 10; inner.now = 1000; inner.signal = new AbortController().signal;
  const scene = new THREE.Scene(); scene.add(layer.group);
  let now = 1000;
  const frame = () => { now += 16; inner.now = now; layer.update(0.016, now); scene.updateMatrixWorld(); };
  for (const e of model.entities.values()) inner.draw(e, false);
  for (let i = 0; i < 4; i++) frame();
  const a = model.get('a')!, b = model.get('b')!;
  const d = (id: string) => inner.drawn.get(id);
  assert.ok(!!d(a.id)?.frozen && !!d(b.id)?.frozen, 'both settled and frozen before the resync');
  const base = plain(model, 10);
  return { layer, inner, model, a, b, d, frame, base, scene };
}
const drawCalls = (inner: Inner) => { let n = 0; const orig = inner.draw; inner.draw = function (e, ease) { n++; return orig.call(this, e, ease); }; return () => n; };

test('the same picture again: nothing is drawn, nothing thaws, the seq moves on', async () => {
  const f = await fixture(); const draws = drawCalls(f.inner);
  await f.inner.applyDelta(diffSnapshots(f.base, plain(f.model, 12)), new Set(), f.inner.signal);
  assert.equal(draws(), 0);
  assert.equal(f.layer.lastResync?.drawn, 0); assert.equal(f.layer.lastResync?.unchanged, 2); assert.equal(f.layer.lastResync?.full, false);
  assert.ok(!!f.d(f.a.id)?.frozen && !!f.d(f.b.id)?.frozen, 'still frozen');
  assert.equal(f.inner.seq, 12); assert.equal(f.layer.stats.resyncs, 1);
});

test('a full snapshot (the worker had no baseline) equal to what we hold: nothing is drawn either', async () => {
  const f = await fixture(); const draws = drawCalls(f.inner);
  await f.inner.applyDelta(diffSnapshots(null, plain(f.model, 11)), new Set(), f.inner.signal);
  assert.equal(draws(), 0); assert.equal(f.layer.lastResync?.full, true); assert.equal(f.layer.lastResync?.upserts, 0);
  assert.ok(!!f.d(f.a.id)?.frozen && !!f.d(f.b.id)?.frozen, 'still frozen');
});

test('a moved thing is re-posed at once (no easing) and the other is left frozen; a missing one goes; a new one eases in', async () => {
  const f = await fixture(); const draws = drawCalls(f.inner);
  const next = plain(f.model, 13);
  const moved = next.entities.find((e) => e.id === f.a.id)!; (moved as unknown as { p: number[] }).p = [6, 0, 0];
  next.entities = next.entities.filter((e) => e.id !== f.b.id);
  const fresh = { ...structuredClone(moved), id: 'e_new', name: 'c', p: [0, 0, 5] };
  next.entities.push(fresh as never);
  await f.inner.applyDelta(diffSnapshots(f.base, next), new Set(), f.inner.signal);
  assert.equal(draws(), 2, 'the moved one and the new one');
  assert.deepEqual(f.layer.lastResync && [f.layer.lastResync.upserts, f.layer.lastResync.removes, f.layer.lastResync.drawn], [2, 1, 2]);
  assert.deepEqual(f.model.get('a')!.p, [6, 0, 0]);
  const da = f.d(f.a.id)!; assert.equal(da.settled, false, 'out of settled: the next frame thaws and re-poses it'); assert.equal(da.to.p.x, 6); assert.ok(da.dur < 0.01, 'no easing for a thing already drawn');
  f.frame(); assert.equal(!!da.frozen, false, 'thawed'); assert.equal(da.obj.position.x, 6, 'at its new place on the first frame');
  assert.equal(f.d(f.b.id)?.removing, true, 'eases out (then leaves the drawn set)'); assert.equal(f.model.entities.has(f.b.id), false);
  const dn = f.d('e_new')!; assert.ok(!!dn, 'drawn'); assert.ok(dn.dur > 0.5, 'a new thing eases in');
  for (let i = 0; i < 80; i++) f.frame();
  assert.equal(f.inner.drawn.has(f.b.id), false, 'gone once eased out');
  assert.ok(!!f.d(f.a.id)?.frozen, 'the moved one settles and freezes again at its new place'); assert.equal(f.d(f.a.id)!.obj.position.x, 6);
});

test('a changed record with the same pose (a param) rebuilds that thing only', async () => {
  const f = await fixture(); const draws = drawCalls(f.inner);
  const next = plain(f.model, 14), e = next.entities.find((x) => x.id === f.a.id)!;
  (e as { params?: Record<string, unknown> }).params = { ...((e as { params?: Record<string, unknown> }).params ?? {}), shade: '#123456' };
  const objBefore = f.d(f.a.id)!.obj, bObj = f.d(f.b.id)!.obj;
  await f.inner.applyDelta(diffSnapshots(f.base, next), new Set(), f.inner.signal);
  assert.equal(draws(), 1);
  assert.ok(f.d(f.a.id)!.obj !== objBefore, 'rebuilt'); assert.ok(f.d(f.b.id)!.obj === bObj, 'the other is the same object'); assert.ok(!!f.d(f.b.id)!.frozen, 'the other stays frozen');
});

test('a snapshot behind the socket (a diff applied while it downloaded) removes only what we did not touch and never steps back', async () => {
  const f = await fixture(); const draws = drawCalls(f.inner);
  f.inner.seq = 20;
  const next = plain(f.model, 15);
  const moved = next.entities.find((e) => e.id === f.a.id)!; (moved as unknown as { p: number[] }).p = [9, 0, 0];
  next.entities = next.entities.filter((e) => e.id !== f.b.id);
  const d = diffSnapshots(f.base, next); d.removes.push('e_touched');
  await f.inner.applyDelta(d, new Set(['e_touched']), f.inner.signal);
  assert.equal(draws(), 0, 'no upsert applied'); assert.deepEqual(f.model.get('a')!.p, [3, 0, 0]);
  assert.equal(f.inner.seq, 20); assert.equal(f.layer.lastResync?.stale, true);
  assert.equal(f.model.entities.has(f.b.id), false, 'what the server no longer has and we did not touch goes');
});

test('applyEdge remembers what the socket changed, so the next delta reports those ids whatever the worker holds', async () => {
  const f = await fixture();
  f.layer.applyEdge([{ type: 'edge', kind: 'world-diff', seq: 11, by: 'god', diff: { upserts: [{ ...f.a, p: [4, 0, 0] }], removes: [f.b.id], defs: [], tiles: [] } } as never]);
  assert.deepEqual([...f.inner.touched].sort(), [f.a.id, f.b.id].sort()); assert.equal(f.inner.groundTouched, false);
  const d = diffSnapshots(f.base, f.base, f.inner.touched);
  assert.deepEqual(d.upserts.map((e) => e.id).sort(), [f.a.id, f.b.id].sort(), 'both asked for although the snapshot did not change');
});


test('concurrent cold snapshot requests share a baseline owner and teardown closes it', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.inner.snapshotDecoder(), f.inner.snapshotDecoder()]);
  assert.equal(a, b);
  const pieces = { kind: 'plain' as const, body: [new TextEncoder().encode(JSON.stringify(f.base))] };
  assert.deepEqual(await a.initial(pieces), f.base);
  f.layer.dispose();
  await assert.rejects(a.initial(pieces), /disposed/);
  await assert.rejects(f.inner.snapshotDecoder(), { name: 'AbortError' });
});

test('teardown while the snapshot client module is loading prevents a late decoder', async () => {
  const f = await fixture(), pending = f.inner.snapshotDecoder();
  f.layer.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
});

// #1664: actual socket/resync drawing, not a detached birth-transform helper.
for (const instanced of [false, true]) test(`new supported output is full-size at its authoritative surface from first draw (${instanced ? 'instanced' : 'ordinary'})`, async t => {
  const f = await fixture(); t.after(() => f.layer.dispose());
  const placed = applyBatch(f.model, {ops:[{op:'place',def:'core/table@1',name:'support',p:[8,4],r:.7}]}, 'god', 2);
  assert.equal(placed.result.accepted,true,JSON.stringify(placed.result));
  const parent = f.model.get('support')!; f.inner.draw(parent,false); f.frame();
  const result = applyBatch(f.model,{ops:[{op:'place',def:'core/bowl@1',name:'output',in:{parent:parent.id,slot:'top'},p:[.1,0]}]},'god',3);
  assert.equal(result.result.accepted,true,JSON.stringify(result.result));
  const child = structuredClone(f.model.get('support/output')!), expected=f.model.worldPose(child); f.model.delete(child.id);
  const inner=f.inner as typeof f.inner & {build(e:Entity,...args:unknown[]):THREE.Object3D};
  const build=inner.build; inner.build=function(e,...args){const obj=build.call(this,e,...args);delete obj.userData.instanceKey;if(instanced&&e.id===child.id)obj.userData.instanceKey='supported-output';return obj;};
  const before=plain(f.model,10), instancesBefore=f.layer.instancer.instances;
  f.layer.applyEdge([{type:'edge',kind:'world-diff',seq:11,by:'god',diff:{upserts:[child],removes:[],defs:[],tiles:[]}} as never]);
  const d=f.d(child.id)!;
  assert.deepEqual(d.obj.position.toArray(),[expected.x,expected.y,expected.z],'first draw at actual supported transform');
  assert.equal(d.obj.scale.x,expected.s,'first draw at full authoritative scale'); assert.ok(d.dur<.01);
  f.frame(); assert.deepEqual(d.obj.position.toArray(),[expected.x,expected.y,expected.z]);
  if(instanced){assert.equal(f.layer.instancer.instances,instancesBefore+1);const pool=(f.layer.instancer as unknown as {pools:Map<string,{meshes:THREE.InstancedMesh[]}>}).pools.get('supported-output')!;assert.ok(pool.meshes.length>0);for(const mesh of pool.meshes){const m=new THREE.Matrix4();mesh.getMatrixAt(0,m);const p=new THREE.Vector3().setFromMatrixPosition(m);assert.ok(Math.hypot(p.x-expected.x,p.z-expected.z)<1e-5);assert.ok(Math.abs(p.y-expected.y)<1e-5);}}
  // A resync must qualify the same admitted output through the real delta path.
  f.model.delete(child.id); (f.inner as unknown as {unload(id:string):void}).unload(child.id);
  const next=plain(f.model,12);next.entities.push(child as never);
  await f.inner.applyDelta(diffSnapshots(before,next),new Set(),f.inner.signal);
  assert.deepEqual(f.d(child.id)!.obj.position.toArray(),[expected.x,expected.y,expected.z]);assert.equal(f.d(child.id)!.obj.scale.x,expected.s);
});

test('a child of a newly created surface parent keeps ordinary God creation easing',async t=>{
  const f=await fixture();t.after(()=>f.layer.dispose());
  const parent={id:'new-parent',name:'new-parent',def:'core/table@1',in:{parent:'world'},p:[8,0,4],by:'god',born:0,v:1} as Entity;
  const child={id:'new-output',name:'output',def:'core/bowl@1',in:{parent:parent.id,slot:'top'},p:[0,0],by:'god',born:0,v:1} as Entity;
  f.layer.applyEdge([{type:'edge',kind:'world-diff',seq:11,by:'god',diff:{upserts:[parent,child],removes:[],defs:[],tiles:[]}} as never]);
  const d=f.d(child.id)!;assert.equal(d.obj.position.y,d.to.p.y+40);assert.equal(d.obj.scale.x,.2);assert.equal(d.dur,2.5);
});

// #1809: native completion provenance is persisted on the entity; the envelope alone is not authority.
for(const def of ['core/chair@2','core/bowl@2'])for(const by of ['engine','god'])test(`ground ${def} creation preserves ${by} provenance through socket and resync`,async t=>{
 const f=await fixture();t.after(()=>f.layer.dispose());
 const r=applyBatch(f.model,{ops:[{op:'place',def,name:'crafted-output',p:[8,4],r:.7}]},by,3);assert.equal(r.result.accepted,true,JSON.stringify(r.result));
 const child=structuredClone(f.model.get('crafted-output')!),expected=f.model.worldPose(child);assert.equal(child.by,by);f.model.delete(child.id);const before=plain(f.model,10);
 f.layer.applyEdge([{type:'edge',kind:'world-diff',seq:11,by:'engine',diff:{upserts:[child],removes:[],defs:[],tiles:[]}} as never]);
 const verify=()=>{const d=f.d(child.id)!;if(by==='engine'){assert.deepEqual(d.obj.position.toArray(),[expected.x,0,expected.z]);assert.equal(d.obj.scale.x,1);assert.ok(d.dur<.01);f.frame();assert.deepEqual(d.obj.position.toArray(),[expected.x,0,expected.z]);}else{assert.equal(d.obj.position.y,40);assert.ok(Math.abs(d.obj.scale.x-.2)<1e-12);assert.equal(d.dur,2.5);}};verify();
 f.model.delete(child.id);(f.inner as unknown as {unload(id:string):void}).unload(child.id);const next=plain(f.model,12);next.entities.push(child as never);await f.inner.applyDelta(diffSnapshots(before,next),new Set(),f.inner.signal);verify();
});
test('native ground output keeps existing construction refinement priority',async t=>{
 const f=await fixture();t.after(()=>f.layer.dispose());const child={id:'native-refinement',name:'native-refinement',def:'core/chair@2',in:{parent:'world'},p:[8,4],by:'engine',born:0,v:1} as Entity;
 (f.inner as unknown as {sites:{refinement(e:Entity,m:WorldModel):{scale:number;seconds:number}|null}}).sites.refinement=()=>({scale:.4,seconds:.7});
 f.layer.applyEdge([{type:'edge',kind:'world-diff',seq:11,by:'engine',diff:{upserts:[child],removes:[],defs:[],tiles:[]}} as never]);const d=f.d(child.id)!;assert.equal(d.obj.position.y,0);assert.equal(d.obj.scale.x,.4);assert.equal(d.dur,.7);
});

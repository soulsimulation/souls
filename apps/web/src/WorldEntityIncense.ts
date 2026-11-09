import * as THREE from 'three';
import {stableStringify, type Entity, type StoredDef, type WorldModel} from '@souls/world-compiler';
import type {IncenseContactRequest, IncenseContactResolver} from '../../../mars/viewer/app/engine-view/incense-contact-observation.ts';
import {prepareIncenseContact, placeIncenseContact, type PreparedIncenseContact} from './incense-contact-context.ts';

type Drawn = {obj: THREE.Object3D; settled?: boolean; removing?: boolean; inst?: string};
export type IncenseLiveSelection = {world: string; epoch: string; nativeNowTick: number; live: boolean; exact: boolean;
  takeId: string; observedTick: number; messages: readonly {kind?: string; seq?: unknown}[]};
type Candidate = {entity: Entity; prepared: PreparedIncenseContact; pose: ReturnType<WorldModel['worldPose']>;
  key: string; lineage: Set<string>; definitions: Set<string>; generation: number; ready: boolean; since: number | null};
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const stateOnly = (e: Entity) => stableStringify({...e, state: {}});
const neutral = (before: Entity, after: Entity) => stateOnly(before) === stateOnly(after) &&
  [before, after].every(e => Object.keys(e.state ?? {}).every(k => k === 'on') &&
    (e.state?.on === undefined || typeof e.state.on === 'boolean'));
const visible = (obj: THREE.Object3D) => {for (let p: THREE.Object3D | null = obj; p; p = p.parent) if (!p.visible) return false; return true;};
type Witness = {mesh: THREE.Mesh; geometry: THREE.BufferGeometry; position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  array: ArrayLike<number>; version: number; index: THREE.BufferAttribute | null; indexVersion: number | undefined};
type NodeWitness = {node: THREE.Object3D; parent: THREE.Object3D | null; children: THREE.Object3D[];
  trs: number[]; matrixAutoUpdate: boolean; canonical: THREE.Matrix4};
type GeometryWitness = {nodes: NodeWitness[]; meshes: Witness[]; ancestors: {node: THREE.Object3D; parent: THREE.Object3D | null}[]};
const WITNESS_LIMIT = 128;
const trsOf = (o: THREE.Object3D) => [...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()];
const canonicalOf = (o: THREE.Object3D) => new THREE.Matrix4().compose(o.position, o.quaternion, o.scale);
const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((v, i) => Number.isFinite(v) && v === b.elements[i]);

/** Target-only live geometry binding. Existing draw/diff/settle events maintain its small registry. */
export class WorldEntityIncense {
  private candidates = new Map<string, Candidate>();
  private prepared = new Map<string, PreparedIncenseContact | null>();
  private geometry = new WeakMap<THREE.Object3D, GeometryWitness | null>();
  private generation = 0;
  private resolverOwner = 0;
  private owner = '';
  private registration: {generation: number; tick: number} | null = null;
  private read: (() => IncenseLiveSelection | null) | null = null;
  private lastTick = -Infinity;
  reset() {this.candidates.clear(); this.prepared.clear(); this.geometry = new WeakMap(); this.registration = null;
    this.owner = ''; this.lastTick = -Infinity; this.generation++;}
  remove(id: string) {this.candidates.delete(id); this.generation++;}
  private observation(): IncenseLiveSelection | null {
    const q = this.read?.();
    if (!q || !q.live || !q.exact || !q.world || !q.epoch || !Number.isFinite(q.nativeNowTick) || q.nativeNowTick < 0) return null;
    const owner = JSON.stringify([q.world, q.epoch]);
    if (this.owner && this.owner !== owner || q.nativeNowTick < this.lastTick) {this.reset(); return null;}
    this.owner = owner; this.lastTick = q.nativeNowTick; return q;
  }
  resolver(read: () => IncenseLiveSelection | null,
    lookup: (request: IncenseContactRequest, selection: IncenseLiveSelection) => ReturnType<IncenseContactResolver>): IncenseContactResolver {
    this.read = read; const selected = this.observation();
    this.registration = selected ? {generation: this.generation, tick: selected.nativeNowTick} : null;
    const owner = ++this.resolverOwner;
    return request => {
      // An earlier people owner cannot revive after a reset or resolver replacement.
      if (this.read !== read || owner !== this.resolverOwner) return null;
      const selection = this.observation();
      return selection ? lookup(request, selection) : null;
    };
  }
  observe(model: WorldModel, e: Entity, d: StoredDef, drawn: Drawn | undefined) {
    if (!d.tags.includes('incense')) {this.remove(e.id); return;}
    const pose = model.worldPose(e), cacheKey = stableStringify([d.hash, e.params ?? {}, e.shape ?? null, pose.s]);
    let prepared = this.prepared.get(cacheKey);
    if (prepared === undefined) {prepared = prepareIncenseContact(d, e, model.bake(d, e.params ?? {}, e.seed ?? 0, e.shape).box, pose.s); this.prepared.set(cacheKey, prepared);}
    if (!prepared) {this.remove(e.id); return;}
    const ancestry = model.ancestors(e.id);
    if (ancestry.size > 128) {this.remove(e.id); return;}
    const lineage = new Set([e.id, ...ancestry]), definitions = new Set<string>();
    for (const id of lineage) {const parent = model.entities.get(id), def = parent && model.resolvedDef(parent.def); if (def) {definitions.add(def.hash); definitions.add(def.ref);}}
    const key = stableStringify([prepared.key, pose]), old = this.candidates.get(e.id), same = old?.key === key;
    const candidate: Candidate = {entity: e, prepared, pose, key, lineage, definitions,
      generation: same ? old.generation : ++this.generation, ready: same ? old.ready : false, since: same ? old.since : null};
    this.candidates.set(e.id, candidate);
    if(drawn)this.witness(drawn.obj); // capture the real builder's owned attributes before any later replacement
    if (drawn?.settled && !drawn.removing && drawn.obj.position.x === pose.x && drawn.obj.position.y === pose.y &&
      drawn.obj.position.z === pose.z && drawn.obj.rotation.y === pose.yaw && drawn.obj.scale.x === pose.s) this.ready(e.id);
  }
  ready(id: string) {
    const c = this.candidates.get(id); if (!c || c.ready) return;
    c.ready = true; c.generation = ++this.generation;
    const q = this.observation(); c.since = q?.nativeNowTick ?? null;
  }
  private affected(message: unknown, candidate: Candidate): boolean {
    const m = message as {ground?: unknown; defs?: {ref: string; hash: string}[];
      diff?: {upserts?: Entity[]; removes?: string[]; defs?: {ref: string; hash: string}[]; world?: unknown; constants?: unknown}};
    const d = m?.diff;
    if (!d || m.ground !== undefined || d.world !== undefined || d.constants !== undefined ||
      [d.upserts, d.removes, d.defs, m.defs].some(a => a !== undefined && !Array.isArray(a))) return true;
    if (d.removes?.some(id => candidate.lineage.has(id)) || [...(d.defs ?? []), ...(m.defs ?? [])].some(v => candidate.definitions.has(v.ref) || candidate.definitions.has(v.hash))) return true;
    return !!d.upserts?.some(e => candidate.lineage.has(e.id) && (e.id !== candidate.entity.id || !neutral(candidate.entity, e)));
  }
  invalidate(message: unknown) {for (const [id, c] of this.candidates) if (this.affected(message, c)) this.remove(id);}
  private witness(obj: THREE.Object3D, pose?: ReturnType<WorldModel['worldPose']>): boolean {
    let refs = this.geometry.get(obj);
    if (refs === undefined) {
      refs = {nodes: [], meshes: [], ancestors: []};
      const pending = [obj];
      while (pending.length && refs) {
        const node = pending.pop()!;
        if (refs.nodes.length >= WITNESS_LIMIT || node.children.length > WITNESS_LIMIT) {refs = null; break;}
        refs.nodes.push({node, parent: node.parent, children: [...node.children], trs: trsOf(node), matrixAutoUpdate: node.matrixAutoUpdate, canonical: canonicalOf(node)});
        pending.push(...node.children);
        const mesh = node as THREE.Mesh; if (!mesh.isMesh || mesh.name === 'shadow-proxy' || mesh.userData.shadowProxy) continue;
        const p = mesh.geometry?.isBufferGeometry?mesh.geometry.getAttribute('position'):undefined;
        if (!p || p.itemSize !== 3 || mesh instanceof THREE.InstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) {refs = null; break;}
        const storage = p instanceof THREE.InterleavedBufferAttribute ? p.data : p;
        refs.meshes.push({mesh, geometry: mesh.geometry, position: p, array: storage.array, version: storage.version,
          index: mesh.geometry.index, indexVersion: mesh.geometry.index?.version});
      }
      for (let node = obj.parent; node && refs; node = node.parent) {
        if (refs.ancestors.length >= WITNESS_LIMIT) {refs = null; break;}
        refs.ancestors.push({node, parent: node.parent});
      }
      if (!refs?.meshes.length) refs = null;
      this.geometry.set(obj, refs);
    }
    if (!refs) return false;
    const reject = () => {this.geometry.set(obj, null); return false;};
    for (const r of refs.nodes) {
      const o = r.node, trs = trsOf(o), canonical = canonicalOf(o);
      if (o.parent !== r.parent || o.children.length !== r.children.length || o.children.some((c, i) => c !== r.children[i]) ||
        !o.matrixWorldAutoUpdate || !o.matrixWorld.elements.every(Number.isFinite) || !trs.every(Number.isFinite) || !canonical.elements.every(Number.isFinite) ||
        o !== obj && (trs.some((v, i) => v !== r.trs[i]) || !sameMatrix(canonical, r.canonical)) ||
        !o.matrixAutoUpdate && !sameMatrix(o.matrix, o === obj ? canonical : r.canonical)) return reject();
      // freeze/thaw may change matrixAutoUpdate with identical geometry. Its manual matrix must be exactly canonical.
    }
    if (!refs.meshes.every(r => {const storage = r.position instanceof THREE.InterleavedBufferAttribute ? r.position.data : r.position;
      return r.mesh.geometry === r.geometry && r.geometry.getAttribute('position') === r.position && storage.array === r.array && storage.version === r.version &&
        r.geometry.index === r.index && r.index?.version === r.indexVersion;})) return reject();
    if (pose) {
      // people.show precedes the layer update and render: cached matrixWorld may still describe the prior frame.
      // Recompose only this cached ancestry, without updating the scene or trusting those cached world matrices.
      const world = new THREE.Matrix4();
      for (let i = refs.ancestors.length - 1; i >= 0; i--) {
        const r = refs.ancestors[i], o = r.node;
        if (o.parent !== r.parent || !o.matrixWorldAutoUpdate || !o.matrixWorld.elements.every(Number.isFinite) || !trsOf(o).every(Number.isFinite)) return reject();
        const canonical = canonicalOf(o), local = o.matrixAutoUpdate ? canonical : o.matrix;
        if (!o.matrixAutoUpdate && !sameMatrix(local, canonical)) return reject();
        if (!local.elements.every(Number.isFinite)) return reject();
        world.multiply(local);
      }
      world.multiply(obj.matrixAutoUpdate ? canonicalOf(obj) : obj.matrix);
      const expected = new THREE.Matrix4().compose(new THREE.Vector3(pose.x, pose.y, pose.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pose.yaw, 0)), new THREE.Vector3(pose.s, pose.s, pose.s));
      if (!sameMatrix(world, expected)) return reject();
    }
    return true;
  }
  contact(q: IncenseContactRequest, selection: IncenseLiveSelection, model: WorldModel,
    drawn: ReadonlyMap<string, Drawn>, seq: number) {
    if (q.targetTracked || selection.takeId !== q.take.id || Math.abs(selection.observedTick-q.observedTick)>1e-9 ||
      !Number.isFinite(q.motion.startTick) || q.motion.startTick > q.observedTick || q.take.dt !== .05) return null;
    if(!this.candidates.has(q.motion.target)){
      // A resync or unload cannot certify the past. A target-only fresh observation may certify a later episode.
      const entity=model.entities.get(q.motion.target),def=entity&&model.resolvedDef(entity.def);
      if(entity&&def)this.observe(model,entity,def,drawn.get(entity.id));
    }
    const c = this.candidates.get(q.motion.target), d = drawn.get(q.motion.target), native = q.nativeTarget;
    if (!c || !d || !c.ready || !d.settled || d.removing || d.inst || !visible(d.obj) || !native || native.kind !== 'fixture' ||
      !native.tags?.includes('entity-world') || native.def !== c.prepared.nativeDef) return null;
    let through = seq;
    for (const message of selection.messages) {
      if (message.kind !== 'world-diff') continue;
      if (typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq)) return null;
      if (message.seq <= through) continue;
      if (message.seq !== through + 1 || this.affected(message, c)) return null;
      through = message.seq;
    }
    const since = c.since ?? (this.registration && c.generation <= this.registration.generation ? this.registration.tick : null);
    if (since === null || since > q.motion.startTick) return null;
    const e = model.entities.get(q.motion.target), def = e && model.resolvedDef(e.def);
    if (!e || !def || def.hash !== c.prepared.revision || !neutral(c.entity, e)) return null;
    const p = c.pose;
    if (native.pose.p.length!==3||!native.pose.p.every((v, i) => Number.isFinite(v)&&v === r3([p.x, p.y, p.z][i])) || native.pose.yaw !== r3(-p.yaw) || native.pose.pitch || native.pose.roll) return null;
    if (d.obj.position.x !== p.x || d.obj.position.y !== p.y || d.obj.position.z !== p.z || d.obj.rotation.y !== p.yaw ||
      d.obj.rotation.x !== 0 || d.obj.rotation.z !== 0 || [d.obj.scale.x, d.obj.scale.y, d.obj.scale.z].some(s => s !== p.s) || !this.witness(d.obj, p)) return null;
    const context = placeIncenseContact(c.prepared, e.id, p);
    if (!context || q.motion.at.length !== 3 || q.motion.at.some((v, i) => Math.abs(v - context.tip[i]) > 1e-12)) return null;
    return Object.freeze({...context, tip: Object.freeze([...context.tip]) as typeof context.tip,
      centre: Object.freeze([...context.centre]) as typeof context.centre});
  }
}

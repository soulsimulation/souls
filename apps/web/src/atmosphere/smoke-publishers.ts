import * as THREE from 'three';

export type SmokeSource = { p: THREE.Vector3; scale: number };
const CHIMNEY = /chimney|stove-?pipe|flue|smoke-?stack/i;
type Change = { subtree: THREE.Object3D; added: boolean };
const listeners = new WeakMap<THREE.Scene, Set<(change: Change) => void>>();
const sceneOf = (node: THREE.Object3D): THREE.Scene | null => { for (let p: THREE.Object3D | null = node; p; p = p.parent) if ((p as THREE.Scene).isScene) return p as THREE.Scene; return null; };
const publisher = (node: THREE.Object3D) => Array.isArray(node.userData.edenSmokeSources) || (node as THREE.Mesh).isMesh && CHIMNEY.test(node.name);
const EMPTY: SmokeSource[] = [];

/** The same authored metadata and legacy chimney geometry used by the periodic finder. */
export function readSmokeSources(node: THREE.Object3D): SmokeSource[] {
  if (!publisher(node)) return EMPTY;
  const out: SmokeSource[] = [], src = node.userData.edenSmokeSources;
  if (Array.isArray(src)) for (const s of src) if (Array.isArray(s) && s.length >= 3 && s.slice(0, 3).every(Number.isFinite)) out.push({ p: new THREE.Vector3(s[0], s[1], s[2]).applyMatrix4(node.matrixWorld), scale: Number.isFinite(s[3]) ? s[3] : 1 });
  if ((node as THREE.Mesh).isMesh && CHIMNEY.test(node.name)) {
    const mesh = node as THREE.Mesh; if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox!.clone().applyMatrix4(node.matrixWorld);
    out.push({ p: new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + .1, (b.min.z + b.max.z) / 2), scale: Math.min(1.2, Math.max(.4, (b.max.x - b.min.x) * 1.6)) });
  }
  return out;
}

/** Entity redraws already add/remove one subtree. Publish those events without scanning the scene. */
export function watchEntitySmoke(owner: THREE.Object3D, contents: THREE.Object3D): () => void {
  let lastScene = sceneOf(owner);
  const send = (subtree: THREE.Object3D, added: boolean) => {
    const scene = sceneOf(owner) ?? lastScene; if (scene) listeners.get(scene)?.forEach(fn => fn({ subtree, added }));
    if (added) lastScene = scene;
  };
  const add = (event: { child: THREE.Object3D }) => send(event.child, true), remove = (event: { child: THREE.Object3D }) => send(event.child, false);
  const attach = () => send(contents, true), detach = () => { send(contents, false); lastScene = null; };
  contents.addEventListener('childadded', add); contents.addEventListener('childremoved', remove);
  owner.addEventListener('added', attach); owner.addEventListener('removed', detach);
  return () => { contents.removeEventListener('childadded', add); contents.removeEventListener('childremoved', remove); owner.removeEventListener('added', attach); owner.removeEventListener('removed', detach); };
}

type Published = { list: unknown; matrix: THREE.Matrix4; sources: SmokeSource[]; visible: boolean };
/** Known smoke publishers only: changes visit their subtrees; unchanged frames never walk the scene. */
export class SmokePublishers {
  private scene: THREE.Scene;
  private publish: (sources: SmokeSource[]) => void;
  private nodes = new Map<THREE.Object3D, Published>();
  private pending = new Map<THREE.Object3D, boolean>();
  private dirty = false;
  updates = 0;
  private changed = ({ subtree, added }: Change) => { this.pending.set(subtree, added); };
  constructor(scene: THREE.Scene, publish: (sources: SmokeSource[]) => void) {
    this.scene = scene; this.publish = publish;
    let set = listeners.get(scene); if (!set) listeners.set(scene, set = new Set()); set.add(this.changed);
  }
  /** Collect during the finder's existing periodic traversal, without a second walk. */
  beginScan() {
    // The finder skips hidden descendants. Retain known hidden publishers so uncovering them can refresh immediately.
    for (const node of this.nodes.keys()) if (this.visibility(node) !== 1) this.nodes.delete(node);
    // Keep queued redraws: the finder cannot discover new publishers inside hidden subtrees.
    this.dirty = true;
  }
  capture = (node: THREE.Object3D, sources: SmokeSource[]) => {
    if (!publisher(node)) return;
    this.nodes.set(node, { list: node.userData.edenSmokeSources, matrix: node.matrixWorld.clone(), sources, visible: true }); this.dirty = true;
  };
  private visibility(node: THREE.Object3D): 0 | 1 | 2 {
    let visible = true;
    for (let p: THREE.Object3D | null = node; p; p = p.parent) { if (p === this.scene) return visible ? 2 : 1; if (!p.visible && p.parent !== this.scene) visible = false; }
    return 0;
  }
  update() {
    for (const [subtree, added] of this.pending) {
      if (added) subtree.traverse(node => { if (publisher(node)) { node.updateWorldMatrix(true, false); this.capture(node, readSmokeSources(node)); } });
      else for (const node of this.nodes.keys()) for (let p: THREE.Object3D | null = node; p; p = p.parent) if (p === subtree) { this.nodes.delete(node); this.dirty = true; break; }
    }
    this.pending.clear();
    for (const [node, cached] of this.nodes) {
      const visible = this.visibility(node);
      if (!visible) { this.nodes.delete(node); this.dirty = true; continue; }
      if (visible === 1) { if (cached.visible) { cached.sources = []; cached.visible = false; this.dirty = true; } continue; }
      node.updateWorldMatrix(true, false);
      if (!cached.visible || cached.list !== node.userData.edenSmokeSources || !cached.matrix.equals(node.matrixWorld)) {
        cached.visible = true; cached.list = node.userData.edenSmokeSources; cached.matrix.copy(node.matrixWorld); cached.sources = readSmokeSources(node); this.dirty = true;
      }
    }
    if (this.dirty) { this.publish([...this.nodes.values()].flatMap(p => p.sources)); this.dirty = false; this.updates++; }
  }
  dispose() { listeners.get(this.scene)?.delete(this.changed); this.nodes.clear(); this.pending.clear(); }
}

// What the effects need of a baked model (0.131 parity C8, #3679), read from its binary glTF without building any
// geometry. V17's bake keeps two things for them: each flame part's clusters (`extras.flames` on the `role:flame`
// pivot, as today's kit builder records them: `[x, y, z]` base, radius and height, the pivot's frame) and the water
// surfaces (the `kit:water` part, whose discs a fountain's water falls between). All in the model's own frame, the
// frame the thing layer draws the model in.
import * as THREE from 'three';
import type { Disc } from './water-jets.ts';

export type FlameCluster = { p: [number, number, number]; r: number; h: number };
/** A flame part: its pivot's matrix in the model's frame and the fires on it. */
export type FlamePart = { matrix: THREE.Matrix4; clusters: FlameCluster[] };
export type ModelFx = { flames: FlamePart[]; discs: Disc[]; top: number };

type Node = { name?: string; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; mesh?: number; extras?: { role?: string; flames?: FlameCluster[] } };
type Accessor = { bufferView?: number; byteOffset?: number; count: number; componentType: number; type: string; min?: number[]; max?: number[] };
type Gltf = { nodes?: Node[]; scenes?: { nodes?: number[] }[]; scene?: number; meshes?: { primitives: { attributes: Record<string, number>; material?: number }[] }[]; materials?: { name?: string }[]; accessors?: Accessor[]; bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[] };

/** The JSON and binary chunks of a binary glTF (a bake's prefix before the `glTF` magic is skipped). */
export function glbChunks(bytes: ArrayBuffer): { json: Gltf; bin: DataView | null } {
  const u8 = new Uint8Array(bytes);
  let at = -1;
  for (let i = 0; i + 4 <= Math.min(u8.length, 256); i++) if (u8[i] === 0x67 && u8[i + 1] === 0x6c && u8[i + 2] === 0x54 && u8[i + 3] === 0x46) { at = i; break; }
  if (at < 0) throw new Error('not a binary glTF');
  const dv = new DataView(bytes, at);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, at + 20, jsonLen))) as Gltf;
  const binAt = 20 + jsonLen;
  const bin = binAt + 8 <= dv.byteLength && dv.getUint32(binAt + 4, true) === 0x004e4942 ? new DataView(bytes, at + binAt + 8, dv.getUint32(binAt, true)) : null;
  return { json, bin };
}

const local = (n: Node) => n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(
  new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
  new THREE.Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
  new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])));

/** The effects' data of a model: its flame parts, its water discs (grouped by height: a disc's top and bottom faces are
 *  one disc) and the height of its top. */
export function modelFx(bytes: ArrayBuffer): ModelFx {
  const { json, bin } = glbChunks(bytes);
  const nodes = json.nodes ?? [], out: ModelFx = { flames: [], discs: [], top: -Infinity };
  const water: THREE.Vector3[] = [], v = new THREE.Vector3();
  const visit = (i: number, parent: THREE.Matrix4) => {
    const n = nodes[i]; if (!n) return;
    const m = parent.clone().multiply(local(n));
    if (Array.isArray(n.extras?.flames) && n.extras.flames.length) out.flames.push({ matrix: m, clusters: n.extras.flames.map((c) => ({ p: [c.p[0], c.p[1], c.p[2]], r: c.r, h: c.h })) });
    const mesh = n.mesh !== undefined ? json.meshes?.[n.mesh] : undefined;
    for (const prim of mesh?.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes.POSITION];
      if (!acc) continue;
      if (acc.min && acc.max) for (let k = 0; k < 8; k++) {
        v.set(k & 1 ? acc.max[0] : acc.min[0], k & 2 ? acc.max[1] : acc.min[1], k & 4 ? acc.max[2] : acc.min[2]).applyMatrix4(m);
        out.top = Math.max(out.top, v.y);
      }
      const isWater = /water/.test(n.name ?? '') || /water/.test(json.materials?.[prim.material ?? -1]?.name ?? '');
      const view = acc.bufferView !== undefined ? json.bufferViews?.[acc.bufferView] : undefined;
      if (!isWater || !bin || !view || acc.componentType !== 5126 || acc.type !== 'VEC3') continue;
      const stride = view.byteStride ?? 12, base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      for (let k = 0; k < acc.count; k++) {
        const o = base + k * stride;
        water.push(new THREE.Vector3(bin.getFloat32(o, true), bin.getFloat32(o + 4, true), bin.getFloat32(o + 8, true)).applyMatrix4(m));
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const r of scene?.nodes ?? []) visit(r, new THREE.Matrix4());
  out.discs = discsOf(water);
  if (!Number.isFinite(out.top)) out.top = 0;
  return out;
}

/** Water surfaces from their vertices: points within 8 cm of height are one disc, at its highest point, centred on its
 *  box, as wide as its farthest point. */
export function discsOf(points: readonly THREE.Vector3[]): Disc[] {
  const sorted = [...points].sort((a, b) => a.y - b.y), groups: THREE.Vector3[][] = [];
  for (const p of sorted) {
    const g = groups.at(-1);
    if (g && p.y - g.at(-1)!.y < 0.08) g.push(p); else groups.push([p]);
  }
  return groups.filter((g) => g.length >= 3).map((g) => {
    const box = new THREE.Box3().setFromPoints(g), c = box.getCenter(new THREE.Vector3());
    const r = Math.max(...g.map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
    return { x: c.x, y: box.max.y, z: c.z, r };
  });
}

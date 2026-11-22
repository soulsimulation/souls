// A core/humanoid@2 look as one of the crowd's models (#3998). The composition is today's
// (apps/web/src/humanoid/compose.ts: the frame's shared rig, the look's kit parts merged into head, top, bottom and shoes,
// props and layers, build and shape, head size), ported unchanged in what it draws because the page imports nothing from
// apps/. Change both together. Where today's app hands the composed scene to people.ts as a template, this bakes it into
// the crowd (`../bake.ts`) like any other body: one model per distinct look, its geometry and clips baked once.
// Every kit file is checked against kit.json's sha256 before it is parsed; kit.json is checked against `kitHash` when given.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { bakeModel, type BakedModel } from '../bake.ts';
import { calfMissing, calfSkin } from './calves.ts';
import { HEADGEAR_FACES, SHAPE_KEYS, lookKey, paletteOf, resolveLook, type Look, type Slot } from './look.ts';
import { humanoidMaterial } from './material.ts';
import { hatPieces, glassesPieces, bagPieces, skinned, facialHairLayers, mustachePieces, maskLayer, scarfWrap, scarfEndPieces, gloveLayer, earringPieces, necklacePieces, type HeadFit } from './props.ts';

type Landmarks = { min: number[]; max: number[]; cz?: number; rx?: number; rz?: number; top?: number; eye?: [number, number, number]; eyeX?: number; templeX?: number; back?: number; front?: number };
type FileEntry = { file: string; bytes: number; sha256: string };
type PartEntry = { files: Record<string, FileEntry>; landmarks: Record<string, Landmarks> };
export type KitManifest = { contract: 'humanoid-kit/1'; version: number; slots: string[];
  frames: Record<string, FileEntry & { rig: string; joints: Record<string, [number, number, number]>; index: { head: number; chest: number; hips: number; torso: number } }>;
  parts: Record<string, Record<string, PartEntry>>; presets: Record<string, { palette: Partial<Record<Slot, number[]>> }> };
type Rig = { root: THREE.Object3D; ib: THREE.Matrix4[]; clips: THREE.AnimationClip[]; names: string[]; joints: THREE.Vector3[]; ends: (THREE.Vector3 | null)[] };
/** Reads a kit file's bytes. */
export type KitReader = (url: string) => Promise<ArrayBuffer>;

const HIDE_UNDER_HAT = 1;
const COVERED_FACES = new Set(['spacesuit', 'swat']);
const HAND_BONE = /^(Wrist|Thumb|Index|Middle|Ring|Pinky)\d?[LR]$/;
const earrings = (look: Look) => look.jewellery === 'earrings' || look.jewellery === 'both';
const necklace = (look: Look) => look.jewellery === 'necklace' || look.jewellery === 'both';
/** The body model's shoulder height for a 1.75 m person (mars/viewer/app/engine-view/rig.ts BODY_MODEL). */
const SHOULDER_HEIGHT = 1.34, PERSON_HEIGHT = 1.75;

/** Merge kit-format geometries (position f32, normal i8n, skinIndex u8, skinWeight u8n, hinfo u8) into one. */
export function mergeParts(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const n = geos.reduce((a, g) => a + g.attributes.position.count, 0), idx = geos.reduce((a, g) => a + (g.index ? g.index.count : 0), 0);
  const out = new THREE.BufferGeometry();
  const spec = { position: [Float32Array, 3, false], normal: [Int8Array, 3, true], skinIndex: [Uint8Array, 4, false], skinWeight: [Uint8Array, 4, true], hinfo: [Uint8Array, 4, false] } as const;
  const attrs = Object.fromEntries(Object.entries(spec).map(([k, [T, size, norm]]) => [k, new THREE.BufferAttribute(new T(n * size), size, norm)])) as Record<keyof typeof spec, THREE.BufferAttribute>;
  const index = new (n < 65536 ? Uint16Array : Uint32Array)(idx);
  let v = 0, t = 0;
  for (const g of geos) {
    const c = g.attributes.position.count;
    for (const [k, a] of Object.entries(attrs)) {
      const src = g.getAttribute(k); if (!src) throw Error('kit geometry lacks ' + k);
      for (let i = 0; i < c; i++) for (let j = 0; j < a.itemSize; j++) a.setComponent(v + i, j, src.getComponent(i, j));
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index[t++] = g.index.getX(i) + v;
    v += c;
  }
  for (const [k, a] of Object.entries(attrs)) out.setAttribute(k, a);
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}
/** Copy without the triangles whose vertices are flagged (e.g. a mohawk's spike under a hat). */
function withoutFlag(g: THREE.BufferGeometry, flag: number): THREE.BufferGeometry {
  const info = g.getAttribute('hinfo'), keep: number[] = [], I = g.index!;
  for (let i = 0; i < I.count; i += 3) { const a = I.getX(i), b = I.getX(i + 1), c = I.getX(i + 2); if (!((info.getW(a) | info.getW(b) | info.getW(c)) & flag)) keep.push(a, b, c); }
  const out = g.clone(); out.setIndex(keep); return out;
}
const GIRTH: Record<string, [number, 'trunk' | 'limb']> = {
  Hips: [1, 'trunk'], Abdomen: [1, 'trunk'], Torso: [1, 'trunk'], Chest: [1, 'trunk'], Neck: [0.45, 'trunk'], ShoulderL: [0.7, 'trunk'], ShoulderR: [0.7, 'trunk'],
  UpperArmL: [0.85, 'limb'], UpperArmR: [0.85, 'limb'], LowerArmL: [0.55, 'limb'], LowerArmR: [0.55, 'limb'],
  UpperLegL: [1, 'limb'], UpperLegR: [1, 'limb'], LowerLegL: [0.7, 'limb'], LowerLegR: [0.7, 'limb'],
};
/** A copy of `g` widened (build > 1) or slimmed (build < 1) by the GIRTH table in the rig's rest (bind) space. */
export function withGirth(g: THREE.BufferGeometry, build: number, rig: Pick<Rig, 'names' | 'joints' | 'ends'>): THREE.BufferGeometry {
  if (build === 1) return g;
  const out = g.clone(), P = out.attributes.position, J = out.attributes.skinIndex, W = out.attributes.skinWeight, k = build - 1;
  const spec = rig.names.map((n, i) => { const e = GIRTH[n]; if (!e) return null; const end = rig.ends[i]; const dir = e[1] === 'limb' && end ? end.clone().sub(rig.joints[i]).normalize() : null; return { g: e[0], at: rig.joints[i], dir }; });
  const p = new THREE.Vector3(), d = new THREE.Vector3(), off = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    p.fromBufferAttribute(P, i); d.set(0, 0, 0);
    for (let c = 0; c < 4; c++) {
      const w = W.getComponent(i, c), s = w > 0 ? spec[J.getComponent(i, c)] : null; if (!s) continue;
      off.subVectors(p, s.at);
      if (s.dir) off.addScaledVector(s.dir, -off.dot(s.dir)); else off.y = 0;
      d.addScaledVector(off, w * s.g);
    }
    P.setXYZ(i, p.x + k * d.x, p.y + k * d.y, p.z + k * d.z);
  }
  return out;
}
const SHAPE: Record<'chest' | 'hips' | 'weight', Record<string, [number, 'trunk' | 'limb' | 'belly']>> = {
  chest: { Chest: [1.7, 'trunk'], Torso: [1.1, 'trunk'], ShoulderL: [0.6, 'trunk'], ShoulderR: [0.6, 'trunk'], Abdomen: [0.35, 'trunk'] },
  hips: { Hips: [1.5, 'trunk'], Body: [1.3, 'trunk'], Abdomen: [1.2, 'trunk'], Torso: [0.4, 'trunk'], UpperLegL: [1.3, 'limb'], UpperLegR: [1.3, 'limb'], LowerLegL: [0.3, 'limb'], LowerLegR: [0.3, 'limb'] },
  weight: { Abdomen: [1.2, 'belly'], Body: [0.8, 'belly'], Torso: [0.7, 'belly'], Hips: [0.7, 'belly'], Chest: [0.35, 'trunk'], Neck: [0.3, 'trunk'], UpperArmL: [0.6, 'limb'], UpperArmR: [0.6, 'limb'], LowerArmL: [0.3, 'limb'], LowerArmR: [0.3, 'limb'], UpperLegL: [0.7, 'limb'], UpperLegR: [0.7, 'limb'], LowerLegL: [0.35, 'limb'], LowerLegR: [0.35, 'limb'] },
};
const ARM_CHAIN = /^(Shoulder|UpperArm|LowerArm|Wrist|Thumb\d|Index\d|Middle\d|Ring\d|Pinky\d)([LR])$/;
const SHOULDER_SHIFT = 0.3;
/** Looks v2 body shape (shoulders, chest, hips, weight) per bone in bind space, blended by skin weight. */
export function withShape(g: THREE.BufferGeometry, look: Pick<Look, 'shoulders' | 'chest' | 'hips' | 'weight'>, rig: Pick<Rig, 'names' | 'joints' | 'ends'>): THREE.BufferGeometry {
  if (look.shoulders === 1 && look.chest === 1 && look.hips === 1 && look.weight === 1) return g;
  const out = g.clone(), P = out.attributes.position, J = out.attributes.skinIndex, W = out.attributes.skinWeight;
  const specs = (['chest', 'hips', 'weight'] as const).filter((k) => look[k] !== 1).map((k) => ({ k: look[k] - 1, bones: rig.names.map((n, i) => { const e = SHAPE[k][n]; if (!e) return null; const end = rig.ends[i]; return { g: e[0], mode: e[1], at: rig.joints[i], dir: e[1] === 'limb' && end ? end.clone().sub(rig.joints[i]).normalize() : null }; }) }));
  const arm = rig.names.map((n) => { const m = n.match(ARM_CHAIN); return m ? { side: m[2] === 'L' ? 1 : -1, w: m[1] === 'Shoulder' ? 0.5 : 1 } : null; }), dx = (look.shoulders - 1) * SHOULDER_SHIFT;
  const legs = (['L', 'R'] as const).map((sd) => ({ side: sd === 'L' ? 1 : -1, up: rig.names.indexOf('UpperLeg' + sd), hip: rig.joints[rig.names.indexOf('UpperLeg' + sd)]?.y ?? 0.9, knee: rig.joints[rig.names.indexOf('LowerLeg' + sd)]?.y ?? 0.5 })), hx = (look.hips - 1) * 0.22;
  const p = new THREE.Vector3(), d = new THREE.Vector3(), off = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    p.fromBufferAttribute(P, i); d.set(0, 0, 0);
    if (hx) for (const l of legs) for (let c = 0; c < 4; c++) if (J.getComponent(i, c) === l.up) { const t = p.y > l.hip ? Math.max(0, 1 - (p.y - l.hip) / 0.1) : Math.min(1, Math.max(0, (p.y - l.knee) / (l.hip - l.knee))); d.x += l.side * W.getComponent(i, c) * hx * t; }
    for (const s of specs) for (let c = 0; c < 4; c++) {
      const w = W.getComponent(i, c), b = w > 0 ? s.bones[J.getComponent(i, c)] : null; if (!b) continue;
      off.subVectors(p, b.at);
      if (b.dir) off.addScaledVector(b.dir, -off.dot(b.dir)); else off.y = 0;
      if (b.mode === 'belly') off.z *= off.z > 0 ? 2.2 : 0.5;
      d.addScaledVector(off, w * b.g * s.k);
    }
    if (dx) for (let c = 0; c < 4; c++) { const w = W.getComponent(i, c), a = w > 0 ? arm[J.getComponent(i, c)] : null; if (a) d.x += a.side * a.w * w * dx; }
    P.setXYZ(i, p.x + d.x, p.y + d.y, p.z + d.z);
  }
  return out;
}
/** Scale the head about its joint, per vertex by its Head-bone weight. */
function scaleHead(g: THREE.BufferGeometry, s: number, joint: [number, number, number], head: number) {
  if (s === 1) return g;
  const P = g.attributes.position, J = g.attributes.skinIndex, W = g.attributes.skinWeight;
  for (let i = 0; i < P.count; i++) {
    let w = 0; for (let k = 0; k < 4; k++) if (J.getComponent(i, k) === head) w += W.getComponent(i, k);
    if (!w) continue; const f = 1 + w * (s - 1);
    P.setXYZ(i, joint[0] + (P.getX(i) - joint[0]) * f, joint[1] + (P.getY(i) - joint[1]) * f, joint[2] + (P.getZ(i) - joint[2]) * f);
  }
  return g;
}
/** The kit's per-vertex info as the crowd's `color`: [palette slot, finish role, roughness 0..1]. */
export function infoColor(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const info = g.getAttribute('hinfo') as THREE.BufferAttribute, raw = info.array as Uint8Array, n = info.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = raw[i * 4]; c[i * 3 + 1] = raw[i * 4 + 1]; c[i * 3 + 2] = raw[i * 4 + 2] / 255; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

const headKey = (look: Look) => ['head', look.frame, look.face, look.hair, look.hat, look.glasses, look.headSize, look.facialHair, look.mask, look.scarf, earrings(look)];
const topKey = (look: Look) => ['top', look.frame, look.top, look.bag, look.gloves, look.scarf, necklace(look)];
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256', bytes));

/** One kit per base URL: caches its rigs, parts, merged geometry and baked looks. */
export class HumanoidKit {
  readonly base: string;
  private read: KitReader;
  private kitHash?: string;
  private loader = new GLTFLoader();
  private manifestP?: Promise<KitManifest>;
  private rigs = new Map<string, Promise<Rig>>(); private parts = new Map<string, Promise<THREE.BufferGeometry>>();
  private merged = new Map<string, Promise<THREE.BufferGeometry>>(); private baked = new Map<string, Promise<BakedModel>>();

  constructor(base: string, options: { read?: KitReader; kitHash?: string } = {}) {
    this.base = base; this.kitHash = options.kitHash;
    this.read = options.read ?? (async (url) => { const r = await fetch(url); if (!r.ok) throw new Error('body.humanoid-kit-unavailable'); return r.arrayBuffer(); });
  }
  private cache<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let p = map.get(key);
    if (!p) { p = load(); map.set(key, p); p.catch(() => { if (map.get(key) === p) map.delete(key); }); }
    return p;
  }
  /** A kit file, its bytes checked against the manifest. */
  private async file(entry: FileEntry | { file: string; sha256: string }): Promise<ArrayBuffer> {
    if (!/^(parts\/)?[a-z0-9-]+(\.[a-z]+)?\.glb$/.test(entry.file)) throw new Error('body.humanoid-kit-path');
    const bytes = await this.read(this.base + entry.file);
    if (await sha256(bytes) !== entry.sha256) throw new Error('body.humanoid-kit-hash');
    return bytes;
  }
  manifest(): Promise<KitManifest> {
    return this.manifestP ??= (async () => {
      const bytes = await this.read(this.base + 'kit.json');
      if (this.kitHash && await sha256(bytes) !== this.kitHash) throw new Error('body.humanoid-kit-hash');
      const m = JSON.parse(new TextDecoder().decode(bytes)) as KitManifest;
      if (m.contract !== 'humanoid-kit/1') throw new Error('body.humanoid-kit-contract');
      return m;
    })();
  }
  rig(frame: string): Promise<Rig> {
    return this.cache(this.rigs, frame, async () => {
      const m = await this.manifest(), f = m.frames[frame]; if (!f) throw new Error('body.humanoid-frame');
      const gltf = await this.loader.parseAsync(await this.file({ file: f.rig, sha256: f.sha256 }), '');
      const bin = await gltf.parser.getDependency('buffer', 0) as ArrayBuffer;
      let binder: THREE.SkinnedMesh | undefined; gltf.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) binder = o as THREE.SkinnedMesh; });
      if (!binder) throw new Error('body.humanoid-rig');
      const bones = binder.skeleton.bones.map((b) => b.name), PROP = ['position', 'quaternion', 'scale'];
      const table = (gltf.userData as { humanoid?: { clips?: [string, number, number[][]][] } }).humanoid?.clips ?? [];
      const clips = table.map(([name, , channels]) => new THREE.AnimationClip(name, -1, channels.map(([bone, path, interp, tOff, n, vOff]) => {
        const times = new Float32Array(bin.slice(tOff, tOff + 4 * n)), track = bones[bone] + '.' + PROP[path], mode = interp ? THREE.InterpolateLinear : THREE.InterpolateDiscrete;
        if (path === 1) { const q = new Int16Array(bin, vOff, 4 * n); return new THREE.QuaternionKeyframeTrack(track, times, Float32Array.from(q, (x) => Math.max(x / 32767, -1)), mode); }
        return new THREE.VectorKeyframeTrack(track, times, new Float32Array(bin.slice(vOff, vOff + 12 * n)), mode);
      })));
      const root = gltf.scene.getObjectByName('CharacterArmature'); if (!root) throw new Error('body.humanoid-rig');
      gltf.scene.updateMatrixWorld(true);
      const sk = binder.skeleton.bones, joints = sk.map((b) => b.getWorldPosition(new THREE.Vector3()));
      const ends = sk.map((b) => { const c = b.children.find((o) => (o as THREE.Bone).isBone && sk.includes(o as THREE.Bone)); return c ? c.getWorldPosition(new THREE.Vector3()) : null; });
      return { root, ib: binder.skeleton.boneInverses, clips, names: bones, joints, ends };
    });
  }
  part(slot: string, id: string, frame: string): Promise<THREE.BufferGeometry> {
    return this.cache(this.parts, `${slot}-${id}.${frame}`, async () => {
      const m = await this.manifest(), e = m.parts[slot]?.[id]; if (!e?.files[frame]) throw new Error('body.humanoid-part');
      const gltf = await this.loader.parseAsync(await this.file(e.files[frame]), '');
      let geo: THREE.BufferGeometry | undefined; gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) geo = (o as THREE.Mesh).geometry; });
      if (!geo) throw new Error('body.humanoid-part');
      const info = geo.getAttribute('_hinfo'); if (info) { geo.setAttribute('hinfo', info); geo.deleteAttribute('_hinfo'); }
      return geo;
    });
  }
  private head(look: Look): Promise<THREE.BufferGeometry> {
    return this.cache(this.merged, headKey(look).join(':'), async () => {
      const m = await this.manifest(), fr = m.frames[look.frame], face = await this.part('face', look.face, look.frame);
      const hair = look.hair === 'bald' ? null : await this.part('hair', look.hair, look.frame);
      const lf = m.parts.face[look.face].landmarks[look.frame], lh = hair ? m.parts.hair[look.hair].landmarks[look.frame] : null;
      const fit: HeadFit = { cz: (lh ?? lf).cz!, rx: Math.max(lf.rx!, lh?.rx ?? 0), rz: Math.max(lf.rz!, lh?.rz ?? 0), top: Math.max(lf.top!, lh?.top ?? 0), eye: lf.eye!, eyeX: lf.eyeX!, templeX: lf.templeX ?? lf.rx! };
      const gear = HEADGEAR_FACES.has(look.face);
      const pieces = gear ? [] : [...hatPieces(look.hat as Look['hat'], fit, fr.index.head), ...(lf.eye ? glassesPieces(look.glasses as Look['glasses'], fit, fr.index.head) : [])].map(skinned);
      const layers: THREE.BufferGeometry[] = [], covered = COVERED_FACES.has(look.face) || !lf.eye;
      if (!covered) layers.push(...facialHairLayers(look.facialHair, face, fit, fr.index.head));
      if (!covered && look.mask !== 'none') { const mk = maskLayer(face, fit, fr.index.head); if (mk) layers.push(mk); }
      if (look.scarf !== 'none') { const rig = await this.rig(look.frame), w = scarfWrap(face, rig.names.indexOf('Neck'), fr.index.chest, fr.index.head, fr.joints.neck[1]); if (w) layers.push(w); }
      if (earrings(look) && !covered) pieces.push(...earringPieces(fit, fr.index.head).map(skinned));
      if (!covered && look.facialHair !== 'none') pieces.push(...mustachePieces(face, fit, fr.index.head).map(skinned));
      const geo = mergeParts([face, ...(hair ? [look.hat !== 'none' || gear ? withoutFlag(hair, HIDE_UNDER_HAT) : hair] : []), ...pieces, ...layers]);
      return scaleHead(geo, look.headSize, fr.joints.head, fr.index.head);
    });
  }
  private top(look: Look): Promise<THREE.BufferGeometry> {
    if (look.bag === 'none' && look.gloves === 'none' && look.scarf === 'none' && !necklace(look)) return this.part('top', look.top, look.frame);
    return this.cache(this.merged, topKey(look).join(':'), async () => {
      const m = await this.manifest(), fr = m.frames[look.frame], top = await this.part('top', look.top, look.frame), lt = m.parts.top[look.top].landmarks[look.frame];
      const fit = { back: lt.back!, front: lt.front!, chestY: fr.joints.chest[1], hipsY: fr.joints.hips[1] }, neckY = fr.joints.neck[1];
      const pieces = [...bagPieces(look.bag as Look['bag'], fit, fr.index, top), ...(look.scarf !== 'none' ? scarfEndPieces(fit, neckY, fr.index.chest, top) : []), ...(necklace(look) && look.scarf === 'none' ? necklacePieces(neckY, fr.index.chest, top) : [])].map(skinned);
      const layers: THREE.BufferGeometry[] = [];
      if (look.gloves !== 'none') { const rig = await this.rig(look.frame), hands = new Set(rig.names.flatMap((n, i) => HAND_BONE.test(n) ? [i] : [])), g = gloveLayer(top, hands); if (g) layers.push(g); }
      return mergeParts([top, ...pieces, ...layers]);
    });
  }
  private calfBottom(look: Look): Promise<THREE.BufferGeometry> {
    return this.cache(this.merged, `calf:${look.frame}:${look.bottom}:${look.shoes}`, async () => {
      const [bottom, shoes, rig] = await Promise.all([this.part('bottom', look.bottom, look.frame), this.part('shoes', look.shoes, look.frame), this.rig(look.frame)]);
      if (!calfMissing(bottom, shoes, rig)) return bottom;
      const skin = calfSkin(bottom, shoes, await this.part('bottom', 'beach', look.frame), rig); const out = mergeParts([bottom, skin]); out.userData.calfRepair = skin.userData.calfRepair; return out;
    });
  }
  /** The look's four part geometries (head, top, bottom, shoes) in bind space, built and shaped. */
  async geometries(look: Look): Promise<THREE.BufferGeometry[]> {
    const base = await Promise.all([this.head(look), this.top(look), this.calfBottom(look), this.part('shoes', look.shoes, look.frame)]);
    if (look.build === 1 && !SHAPE_KEYS.some((k) => look[k] !== 1)) return base;
    const rig = await this.rig(look.frame);
    return base.map((g) => withShape(withGirth(g, look.build, rig), look, rig));
  }
  /** The look's skinned scene (one merged mesh on a clone of its frame's rig, one palette material), fitted as today:
   *  scaled uniformly so its shoulders stand at the body model's height times height / 1.75. */
  async scene(params: unknown): Promise<{ look: Look; scene: THREE.Group; clips: THREE.AnimationClip[] }> {
    const look = resolveLook(params), m = await this.manifest(), [rig, geos] = await Promise.all([this.rig(look.frame), this.geometries(look)]);
    const armature = cloneSkinned(rig.root);
    let binder: THREE.SkinnedMesh | undefined; armature.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) binder = o as THREE.SkinnedMesh; });
    const bones = binder!.skeleton.bones; binder!.removeFromParent();
    const { palette, pattern } = paletteOf(look, look.preset !== 'none' ? m.presets[look.preset]?.palette : undefined);
    const mesh = new THREE.SkinnedMesh(infoColor(mergeParts(geos)), humanoidMaterial(palette, pattern)); mesh.name = 'body';
    armature.add(mesh);
    armature.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones, rig.ib.map((b) => b.clone())), mesh.matrixWorld);
    const scene = new THREE.Group(); scene.name = 'Scene'; scene.add(armature);
    // today's fit (people.ts): shoulders at SHOULDER_HEIGHT × height / 1.75 in the Idle pose
    const mixer = new THREE.AnimationMixer(scene), idle = THREE.AnimationClip.findByName(rig.clips, 'Idle');
    if (idle) { mixer.clipAction(idle).play(); mixer.update(0.01); }
    scene.updateMatrixWorld(true);
    const shoulder = (['UpperArmL', 'UpperArmR'].map((b) => scene.getObjectByName(b)?.getWorldPosition(new THREE.Vector3()).y ?? NaN).reduce((a, b) => a + b)) / 2;
    mixer.stopAllAction(); mixer.uncacheRoot(scene);
    if (!(shoulder > 0.1)) throw new Error('body.humanoid-rig');
    scene.scale.setScalar(SHOULDER_HEIGHT * (look.height / PERSON_HEIGHT) / shoulder);
    scene.updateMatrixWorld(true);
    return { look, scene, clips: rig.clips };
  }
  /** The look baked as a crowd model (`clips` that the rig has); equal looks share one. */
  model(params: unknown, clips: string[]): Promise<BakedModel> {
    const look = resolveLook(params);
    return this.cache(this.baked, lookKey(look), async () => {
      const { scene, clips: all } = await this.scene(look);
      return bakeModel('humanoid2', { scene } as unknown as GLTF, all, clips.filter((c) => all.some((a) => a.name === c)));
    });
  }
}

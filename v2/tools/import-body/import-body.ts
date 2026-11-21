// The body importer (Engine v2 B13, #2744): admits a body from today's authoring kit (`tools/body-authoring`) and
// writes it as a family kind the new engine loads.
//
// 1. Today's validator decides: it runs as a tool, in its own process, from a kit assembled exactly as a world serves
//    it (`apps/server/src/edge/body/authoring.ts`). Its limits are today's (4 MiB, 10,000 triangles, two images of
//    1024 pixels square); a refusal comes back with its code and, for a limit, the field, the measured value and the
//    limit. Nothing here re-checks what it checks.
// 2. The mesh is measured with the crowd's own loader (`v2/web/src/crowd/bake.ts`). A skinned body is posed through
//    every clip it declares, held in place as the crowd holds it, at MEASURE_FPS: its footprint is the widest any
//    vertex reaches from its root across those poses (a stride, not just the idle pose), its height the first clip's
//    first pose. A rigid body is fitted as the world fits it (largest extent 0.7 m) and hovers with its centre 1.45 m
//    up. The footprint rounds up to B12's size classes (`v2/crates/replica/src/kinds/sizes.rs`); wider than the
//    largest is `body-too-large`.
// 3. The simple model is the merged mesh clustered (`lod.ts`) to at most SIMPLE_TRIANGLES triangles, skin and colour
//    kept, written as `crowd-mesh/1`. Both models are named by the SHA-256 of their bytes.
// 4. The kind: owner `family`, B12's `size`, `height` and `hover` state fields and the measured `radius`, and section
//    13 (`v2/crates/replica/src/kinds/body.rs`): the resources its action profile gives it, the actions the validator
//    supports, and the two models.
//
// Admission is a tool run, never on the clock thread. Not here: upload routes, quotas, moderation (G6).
//
//   node v2/tools/import-body/import-body.ts <body.glb> <manifest.json> --out <dir>      (from the repository root)
//
// writes <dir>/<slug>.diag (the kind), <dir>/<slug>.json (what the crowd loads) and <dir>/models/<sha256>.glb|.mesh,
// and prints the summary as JSON. A refusal prints {refused: {code, message, field?, measured?, limit?}} and exits 1.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from '../../web/node_modules/three/build/three.module.js';
import { inPlace, merge, parseModel, fitRigid, bakeModel } from '../../web/src/crowd/bake.ts';
import { decodedGeometry } from './decode-draco.ts';
import { encodeMesh, simplify, type LodMesh } from '../../web/src/crowd/lod.ts';
import type { BodyMotion } from '../../../mars/viewer/engine/bodies/motion.ts';
import { BODY_LIMITS } from '../../../apps/server/src/edge/body/admission.ts';

const REPO = resolve(import.meta.dirname, '../../..');
export const SIMPLE_TRIANGLES = 600;
export const MEASURE_FPS = 15;
/** B12's size classes, smallest first: name and radius in mm (`sizes.rs`, `Size::ALL`). */
export const SIZES: [string, number][] = [['small', 200], ['standard', 280], ['large', 500], ['giant', 1300]];
/** How the world draws a rigid body (`authoring.ts`'s contract: profiles.rigid). */
const RIGID_HOVER = 1.45;

export class Refused extends Error {
  code: string;
  field?: string;
  measured?: number;
  limit?: number;
  constructor(code: string, message: string, d?: { field: string; measured: number; limit: number }) {
    super(message);
    this.code = code;
    Object.assign(this, d);
  }
}

/** The kit as a world serves it: the validator and the modules it imports, under the names it imports them by. */
function kit(): string {
  const root = join(REPO, '.local/import-body'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'kit-'));
  const files: [string, string][] = [
    ['validate.mjs', 'tools/body-authoring/validate.mjs'],
    ['rig.ts', 'apps/server/src/edge/body/rig.ts'],
    ['upload-validation.ts', 'apps/server/src/moderation/validate.ts'],
    ['action-profile.ts', 'mars/viewer/engine/bodies/action-profile.ts'],
    ['motion.ts', 'mars/viewer/engine/bodies/motion.ts'],
  ];
  for (const [to, from] of files) copyFileSync(join(REPO, from), join(dir, to));
  const admission = readFileSync(join(REPO, 'apps/server/src/edge/body/admission.ts'), 'utf8')
    .replace('../../../../../mars/viewer/engine/bodies/motion.ts', './motion.ts')
    .replace('../../../../../mars/viewer/engine/bodies/action-profile.ts', './action-profile.ts');
  writeFileSync(join(dir, 'admission.ts'), admission);
  return dir;
}

export type Report = {
  admitted: { assetId: string; type: string; name?: string; triangles: number; bytes: number; actionProfile?: string };
  report: { profile: string; actions: { supported: { action: string }[] } };
};

/** What the GLB measures against today's three per-file limits: bytes, triangles and its largest image side. Read
 *  only to name a refusal: the validator's own messages do not always carry the measured value. */
export function measured(b: Buffer): { bytes: number; triangles: number; imageDimension: number } {
  const out = { bytes: b.length, triangles: 0, imageDimension: 0 };
  try {
    const n = b.readUInt32LE(12), j = JSON.parse(b.toString('utf8', 20, 20 + n)), bin = b.subarray(28 + n);
    for (const m of j.meshes ?? []) for (const p of m.primitives ?? []) out.triangles += Math.floor(j.accessors[p.indices ?? p.attributes.POSITION].count / 3);
    for (const im of j.images ?? []) {
      const v = j.bufferViews[im.bufferView], x = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
      let side = 0;
      if (x[0] === 0x89 && x.length >= 24) side = Math.max(x.readUInt32BE(16), x.readUInt32BE(20));
      else for (let p = 2; p + 9 < x.length && x[p] === 0xff;) {
        const k = x[p + 1];
        if (k >= 0xc0 && k <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(k)) { side = Math.max(x.readUInt16BE(p + 5), x.readUInt16BE(p + 7)); break; }
        p += 2 + x.readUInt16BE(p + 2);
      }
      out.imageDimension = Math.max(out.imageDimension, side);
    }
  } catch { /* malformed: the validator names it */ }
  return out;
}

/** The limit a validator refusal is about, by its code (and, for the texture budget, its words). */
function limitOf(code: string, message: string): 'bytes' | 'triangles' | 'imageDimension' | null {
  if (code === 'upload.size' || code === 'body.too-large') return 'bytes';
  if (code === 'upload.triangle-budget' || code === 'body.too-many-triangles') return 'triangles';
  if ((code === 'body.image-too-large' && /dimensions/.test(message)) || (code === 'upload.texture-budget' && /\d+×\d+/.test(message))) return 'imageDimension';
  return null;
}

/** Runs today's validator on the files; its verdict, or its refusal as a `Refused`. */
export function validate(glb: string, manifest: string): Report {
  const dir = kit();
  try {
    const r = spawnSync(process.execPath, ['validate.mjs', resolve(glb), resolve(manifest), '--report'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status === 0) return JSON.parse(r.stdout) as Report;
    let e: { code?: string; message?: string; details?: { field: string; measured: number; limit: number } } = {};
    try {
      e = JSON.parse(r.stderr.trim().split('\n').at(-1) ?? '{}').error ?? {};
    } catch { /* not the validator's own refusal */ }
    const code = e.code ?? 'body.validator-failed', message = e.message ?? r.stderr.trim().slice(0, 300), field = limitOf(code, message);
    const details = e.details ?? (field ? { field, measured: measured(readFileSync(glb))[field], limit: BODY_LIMITS[field] } : undefined);
    throw new Refused(code, message, details);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The GLB with its images and textures dropped: geometry is all that is measured, and Node has no image decoder. */
function geometryOnly(bytes: Buffer): ArrayBuffer {
  const n = bytes.readUInt32LE(12), j = JSON.parse(bytes.toString('utf8', 20, 20 + n));
  delete j.images; delete j.textures; delete j.samplers;
  for (const m of j.materials ?? []) {
    for (const k of Object.keys(m)) if (k.endsWith('Texture')) delete m[k];
    if (m.pbrMetallicRoughness) for (const k of Object.keys(m.pbrMetallicRoughness)) if (k.endsWith('Texture')) delete m.pbrMetallicRoughness[k];
  }
  const js = Buffer.from(JSON.stringify(j)), pad = Buffer.alloc((4 - (js.length % 4)) % 4, 32), rest = bytes.subarray(20 + n);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length + pad.length + rest.length, 8);
  head.writeUInt32LE(js.length + pad.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, js, pad, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export type Measure = { radius: number; height: number; hover: number; clips: string[]; mesh: LodMesh };

/** Measures the body: footprint radius and height (m), hover (m) and the clips posed, and its merged mesh. */
export async function measure(bytes: Buffer, motion?: BodyMotion): Promise<Measure> {
  const gltf = await parseModel(geometryOnly(await decodedGeometry(bytes)));
  let skinned = false;
  gltf.scene.traverse((o) => void ((o as THREE.SkinnedMesh).isSkinnedMesh && (skinned = true)));
  if (!skinned) {
    fitRigid(gltf.scene);
    const { mesh } = merge(gltf);
    let r = 0, top = 0;
    for (let i = 0; i < mesh.position.length; i += 3) (r = Math.max(r, Math.hypot(mesh.position[i], mesh.position[i + 2]))), (top = Math.max(top, mesh.position[i + 1]));
    const animated = motion ? bakeModel('released-rigid', gltf, [], [], undefined, motion) : null;
    return { radius: animated?.radius ?? r, height: animated?.height ?? top, hover: Math.max(0, RIGID_HOVER - top / 2), clips: [], mesh };
  }
  const { mesh, skeleton } = merge(gltf);
  const P = mesh.position, I = mesh.skinIndex, W = mesh.skinWeight, n = P.length / 3;
  const mixer = new THREE.AnimationMixer(gltf.scene), mats = skeleton.bones.map(() => new THREE.Matrix4());
  const v = new THREE.Vector3(), s = new THREE.Vector3(), t = new THREE.Vector3();
  let radius = 0, height = 0;
  const clips = gltf.animations.map((c) => c.name);
  const pose = () => {
    gltf.scene.updateMatrixWorld(true);
    skeleton.bones.forEach((b, k) => mats[k].multiplyMatrices(b.matrixWorld, skeleton.boneInverses[k]));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      s.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = W[i * 4 + k];
        if (w) s.addScaledVector(t.copy(v).applyMatrix4(mats[I[i * 4 + k]]), w);
      }
      radius = Math.max(radius, Math.hypot(s.x, s.z));
      lo = Math.min(lo, s.y); hi = Math.max(hi, s.y);
    }
    return hi - lo;
  };
  if (!gltf.animations.length) height = pose();
  gltf.animations.forEach((src, ci) => {
    const clip = inPlace(src, skeleton), frames = Math.max(1, Math.round(clip.duration * MEASURE_FPS));
    mixer.stopAllAction();
    const a = mixer.clipAction(clip);
    a.play();
    for (let f = 0; f < frames; f++) {
      mixer.setTime((f / frames) * clip.duration);
      const h = pose();
      if (ci === 0 && f === 0) height = h;
    }
    a.stop();
    mixer.uncacheClip(clip);
  });
  return { radius, height, hover: 0, clips, mesh };
}

/** The size class a footprint of `mm` takes, or `body-too-large`. */
export function sizeFor(mm: number): string {
  const s = SIZES.find(([, r]) => r >= mm);
  if (!s) {
    const [, limit] = SIZES[SIZES.length - 1];
    throw new Refused('body-too-large', `a footprint of ${mm} mm is over the largest class's ${limit} mm`, { field: 'radius', measured: mm, limit });
  }
  return s[0];
}

/** A body's resources by its action profile (`v2/docs/bodies.md` rule 1: 1 locomotion, 2 manipulator, 3 gaze, 4
 *  voice; a manipulator's slot holds what it holds). */
export function resources(profile: string): [string, number, number?][] {
  const head: [string, number][] = [['souls:eyes', 3], ['souls:voice', 4]];
  const hands: [string, number, number][] = [['souls:hand-left', 2, 1], ['souls:hand-right', 2, 2]];
  switch (profile) {
    case 'rigid': return [['souls:glide', 1], ...head];
    case 'rolling-gripper/1': return [['souls:wheels', 1], ['souls:gripper-left', 2, 1], ['souls:gripper-right', 2, 2], ...head];
    case 'quadruped-torso/1': return [['souls:leg-front-left', 1], ['souls:leg-front-right', 1], ['souls:leg-back-left', 1], ['souls:leg-back-right', 1], ...hands, ...head];
    default: return [['souls:leg-left', 1], ['souls:leg-right', 1], ...hands, ...head];
  }
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** A kind's name part: lowercase letters, digits and `_`, starting with a letter (`ids.rs`, `is_kind_name`). */
const slug = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48).replace(/^(?=[^a-z])/, 'b_')) || 'body';
const q = (s: string) => JSON.stringify(s);

export type Imported = {
  kind: string; text: string; size: string; radiusMm: number; heightMm: number; hoverMm: number;
  resources: [string, number, number?][]; actions: string[]; clips: string[]; assetId: string; profile: string;
  full: { hash: string; bytes: Uint8Array; triangles: number; format?: 'baked' }; simple: { hash: string; bytes: Uint8Array; triangles: number };
};

/** Admits the body and returns its kind and models (nothing written). */
export async function importBody(glb: string, manifest: string): Promise<Imported> {
  const v = validate(glb, manifest);
  const bytes = readFileSync(glb);
  const m = await measure(bytes);
  return imported(bytes, v, m);
}

/** Shared data constructor after ordinary validation or exact immutable core admission; no authority is granted here. */
export function imported(bytes: Buffer, v: Report, m: Measure): Imported {
  const radiusMm = Math.ceil(m.radius * 1000), heightMm = Math.ceil(m.height * 1000), hoverMm = Math.round(m.hover * 1000);
  const size = sizeFor(radiusMm);
  const simple = encodeMesh(simplify(m.mesh, SIMPLE_TRIANGLES));
  const profile = v.report.profile, res = resources(profile), actions = v.report.actions.supported.map((a) => a.action);
  const kind = `body:${slug(v.admitted.name ?? v.admitted.assetId)}`;
  const full = { hash: `sha256:${sha(bytes)}`, bytes, triangles: v.admitted.triangles };
  const low = { hash: `sha256:${sha(simple)}`, bytes: simple, triangles: new DataView(simple.buffer).getUint32(12, true) / 3 };
  const field = (n: number, name: string, ty: string, value: string | number, extra = '') => `    ${n}: {1: ${q(name)}, 2: ${q(ty)}, 3: ${typeof value === 'string' ? q(value) : value}, 4: "public"${extra}}`;
  const text = [
    `# ${kind}: a body admitted from the authoring kit by v2/tools/import-body (Engine v2 B13, #2744). Validator asset`,
    `# ${v.admitted.assetId}, profile ${profile}. Footprint and height measured from the mesh across its clips.`,
    `{1: ${q(kind)}, 2: "family", 3: {`,
    [field(1, 'size', 'enum', size, `, 5: [${SIZES.map(([s]) => q(s)).join(', ')}]`), field(2, 'height', 'int', heightMm), field(3, 'hover', 'int', hoverMm), field(4, 'radius', 'int', radiusMm)].join(',\n') + '},',
    `  13: {1: [${res.map(([nm, c, slot]) => `{1: ${q(nm)}, 2: ${c}${slot ? `, 3: ${slot}` : ''}}`).join(', ')}],`,
    `    2: [${actions.map(q).join(', ')}],`,
    `    3: ${q(full.hash)},`,
    `    4: ${q(low.hash)}}}`,
    '',
  ].join('\n');
  return { kind, text, size, radiusMm, heightMm, hoverMm, resources: res, actions, clips: m.clips, assetId: v.admitted.assetId, profile, full, simple: low };
}

/** Writes the kind, the crowd's entry and both models under `out`; returns the summary. */
export function write(b: Imported, out: string) {
  const name = b.kind.slice(b.kind.indexOf(':') + 1), models = join(out, 'models');
  mkdirSync(models, { recursive: true });
  const fullFile = `models/${b.full.hash.slice(7)}.${b.full.format === 'baked' ? 'json' : 'glb'}`, simpleFile = `models/${b.simple.hash.slice(7)}.mesh`;
  writeFileSync(join(out, fullFile), b.full.bytes);
  writeFileSync(join(out, simpleFile), b.simple.bytes);
  writeFileSync(join(out, `${name}.diag`), b.text);
  const crowd = { kind: b.kind, full: fullFile, simple: simpleFile, clips: b.clips, format: b.full.format ?? 'gltf', rigid: b.profile === 'rigid' };
  writeFileSync(join(out, `${name}.json`), JSON.stringify(crowd, null, 1) + '\n');
  return {
    kind: b.kind, file: `${name}.diag`, assetId: b.assetId, profile: b.profile, size: b.size, radiusMm: b.radiusMm, heightMm: b.heightMm, hoverMm: b.hoverMm,
    resources: b.resources.map(([n]) => n), actions: b.actions, clips: b.clips,
    full: { hash: b.full.hash, triangles: b.full.triangles, bytes: b.full.bytes.length }, simple: { hash: b.simple.hash, triangles: b.simple.triangles, bytes: b.simple.bytes.length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = process.argv.slice(2), o = a.indexOf('--out'), out = o >= 0 ? a.splice(o, 2)[1] : null;
  if (a.length !== 2 || !out) {
    console.error('usage: node v2/tools/import-body/import-body.ts <body.glb> <manifest.json> --out <dir>');
    process.exit(2);
  }
  importBody(a[0], a[1]).then(
    (b) => console.log(JSON.stringify(write(b, resolve(out)), null, 1)),
    (e) => {
      const r = e instanceof Refused ? { code: e.code, message: e.message, field: e.field, measured: e.measured, limit: e.limit } : { code: 'body.import-failed', message: String(e?.message ?? e) };
      console.log(JSON.stringify({ refused: r }, null, 1));
      process.exit(1);
    },
  );
}

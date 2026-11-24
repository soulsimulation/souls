// Released bodies only. Ordinary uploads continue through importBody's unchanged validator and budgets.
// Core scans are admitted solely by the checked-in released manifest's exact hash. Authored examples reuse the
// existing body-definition normalization and immutable revision pin; procedural meshes sample their released source.
import { isMain } from '../../../tools/lib/is-main.mjs';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLOATER_MODELS } from '../../../mars/viewer/engine/bodies/models.ts';
import { CREATURE_IDS, creatureBody } from '../../../mars/viewer/engine/bodies/creatures.ts';
import { LITTLE_MARTIANS_MOTION } from '../../../mars/viewer/engine/bodies/motion.ts';
import { authorCentaur } from '../../../tools/body-authoring/centaur/author.mjs';
import { authorGhost } from '../../../tools/body-authoring/ghost/author.mjs';
import { authorMonster } from '../../../tools/body-authoring/monster/author.mjs';
import { authorPip } from '../../../tools/body-authoring/robot/author.mjs';
import { bindBodyDefinition, admitBodyGLB } from '../../../apps/server/src/edge/body/admission.ts';
import { validateUpload, BODY_UPLOAD_POLICY } from '../../../apps/server/src/moderation/validate.ts';
import { coreAsset } from '../../../apps/server/src/edge/body/core-revisions.ts';
import { PIP_PRESET } from '../../../apps/server/src/edge/body/pip.ts';
import { MONSTER_PRESET, GHOST_PRESET, CENTAUR_PRESET } from '../../../apps/server/src/edge/body/shared-bodies.ts';
import { HUMANOID2_DEF } from '../../../packages/world-compiler/src/core-kit/humanoid2.ts';
import { sha256Hex, stableStringify } from '../../../packages/world-compiler/src/hash.ts';
import { BODY_SOURCE_FILES } from '../../web/body-assets.ts';
import { bakeCreature, encodeBaked } from '../../web/src/crowd/bake.ts';
import { decodeBaked } from '../../web/src/crowd/bake.ts';
import { decoderBytes } from './decode-draco.ts';
import { imported, measure, measured, validate, write, type Report, type Imported } from './import-body.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export type Entry = { preset: string; hash: string; size: string; height: number; hover: number; grip?: number; entry: string; entryHash: string; legacy: unknown[] };
/** How far under its body a floater holds the middle of a load it carries, mm (0.135 Super): it has no hands, so the
 *  catalogue states its grip, the height above its surface it holds at (`v2/crates/replica/src/kinds/sizes.rs`). A
 *  body that stands states none and holds in its hands. */
export const FLOATER_GRIP_BELOW = 300;
export const gripOf = (hover: number) => (hover > FLOATER_GRIP_BELOW ? { grip: hover - FLOATER_GRIP_BELOW } : {});
export function legacyBody(preset: string): unknown {
  const shared = [PIP_PRESET, MONSTER_PRESET, GHOST_PRESET, CENTAUR_PRESET].find((p) => p.id === preset);
  if (shared) return structuredClone(shared.body);
  if (CREATURE_IDS.includes(preset as typeof CREATURE_IDS[number])) return creatureBody(preset as typeof CREATURE_IDS[number]);
  const model = FLOATER_MODELS.find((m) => m.id === preset);
  if (!model) throw Error('body.legacy-unavailable');
  const modelUrl = `/world-assets/littlemartians/characters/${model.file.replace(/^kin\//, '')}`;
  return { family: 'floater', type: 'ceramic', model: model.id, modelUrl, avatar: { kind: 'body', modelUrl, bodyType: 'ceramic' }, radius: .35, hoverHeight: 1.45, motion: structuredClone(LITTLE_MARTIANS_MOTION) };
}
function canonicalDefaultLook() {
  const source = readFileSync(join(REPO, 'apps/web/src/humanoid/look.ts'), 'utf8');
  const contracts = [
    "export const LOOK_KEY_PREFIX = 'humanoid2-';",
    "export const ACCESSORY_SLOTS = ['facialHair', 'scarf', 'gloves', 'mask', 'jewellery'] as const;",
    "export const SHAPE_KEYS = ['shoulders', 'chest', 'hips', 'weight'] as const;",
    "export const V2_KEYS = [...ACCESSORY_SLOTS, 'accessory', ...SHAPE_KEYS] as const;",
    'for (const k of V2_KEYS) if (look[k] === HUMANOID_PARAMS[k].default) delete look[k];',
    'return LOOK_KEY_PREFIX + sha256Hex(stableStringify(look)).slice(0, 16);',
  ];
  if (contracts.some((contract) => !source.includes(contract))) throw Error('body.legacy-default-source');
  if (HUMANOID2_DEF.params?.preset.default !== 'none') throw Error('body.legacy-default-source');
  const look = Object.fromEntries(Object.entries(HUMANOID2_DEF.params ?? {}).map(([key, field]) => [key, field.default]));
  for (const key of ['facialHair', 'scarf', 'gloves', 'mask', 'jewellery', 'accessory', 'shoulders', 'chest', 'hips', 'weight']) delete look[key];
  return { family: 'humanoid', model: 'humanoid2-' + sha256Hex(stableStringify(look)).slice(0, 16), params: {} };
}
export const legacyDefaults = [null, { family: 'humanoid' }, { family: 'humanoid', type: 'humanoid' }, canonicalDefaultLook()];
const rigidActions = ['go', 'stand', 'turn', 'look', 'speak', 'rest', 'wake']; // Existing validator's RIGID_CORE.
export function pinnedScan(preset: string, bytes: Buffer): Buffer {
  const source = JSON.parse(readFileSync(join(REPO, 'worlds/littlemartians/characters/manifest.json'), 'utf8')).models.find((m: { id: string }) => m.id === preset);
  if (!source || !FLOATER_MODELS.some((m) => m.id === preset && m.file === source.file) || source.bytes !== bytes.length || sha(bytes) !== source.sha256) throw Error('body.released-source-pin');
  return bytes;
}

export async function importPresets(out: string, media = REPO) {
  mkdirSync(out, { recursive: true });
  const scratch = join(REPO, '.local/import-body'); mkdirSync(scratch, { recursive: true });
  const tmp = mkdtempSync(join(scratch, 'presets-'));
  const bodies: Entry[] = [];
  let stage = 'catalogue';
  function install(preset: string, body: Imported, extra: object = {}) {
    const result = write(body, out), entry = result.file.replace(/\.diag$/, '.json');
    const file = join(out, entry), data = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...data, ...extra }) + '\n');
    bodies.push({ preset, hash: sha(body.text), size: body.size, height: body.heightMm, hover: body.hoverMm, ...gripOf(body.hoverMm), entry, entryHash: sha(readFileSync(file)), legacy: [legacyBody(preset)] });
  }
  try {
    for (const model of FLOATER_MODELS) {
      stage = model.id;
      const bytes = pinnedScan(model.id, readFileSync(join(media, 'worlds/littlemartians/characters', model.file)));
      const report: Report = { admitted: { assetId: 'body_' + sha(bytes), name: model.id, type: 'ceramic', bytes: bytes.length, triangles: measured(bytes).triangles }, report: { profile: 'rigid', actions: { supported: [...rigidActions, 'dance'].map((action) => ({ action })) } } };
      install(model.id, imported(bytes, report, await measure(bytes, LITTLE_MARTIANS_MOTION)), { yaw: model.facingYaw, motion: LITTLE_MARTIANS_MOTION });
    }
    const casual = join(media, 'mars/viewer/public/modular/environment/animated-casual.glb');
    const authors: [string, () => { bytes: Uint8Array; manifest: object }][] = [
      ['pip', () => authorPip({ source: casual })], ['monster', () => authorMonster({ source: casual })],
      ['ghost', () => authorGhost()], ['centaur', () => authorCentaur({ source: casual })],
    ];
    for (const [preset, author] of authors) {
      stage = preset;
      const made = author();
      // This is the existing shared-bodies.ts/pip.ts normalization, including its exact released revision check.
      const normalized = validateUpload(bindBodyDefinition(Buffer.from(made.bytes), made.manifest), BODY_UPLOAD_POLICY);
      const bytes = Buffer.from(normalized.bytes), admitted = admitBodyGLB(bytes, made.manifest);
      if (admitted.assetId !== coreAsset(preset as 'pip' | 'monster' | 'ghost' | 'centaur')) throw Error('body.released-source-pin');
      const glb = join(tmp, preset + '.glb'), manifest = join(tmp, preset + '.json');
      writeFileSync(glb, bytes); writeFileSync(manifest, JSON.stringify(made.manifest));
      const body = imported(bytes, validate(glb, manifest), await measure(bytes, (made.manifest as { motion?: typeof LITTLE_MARTIANS_MOTION }).motion));
      // Name stays the released preset id even when its display name contains spaces.
      body.kind = `body:${preset}`; body.text = body.text.replace(/^\{1: "body:[^"]+"/m, `{1: "body:${preset}"`);
      install(preset, body, { motion: (made.manifest as { motion?: unknown }).motion });
    }
    for (const species of CREATURE_IDS) {
      stage = species;
      const model = bakeCreature(species), bytes = Buffer.from(encodeBaked(model));
      const geometry = model.lods[0];
      const mesh = { position: new Float32Array(geometry.getAttribute('position').array), normal: new Float32Array(geometry.getAttribute('normal').array), color: new Float32Array(geometry.getAttribute('color').array), uv: new Float32Array(geometry.getAttribute('uv').array), material: new Uint16Array(geometry.getAttribute('position').count), skinIndex: new Uint16Array(geometry.getAttribute('skinIndex').array), skinWeight: new Float32Array(geometry.getAttribute('skinWeight').array), index: new Uint32Array(geometry.index!.array) };
      for (const group of geometry.groups) for (let i = group.start; i < group.start + group.count; i++) mesh.material[mesh.index[i]] = group.materialIndex ?? 0;
      const report: Report = { admitted: { assetId: 'body_' + sha(bytes), name: species, type: 'creature', bytes: bytes.length, triangles: model.triangles[0] }, report: { profile: 'rigid', actions: { supported: rigidActions.map((action) => ({ action })) } } };
      const body = imported(bytes, report, { radius: model.radius!, height: model.height, hover: 0, clips: model.clips.map((c) => c.name), mesh });
      body.full.format = 'baked'; install(species, body);
      // Keep the encoded artifact's validation on the producer boundary too.
      decodeBaked(bytes);
    }
    writeFileSync(join(out, 'bodies.json'), JSON.stringify({ format: 'souls/bodies/1', bodies, legacyDefaults }) + '\n');
    stage = 'default-assets';
    const defaults = ['animated-casual.mesh.glb', 'animated-punk.mesh.glb', 'animated-woman.mesh.glb', 'clips-ual.glb', 'clips-ual-woman.glb'];
    const manifest = JSON.parse(readFileSync(join(REPO, 'tools/assets/manifest.json'), 'utf8'));
    for (const file of defaults) {
      const path = 'mars/viewer/public/modular/environment/' + file, pin = manifest.files.find((f: { path: string }) => f.path === path), bytes = readFileSync(join(media, path));
      if (!pin || pin.symlink || bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw Error('body.default-source-pin');
      copyFileSync(join(media, path), join(out, file));
    }
    mkdirSync(join(out, 'decoder'), { recursive: true });
    for (const [name, bytes] of Object.entries(decoderBytes())) writeFileSync(join(out, 'decoder', name), bytes);
    const paths = readdirSync(out).filter((name) => /\.(diag|json|glb)$/.test(name) && name !== 'body-assets.json');
    paths.push(...readdirSync(join(out, 'models')).map((name) => 'models/' + name), ...Object.keys(decoderBytes()).map((name) => 'decoder/' + name));
    const files = paths.sort().map((path) => { const bytes = readFileSync(join(out, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; });
    writeFileSync(join(out, 'body-assets.json'), JSON.stringify({ format: 'souls/body-assets/1', sources: BODY_SOURCE_FILES.map((path) => ({ path, sha256: sha(readFileSync(join(REPO, path))) })), files }) + '\n');
    return { bodies, left: [] };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    const code = failure.code ?? (/^body[.-][a-z.-]+$/.test(failure.message ?? '') ? failure.message! : 'body.preset-import');
    throw Object.assign(new Error(code), { code, preset: stage, cause: error });
  } finally { rmSync(tmp, { recursive: true }); }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), at = (key: string) => args.indexOf(key) < 0 ? undefined : args[args.indexOf(key) + 1];
  const out = at('--out'); if (!out) throw Error('usage: presets.ts --out <dir> [--media <checkout>]');
  importPresets(resolve(out), resolve(at('--media') ?? REPO)).then((result) => console.log(JSON.stringify({ imported: result.bodies.map((b) => b.preset), left: result.left }))).catch((error) => { console.error(JSON.stringify({ refused: { code: error.code ?? 'body.presets-unavailable', preset: error.preset ?? 'input' } })); process.exitCode = 1; });
}

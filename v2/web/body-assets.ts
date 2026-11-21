// A build input, never a recursive copy: every published byte is a regular, manifest-pinned body artifact.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { FLOATER_MODELS } from '../../mars/viewer/engine/bodies/models.ts';
import { CREATURE_IDS } from '../../mars/viewer/engine/bodies/creatures.ts';
export const BODY_SOURCE_FILES = [
  'v2/web/body-assets.ts', 'v2/tools/import-body/presets.ts', 'v2/tools/import-body/import-body.ts', 'v2/tools/import-body/decode-draco.ts',
  'v2/web/src/crowd/bake.ts', 'v2/web/src/crowd/lod.ts', 'mars/viewer/app/engine-view/creatures.ts',
  'mars/viewer/engine/bodies/creatures.ts', 'mars/viewer/engine/bodies/models.ts', 'mars/viewer/engine/bodies/pose.ts',
  'mars/viewer/engine/bodies/motion.ts', 'apps/server/src/edge/body/core-revisions.ts',
  'apps/server/src/edge/body/admission.ts', 'apps/server/src/edge/body/pip.ts', 'apps/server/src/edge/body/shared-bodies.ts',
  'apps/web/src/humanoid/look.ts', 'packages/world-compiler/src/core-kit/humanoid2.ts', 'packages/world-compiler/src/hash.ts', 'apps/server/src/moderation/validate.ts',
  'tools/body-authoring/robot/author.mjs', 'tools/body-authoring/monster/author.mjs',
  'tools/body-authoring/ghost/author.mjs', 'tools/body-authoring/centaur/author.mjs',
  'worlds/littlemartians/characters/manifest.json', 'tools/assets/manifest.json',
];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const defaults = ['animated-casual.mesh.glb', 'animated-punk.mesh.glb', 'animated-woman.mesh.glb', 'clips-ual.glb', 'clips-ual-woman.glb'];
const decoderPins: Record<string, string> = {
  'decoder/draco_wasm_wrapper.js': '8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6',
  'decoder/draco_decoder.wasm': 'a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac',
};
const pathOK = (path: string) => defaults.includes(path) || Object.hasOwn(decoderPins, path) || /^[a-z][a-z0-9_]*\.(json|diag)$/.test(path) || /^models\/[a-f0-9]{64}\.(glb|json|mesh)$/.test(path);
export function bodyAssetFiles(root: string, repo = resolve(import.meta.dirname, '../..')): { path: string; bytes: Buffer }[] {
  const folder = resolve(root);
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw Error('body.assets-directory');
  const read = (path: string) => {
    if (path.includes('/') && !lstatSync(join(folder, path.split('/')[0])).isDirectory()) throw Error('body.assets-directory');
    for (const part of path.split('/').slice(0, -1)) if (lstatSync(join(folder, part)).isSymbolicLink()) throw Error('body.assets-symlink');
    const file = join(folder, path); if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw Error('body.assets-file');
    return readFileSync(file);
  };
  const manifest = JSON.parse(read('body-assets.json').toString('utf8'));
  if (manifest.format !== 'souls/body-assets/1' || !Array.isArray(manifest.files) || manifest.files.length > 256) throw Error('body.assets-manifest');
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== BODY_SOURCE_FILES.length) throw Error('body.assets-source');
  for (const [i, path] of BODY_SOURCE_FILES.entries()) {
    if (manifest.sources[i]?.path !== path || manifest.sources[i]?.sha256 !== sha(readFileSync(join(repo, path)))) throw Error('body.assets-source');
  }
  const released = JSON.parse(readFileSync(join(repo, 'tools/assets/manifest.json'), 'utf8'));
  const defaultPins = new Map(defaults.map((name) => [name, released.files.find((f: { path: string }) => f.path === 'mars/viewer/public/modular/environment/' + name)?.sha256]));
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !pathOK(file.path) || files.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > (64 << 20)) throw Error('body.assets-manifest');
    const bytes = read(file.path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256 || (decoderPins[file.path] && decoderPins[file.path] !== file.sha256) || (defaultPins.has(file.path) && defaultPins.get(file.path) !== file.sha256)) throw Error('body.assets-hash');
    const model = /^models\/([a-f0-9]{64})\./.exec(file.path);
    if (model && model[1] !== file.sha256) throw Error('body.assets-model-hash');
    files.set(file.path, bytes);
  }
  for (const required of ['bodies.json', ...defaults, ...Object.keys(decoderPins)]) if (!files.has(required)) throw Error('body.assets-missing');
  const catalogue = JSON.parse(files.get('bodies.json')!.toString('utf8'));
  if (catalogue.format !== 'souls/bodies/1' || !Array.isArray(catalogue.bodies) || !catalogue.bodies.length) throw Error('body.assets-catalogue');
  const seen = new Set<string>();
  for (const body of catalogue.bodies) {
    if (!/^[a-f0-9]{64}$/.test(body.hash) || typeof body.preset !== 'string' || seen.has(body.preset) || !/^[a-z][a-z0-9_]*\.json$/.test(body.entry)) throw Error('body.assets-catalogue');
    seen.add(body.preset);
    const entry = files.get(body.entry), kind = files.get(body.entry.replace(/\.json$/, '.diag'));
    if (!entry || !kind || sha(entry) !== body.entryHash || sha(kind) !== body.hash) throw Error('body.assets-kind-hash');
    const resource = JSON.parse(entry.toString('utf8'));
    for (const path of [resource.full, resource.simple]) {
      if (typeof path !== 'string' || !/^models\/[a-f0-9]{64}\.(glb|json|mesh)$/.test(path) || !files.has(path) || !kind.toString('utf8').includes(JSON.stringify('sha256:' + path.slice(7, 71)))) throw Error('body.assets-resource');
    }
  }
  const required = [...FLOATER_MODELS.map((m) => m.id), 'pip', 'monster', 'ghost', 'centaur', ...CREATURE_IDS];
  if (seen.size !== required.length || required.some((name) => !seen.has(name))) throw Error('body.assets-presets');
  return [...files].map(([path, bytes]) => ({ path, bytes }));
}

export function bodyAssets(root: string | undefined): Plugin {
  return {
    name: 'v2-body-assets',
    generateBundle() {
      if (!root) return; // Ordinary development can still name another explicit bodies URL.
      for (const file of bodyAssetFiles(root)) this.emitFile({ type: 'asset', fileName: 'assets/bodies/' + file.path, source: file.bytes });
    },
  };
}

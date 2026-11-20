#!/usr/bin/env node
// The three production/qualification callers share this fixed released input recipe. No install or provider call.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const inputs = [
  ...['verdelis.glb', 'kalama.glb', 'kweku.glb', 'mycos.glb', 'ada.glb', 'shuijing.glb', 'nyx.glb', 'kin/green-patterns-blue.glb', 'kin/chebel.glb', 'kin/colors-lemuet.glb', 'kin/crystal-freeman.glb', 'kin/dark-blue.glb', 'kin/green-brains-out.glb'].map((name) => 'worlds/littlemartians/characters/' + name),
  ...['animated-casual.glb', 'animated-casual.mesh.glb', 'animated-punk.mesh.glb', 'animated-woman.mesh.glb', 'clips-ual.glb', 'clips-ual-woman.glb'].map((name) => 'mars/viewer/public/modular/environment/' + name),
];
/** Fixed existing dependencies for the released renderer's source/type closure; no package install. */
export function prepareDependencies() {
  const manifest = JSON.parse(readFileSync(join(repo, 'v2/web/package.json'), 'utf8'));
  const packages = JSON.parse(readFileSync(join(repo, 'v2/web/package-lock.json'), 'utf8')).packages;
  for (const [name, version] of [['three', '0.187.0'], ['@types/three', '0.187.0'], ['zod', '4.6.7']]) {
    const file = join(repo, 'v2/web/node_modules', name, 'package.json');
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || JSON.parse(readFileSync(file, 'utf8')).version !== version ||
      packages['node_modules/' + name]?.version !== version ||
      (manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]) !== version ||
      (packages[''].dependencies?.[name] ?? packages[''].devDependencies?.[name]) !== version) throw Error('body.dependency-lock');
  }
  for (const [path, target] of [
    ['mars/viewer/node_modules/three', '../../../v2/web/node_modules/three'],
    ['mars/viewer/node_modules/@types/three', '../../../../v2/web/node_modules/@types/three'],
    ['mars/viewer/node_modules/zod', '../../../v2/web/node_modules/zod'],
    ['packages/engine-contract/node_modules/zod', '../../../v2/web/node_modules/zod'],
  ]) {
    const leaf = join(repo, path); mkdirSync(dirname(leaf), { recursive: true });
    try { if (!lstatSync(leaf).isSymbolicLink() || readlinkSync(leaf) !== target) throw Error('body.dependency-link-conflict'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; symlinkSync(target, leaf); }
  }
}
function main() {
const args = process.argv.slice(2), outAt = args.indexOf('--out'), test = args.includes('--test');
if (outAt < 0 || !args[outAt + 1] || args.length !== (test ? 3 : 2)) throw Error('usage: prepare.mjs --out <prepared> [--test]');
const out = resolve(args[outAt + 1]), start = performance.now(), total = 300_000;
const cache = join(process.env.RUNNER_TEMP ?? join(repo, '.local/2750'), 'body-input-cache');
function run(stage, argv, env = process.env, executable = process.execPath, cwd = repo) {
  const remaining = total - (performance.now() - start); if (remaining <= 0) throw Error('body.prepare-deadline');
  const result = spawnSync(executable, argv, { cwd, env, timeout: Math.min(120_000, remaining), encoding: 'utf8', maxBuffer: 8 << 20 });
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status !== 0) throw Error('body.prepare-' + stage);
  return result.stdout;
}
try {
  run('inputs', ['tools/assets/pull.mjs', '--only', inputs.join(','), '--cache', cache, '--concurrency', '4']);
  prepareDependencies();
  run('import', ['v2/tools/import-body/presets.ts', '--out', out, '--media', repo]);
  if (!lstatSync(join(out, 'body-assets.json')).isFile()) throw Error('body.assets-missing');
  if (test) {
    run('tests', ['--test', 'v2/web/src/crowd/crowd.test.ts', 'v2/tools/import-body/import-body.test.ts', 'v2/tools/import-body/presets.test.ts', 'v2/web/body-assets.test.ts'], { ...process.env, B15_BODY_ASSETS: out, B15_MEDIA_ROOT: repo });
    const env = { ...process.env, BRAIN_MODE: 'fake', CARGO_BUILD_JOBS: '4', B15_REQUIRE_PREPARED: '1', B15_BODY_ASSETS: out, B15_IMPORT_OUTPUT: out + '-private-import' };
    for (const [pkg, file, name] of [['import-accounts', 'owned', 'b15_mapped_released_births'], ['worldd', 'wear', 'b15_imported_choice_ordinary_c3']]) {
      const args = ['test', '--manifest-path', join(repo, 'v2/Cargo.toml'), '--release', '-p', pkg, '--test', file, name, '--locked', '--', '--exact', '--nocapture'];
      const stdout = run('native-' + pkg, args, env, process.env.CARGO ?? 'cargo', join(repo, 'v2'));
      if (!/test result: ok\. 1 passed; 0 failed; 0 ignored;/.test(stdout)) throw Error('body.prepare-native-count');
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

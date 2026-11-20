#!/usr/bin/env node
// The three production/qualification callers share this fixed released input recipe. No install or provider call.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2), outAt = args.indexOf('--out'), test = args.includes('--test');
if (outAt < 0 || !args[outAt + 1] || args.length !== (test ? 3 : 2)) throw Error('usage: prepare.mjs --out <prepared> [--test]');
const out = resolve(args[outAt + 1]), start = performance.now(), total = 300_000;
const inputs = [
  ...['verdelis.glb', 'kalama.glb', 'kweku.glb', 'mycos.glb', 'ada.glb', 'shuijing.glb', 'nyx.glb', 'kin/green-patterns-blue.glb', 'kin/chebel.glb', 'kin/colors-lemuet.glb', 'kin/crystal-freeman.glb', 'kin/dark-blue.glb', 'kin/green-brains-out.glb'].map((name) => 'worlds/littlemartians/characters/' + name),
  ...['animated-casual.glb', 'animated-casual.mesh.glb', 'animated-punk.mesh.glb', 'animated-woman.mesh.glb', 'clips-ual.glb', 'clips-ual-woman.glb'].map((name) => 'mars/viewer/public/modular/environment/' + name),
];
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
  const packages = JSON.parse(readFileSync(join(repo, 'v2/web/package-lock.json'), 'utf8')).packages;
  const version = JSON.parse(readFileSync(join(repo, 'v2/web/node_modules/three/package.json'), 'utf8')).version;
  if (version !== '0.187.0' || packages['node_modules/three']?.version !== version) throw Error('body.three-lock');
  const parent = join(repo, 'mars/viewer/node_modules'), leaf = join(parent, 'three'), target = '../../../v2/web/node_modules/three';
  mkdirSync(parent, { recursive: true });
  try { if (!lstatSync(leaf).isSymbolicLink() || readlinkSync(leaf) !== target) throw Error('body.three-link-conflict'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; symlinkSync(target, leaf); }
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

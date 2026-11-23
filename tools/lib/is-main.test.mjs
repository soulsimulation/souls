// isMain: a script started through a symlink runs its main. Production starts tools through /srv/sim-worlds/production,
// a link to the live release; comparing process.argv[1] with the module's real path made them exit 0 without running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const run = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });

function linkedRelease(t) {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(REPO, join(dir, 'production'));   // as /srv/sim-worlds/production -> the release
  return { dir, release: join(dir, 'production') };
}

test('routes.mjs started through a linked release runs its main (writes or refuses; never a silent exit 0)', (t) => {
  const { dir, release } = linkedRelease(t);
  const r = run(join(release, 'v2/tools/ops/proxy/routes.mjs'), ['--directory', 'http://127.0.0.1:9', '--launcher', 'http://127.0.0.1:9', '--out', join(dir, 'out')],
    { SOULS_WORLD_ROUTES: join(dir, 'no-routes.json') });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^routes: unchanged: /);
});

test('cutover/state.mjs started through a linked release runs its main', (t) => {
  const { dir, release } = linkedRelease(t);
  const r = run(join(release, 'v2/tools/ops/cutover/state.mjs'), ['check', join(release, 'v2/tools/ops/cutover/cutover.sh')],
    { CUTOVER_ROOT: dir, SOULS_CUTOVER_BINDING: join(dir, 'no-binding.json'), SLUG: 'eden', WORLD: 'eden' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /cutover\.binding-unavailable/);
});

test('isMain: true for the started file, false for an imported module and for an argv[1] that is not a file', () => {
  assert.equal(isMain(import.meta.url), true);   // node --test starts this file
  assert.equal(isMain(new URL('./is-main.mjs', import.meta.url).href), false);   // imported, not started
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { isMain } from ${JSON.stringify(new URL('./is-main.mjs', import.meta.url).href)}; console.log(isMain(${JSON.stringify(new URL('./is-main.mjs', import.meta.url).href)}))`, 'not-a-file'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'false');
});

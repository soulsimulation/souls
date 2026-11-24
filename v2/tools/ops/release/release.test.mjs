// release.sh's release-head checks and the reseed it carries (0.133 R13), with stand-ins for gh and the machine's
// programs: the merge queue's green ci run counts for ci-ok and the v2 legs, and a staged release runs Eden's reseed
// pre-check with its own world-aside and kinds.
//   node --test v2/tools/ops/release/release.test.mjs

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const release = join(here, 'release.sh');
const dir = mkdtempSync(join(tmpdir(), 'souls-r13-release-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const sha = 'a'.repeat(40);
const exe = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
const run = (args, env = {}) => spawnSync('bash', [release, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('checks: the merge queue\'s green ci run at the head counts for ci-ok and the v2 legs', () => {
  const bin = join(dir, 'gh-bin');
  // gh api: the head's successful check runs are the security ones only (main's push run was cancelled); the Actions
  // runs API answers how many merge_group ci runs passed there (QUEUED).
  exe(join(bin, 'gh'), 'case "$*" in *check-runs*) printf "scrub-guard\\ngitleaks\\n" ;; *actions/runs*) echo "${QUEUED:-0}" ;; esac');
  const env = { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' };
  const refused = run(['checks', sha], { ...env, QUEUED: '0' });
  assert.equal(refused.status, 3, refused.stdout + refused.stderr);
  for (const n of ['ci-ok', 'v2-rust', 'v2-sim', 'v2-worldd', 'v2-wasm', 'v2-client']) assert.match(refused.stdout, new RegExp(`release.missing-check: ${n} `));
  const passed = run(['checks', sha], { ...env, QUEUED: '1' });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /merge queue's ci run passed/);
  assert.match(passed.stdout, /every listed check passed/);
  // the security checks still have to pass at the head itself
  exe(join(bin, 'gh'), 'case "$*" in *check-runs*) printf "gitleaks\\n" ;; *actions/runs*) echo 1 ;; esac');
  const noScrub = run(['checks', sha], env);
  assert.equal(noScrub.status, 3);
  assert.match(noScrub.stdout, /release.missing-check: scrub-guard /);
});

test('a staged release carries the reseed, and its pre-check uses that release\'s world-aside and kinds', () => {
  const bins = join(dir, 'bins'), page = join(dir, 'page'), pkg = join(dir, 'pkg'), out = join(dir, 'bundle');
  const data = join(dir, 'data'), etc = join(dir, 'etc'), lib = join(dir, 'lib');
  for (const d of [page, pkg, etc, lib]) mkdirSync(d, { recursive: true });
  const world = `${'c'.repeat(32)}-${'c'.repeat(32)}-0`;
  // Stand-ins: worldd answers `schemas` (stage's start check); deploy says what is pinned; world-aside lists 3 objects.
  exe(join(bins, 'worldd'), 'exit 0');
  exe(join(bins, 'gatewayd'), 'exit 0');
  exe(join(bins, 'deploy'), 'echo 1220' + '0'.repeat(64));
  exe(join(bins, 'gateway-upgrade'), 'exit 0');
  exe(join(bins, 'world-aside'), 'echo "dry run: 3 objects of $1 would move; nothing changed"');
  exe(join(lib, 'supervisor'), 'if command -v sha256sum > /dev/null; then s=$(sha256sum "$2"); else s=$(shasum -a 256 "$2"); fi; echo "1220$(echo "$s" | cut -c1-64)"');
  writeFileSync(join(page, 'index.html'), '<!doctype html>');
  writeFileSync(join(pkg, 'replica.js'), 'export function initSync() {}\n');
  writeFileSync(join(pkg, 'replica_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  writeFileSync(join(etc, 'cutover.env'), `WORLD="${world}"\n`);
  const folder = join(data, 'worlds/worlds', world);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'facts.json'), '{}');
  writeFileSync(join(folder, 'world.json'), '{"entry": [1000, 2000]}');

  // A stand-in client (served.test.mjs checks the real one), so this needs no installed packages.
  const client = join(dir, 'client');
  for (const d of ['src', 'skill']) mkdirSync(join(client, d), { recursive: true });
  exe(join(client, 'served/build.mjs'), '');
  writeFileSync(join(client, 'served/build.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nconst out = process.argv[process.argv.indexOf('--out') + 1];\nmkdirSync(out, { recursive: true });\nwriteFileSync(out + '/eden.mjs', '// client');\n");
  const bundled = run(['bundle', out, sha, '0.133.1', bins, page, client, pkg]);
  assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
  const env = { RELEASE_DATA: data, WORLDS_ROOT: join(data, 'worlds'), RESEED_DATA: data, RESEED_ETC: etc, RESEED_LIB: lib };
  const staged = run(['stage', out], env);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const check = run(['reseed', sha, 'check'], env);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const rel = join(data, 'releases', sha);
  assert.match(check.stdout, new RegExp(`world-aside +the release's own, ${rel}/bin/world-aside`));
  assert.match(check.stdout, new RegExp(`kind entries +${rel}/reseed/kinds \\(\\d+ entries\\)`));
  assert.match(check.stdout, /3 of the world's objects at their keys/);
  assert.match(check.stdout, /check only; nothing changed/);
  // a fresh reseed refuses while a reseed to this build is not undone, and names the label to resume
  const manifest = readFileSync(join(rel, 'manifest.json'), 'utf8');
  const built = /"name":"worldd","hash":"(1220[0-9a-f]{64})"/.exec(manifest)[1];
  mkdirSync(join(data, 'worlds/aside'), { recursive: true });
  writeFileSync(join(data, 'worlds/aside', `${world}-20261124T000000Z.reseed`), `world=${world}\nold=1220${'0'.repeat(64)}\nnew=${built}\nlabel=20261124T000000Z\n`);
  const again = run(['reseed', sha, 'check'], env);
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stderr, /reseed 20261124T000000Z to this build is not undone: resume it \(reseed=20261124T000000Z/);
  writeFileSync(join(data, 'worlds/aside', `${world}-20261124T000000Z.reseed`), `world=${world}\nnew=${built}\nlabel=20261124T000000Z\nundone=20261124T010000Z\n`);
  assert.equal(run(['reseed', sha, 'check'], env).status, 0, 'an undone reseed does not block a fresh one');
  // a label that is not one is refused before anything runs
  assert.equal(run(['reseed', sha, 'run', 'tomorrow'], env).status, 1);
  assert.equal(run(['reseed-undo', 'nope', 'check'], env).status, 2);
});

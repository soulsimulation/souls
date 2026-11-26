// release.sh's release-head checks, the reseed it carries (0.133 R13) and its move of the directory and the origin,
// with stand-ins for gh and the machine's programs: the merge queue's green ci run counts for ci-ok and the v2 legs, a
// staged release runs Eden's reseed pre-check with its own kinds on a fresh store generation, and the move restarts the directory
// and the origin once, after the worlds and the gateway, on the release's programs and units, and puts each back on its
// previous ones when it does not answer as healthy.
//   node --test v2/tools/ops/release/release.test.mjs

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

test('a staged release carries the reseed, and its pre-check uses that release\'s kinds and a fresh store generation', () => {
  const bins = join(dir, 'bins'), page = join(dir, 'page'), pkg = join(dir, 'pkg'), out = join(dir, 'bundle');
  const data = join(dir, 'data'), etc = join(dir, 'etc'), lib = join(dir, 'lib');
  for (const d of [page, pkg, etc, lib]) mkdirSync(d, { recursive: true });
  const world = `${'c'.repeat(32)}-${'c'.repeat(32)}-0`;
  // Stand-ins: worldd answers `schemas` (stage's start check); deploy says what is pinned; both read a store generation
  // (#4954: they carry its refusal, 'generation-bad: '), and so does the installed supervisor.
  exe(join(bins, 'worldd'), '# generation-bad: \nexit 0');
  exe(join(bins, 'gatewayd'), 'exit 0');
  exe(join(bins, 'directoryd'), 'exit 0');
  exe(join(bins, 'deploy'), '# generation-bad: \necho 1220' + '0'.repeat(64));
  exe(join(bins, 'gateway-upgrade'), 'exit 0');
  exe(join(bins, 'world-aside'), 'echo "dry run: 3 objects of $1 would move; nothing changed"');
  exe(join(bins, 'assets-check'), 'exit 0');
  exe(join(bins, 'store-copy'), 'exit 0');
  exe(join(lib, 'supervisor'), 'if [ "$1" = generation ]; then echo none; exit 0; fi; if command -v sha256sum > /dev/null; then s=$(sha256sum "$2"); else s=$(shasum -a 256 "$2"); fi; echo "1220$(echo "$s" | cut -c1-64)"');
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
  assert.match(check.stdout, new RegExp(`kind entries +${rel}/reseed/kinds \\(\\d+ entries\\)`));
  // #4837: Eden's stock and its libraries go with the release, as a world folder keeps them, and the reseed seeds with them
  assert.match(check.stdout, new RegExp(`stock +${rel}/reseed/stock/stock\\.json`));
  for (const f of ['stock.json', 'library/books.json', 'library/garments.json']) assert.ok(existsSync(join(rel, 'reseed/stock', f)), f);
  assert.match(check.stdout, /generation +the fresh world's objects under g\/\d{8}T\d{6}Z\/; the old world's \(at their keys\) stay where they are: none moves/);
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
  // and an undone reseed is not resumed
  const resumed = run(['reseed', sha, 'check', '20261124T000000Z'], env);
  assert.equal(resumed.status, 1, resumed.stdout + resumed.stderr);
  assert.match(resumed.stderr, /reseed 20261124T000000Z was undone: start a fresh reseed instead/);
  // a label that is not one is refused before anything runs
  assert.equal(run(['reseed', sha, 'run', 'tomorrow'], env).status, 1);
  assert.equal(run(['reseed-undo', 'nope', 'check'], env).status, 2);
});

test('move: the directory and the origin go on the release once, after the worlds and the gateway, and go back when unhealthy', () => {
  const t = join(dir, 'services'), bins = join(t, 'bins'), page = join(t, 'page'), pkg = join(t, 'pkg');
  const client = join(t, 'client'), out = join(t, 'bundle');
  for (const d of [page, pkg, join(client, 'src'), join(client, 'skill'), join(client, 'served')]) mkdirSync(d, { recursive: true });
  // Stand-ins: deploy and gateway-upgrade say what they moved in the machine's log; directoryd is the release's.
  exe(join(bins, 'worldd'), 'exit 0');
  exe(join(bins, 'gatewayd'), 'exit 0');
  exe(join(bins, 'directoryd'), '# the release\'s directoryd');
  exe(join(bins, 'deploy'), 'echo "deploy $1" >> "$LOG"');
  exe(join(bins, 'gateway-upgrade'), 'echo "gateway-upgrade" >> "$LOG"');
  exe(join(bins, 'world-aside'), 'exit 0');
  exe(join(bins, 'assets-check'), 'exit 0');
  exe(join(bins, 'store-copy'), 'exit 0');
  writeFileSync(join(page, 'index.html'), '<!doctype html>');
  writeFileSync(join(pkg, 'replica.js'), 'export function initSync() {}\n');
  writeFileSync(join(pkg, 'replica_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  writeFileSync(join(client, 'served/build.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nconst out = process.argv[process.argv.indexOf('--out') + 1];\nmkdirSync(out, { recursive: true });\nwriteFileSync(out + '/eden.mjs', '// client');\n");
  const bundled = run(['bundle', out, sha, '0.135.1', bins, page, client, pkg]);
  assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
  for (const a of ['directoryd', 'origin\\.tar', 'units\\.tar']) assert.match(bundled.stdout, new RegExp(`  ${a} +1220`));
  const unitsDir = join(here, '../units');
  const read = (f) => readFileSync(f, 'utf8');

  // One machine: two worlds (the first's stream named in its views/world.json), the previous directoryd, origin and
  // directory unit (the origin's unit is already the release's), and systemctl and curl that write to its log. curl
  // answers the directory 401 and the origin 200, unless BAD_DIRECTORY or BAD_ORIGIN makes the release's one unhealthy.
  const machine = (name, extra = {}) => {
    const m = join(t, name), data = join(m, 'data'), lib = join(m, 'lib'), etc = join(m, 'etc'), units = join(m, 'units');
    const shim = join(m, 'shim'), log = join(m, 'log');
    for (const d of [etc, units, join(lib, 'origin')]) mkdirSync(d, { recursive: true });
    const worlds = ['a', 'b'].map((c) => `${c.repeat(32)}-${c.repeat(32)}-0`);
    for (const w of worlds) mkdirSync(join(data, 'worlds/worlds', w, 'views'), { recursive: true });
    writeFileSync(join(data, 'worlds/worlds', worlds[0], 'views/world.json'), '{"stream": "views/root/", "history": "history/"}');
    writeFileSync(join(lib, 'directoryd'), '# the previous directoryd\n');
    writeFileSync(join(lib, 'origin/origin.mjs'), '// the previous origin\n');
    writeFileSync(join(units, 'souls-directory.service'), '# the previous unit\n');
    writeFileSync(join(units, 'souls-origin.service'), readFileSync(join(unitsDir, 'souls-origin.service')));
    writeFileSync(join(etc, 'directory.args'), 'DIRECTORYD_ARGS=--listen 127.0.0.1:7999 --store /nowhere\n');
    exe(join(shim, 'systemctl'), 'echo "systemctl $*" >> "$LOG"');
    exe(join(shim, 'curl'), [
      'for a in "$@"; do url=$a; done',
      'echo "curl $url" >> "$LOG"',
      'case $url in',
      '  */v1/account/session) if [ -n "$BAD_DIRECTORY" ] && grep -q release "$RELEASE_LIB/directoryd"; then printf 500; else printf 401; fi ;;',
      '  *) if [ -n "$BAD_ORIGIN" ] && ! grep -q previous "$RELEASE_LIB/origin/origin.mjs"; then printf 503; else printf 200; fi ;;',
      'esac',
    ].join('\n'));
    const env = { RELEASE_DATA: data, WORLDS_ROOT: join(data, 'worlds'), RELEASE_LIB: lib, RELEASE_ETC: etc, RELEASE_UNITS: units,
      RELEASE_HEALTH_S: '1', LOG: log, PATH: `${shim}:${process.env.PATH}`, ...extra };
    const staged = run(['stage', out], env);
    assert.equal(staged.status, 0, staged.stdout + staged.stderr);
    return { env, lib, units, worlds, rel: join(data, 'releases', sha), lines: () => read(log).trim().split('\n') };
  };

  // Healthy: both worlds and the gateway first, then one daemon-reload for the changed directory unit, then each
  // service restarted once and asked; the release's programs and units are in place and nothing is left beside them.
  const ok = machine('ok');
  const moved = run(['move', sha], ok.env);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.deepEqual(ok.lines(), [
    `deploy ${ok.worlds[0]}`, `deploy ${ok.worlds[1]}`, 'gateway-upgrade',
    'systemctl daemon-reload', 'systemctl restart souls-directory.service', 'curl http://127.0.0.1:7999/v1/account/session',
    'systemctl restart souls-origin.service', `curl http://localhost:7320/w/${ok.worlds[0]}/views/root/pointer`,
  ]);
  assert.equal(read(join(ok.lib, 'directoryd')), read(join(bins, 'directoryd')));
  assert.equal(read(join(ok.lib, 'origin/origin.mjs')), read(join(here, '../../origin/origin.mjs')));
  assert.equal(read(join(ok.units, 'souls-directory.service')), read(join(unitsDir, 'souls-directory.service')));
  assert.equal(existsSync(join(ok.lib, '.directoryd.prev')) || existsSync(join(ok.lib, '.origin.prev')), false);
  assert.match(moved.stdout, /souls-directory\.service answers 401/);
  assert.match(moved.stdout, /souls-origin\.service answers 200/);
  assert.match(moved.stdout, /the directory and the origin$/m);
  // R13: the move gave the directory the mailbox key before it restarted it, and checked the gateways (none here)
  assert.match(read(join(ok.env.RELEASE_ETC, 'directory.args')), / --mailbox-key \S+mailbox\.key\n$/);
  assert.match(moved.stdout, /mailbox: add --mailbox-key [\s\S]*mailbox: no gateway here to check/);
  // a second dispatch of the same release restarts nothing again
  const before = ok.lines().length;
  assert.equal(run(['move', sha], ok.env).status, 0);
  assert.equal(ok.lines().slice(before).filter((l) => l.startsWith('systemctl')).length, 0);

  // An unhealthy directory: its previous program and unit go back, it is restarted on them, and the release stops
  // before the origin.
  const bad = machine('bad-directory', { BAD_DIRECTORY: '1' });
  const refused = run(['move', sha], bad.env);
  assert.equal(refused.status, 3, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /refused: release\.directory-unhealthy: souls-directory\.service answered 500, not 401, on 1220[0-9a-f]{12}…; back on its previous program it answers 401/);
  assert.equal(read(join(bad.lib, 'directoryd')), '# the previous directoryd\n');
  assert.equal(read(join(bad.units, 'souls-directory.service')), '# the previous unit\n');
  assert.deepEqual(bad.lines().filter((l) => l.startsWith('systemctl')), [
    'systemctl daemon-reload', 'systemctl restart souls-directory.service', 'systemctl daemon-reload', 'systemctl restart souls-directory.service',
  ]);
  assert.equal(existsSync(join(bad.rel, 'moved/directory')), false);

  // An unhealthy origin: the directory stays on the release; the previous origin folder goes back.
  const badOrigin = machine('bad-origin', { BAD_ORIGIN: '1' });
  const refusedOrigin = run(['move', sha], badOrigin.env);
  assert.equal(refusedOrigin.status, 3, refusedOrigin.stdout + refusedOrigin.stderr);
  assert.match(refusedOrigin.stdout, /refused: release\.origin-unhealthy: souls-origin\.service answered 503, not 200, .*answers 200/);
  assert.equal(read(join(badOrigin.lib, 'origin/origin.mjs')), '// the previous origin\n');
  assert.equal(existsSync(join(badOrigin.lib, 'origin/site.mjs')), false);
  assert.equal(read(join(badOrigin.lib, 'directoryd')), read(join(bins, 'directoryd')));
  assert.equal(existsSync(join(badOrigin.rel, 'moved/directory')), true);
  assert.equal(existsSync(join(badOrigin.rel, 'moved/origin')), false);
  // the origin's unit was already the release's: only the directory's change reloaded systemd
  assert.equal(badOrigin.lines().filter((l) => l === 'systemctl daemon-reload').length, 1);
});

test('a move gives each world the page\'s body catalogue before its deploy, and the binding the page\'s catalogue folder', () => {
  const root = join(dir, 'bodies'), bins = join(root, 'bins'), page = join(root, 'page'), out = join(root, 'bundle');
  const data = join(root, 'data'), etc = join(root, 'etc'), lib = join(root, 'lib'), worlds = join(data, 'worlds/worlds');
  for (const d of [etc, lib, join(page, 'assets/bodies')]) mkdirSync(d, { recursive: true });
  const h = (c) => c.repeat(64), cat = (...hs) => JSON.stringify({ format: 'souls/bodies/1', bodies: hs.map((hash, i) => ({ preset: `p${i}`, hash, size: 'standard', height: 1000, hover: 0 })) });
  const released = cat(h('a'), h('b'));
  writeFileSync(join(page, 'assets/bodies/bodies.json'), released);
  exe(join(bins, 'worldd'), 'exit 0');
  exe(join(bins, 'gatewayd'), 'exit 0');
  exe(join(bins, 'directoryd'), 'exit 0');
  // deploy restarts the world: the stand-in says whether the world's folder held a catalogue then
  const deployed = join(root, 'deployed');
  exe(join(bins, 'deploy'), `if [ -f "$WORLDS_ROOT/worlds/$1/bodies.json" ]; then echo "$1 has" >> "${deployed}"; else echo "$1 none" >> "${deployed}"; fi`);
  exe(join(bins, 'gateway-upgrade'), 'exit 0');
  exe(join(bins, 'world-aside'), 'exit 0');
  exe(join(bins, 'assets-check'), 'exit 0');
  exe(join(bins, 'store-copy'), 'exit 0');
  const client = join(root, 'client'), pkg = join(root, 'pkg');
  for (const d of ['src', 'skill', 'served']) mkdirSync(join(client, d), { recursive: true });
  writeFileSync(join(client, 'served/build.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nconst out = process.argv[process.argv.indexOf('--out') + 1];\nmkdirSync(out, { recursive: true });\nwriteFileSync(out + '/eden.mjs', '// client');\n");
  mkdirSync(pkg, { recursive: true });
  // none: no catalogue; fork: none, and a fork's boot pins it; older: one the release's admits; other: one with a body
  // the release's lacks
  const world = (name, meta, bodies) => {
    mkdirSync(join(worlds, name), { recursive: true });
    writeFileSync(join(worlds, name, 'world.json'), meta);
    if (bodies) writeFileSync(join(worlds, name, 'bodies.json'), bodies);
  };
  world('none', '{"format":"souls/world/1"}');
  world('fork', '{"format":"souls/world/1","fork":true}');
  world('older', '{"format":"souls/world/1"}', cat(h('a')));
  world('other', '{"format":"souls/world/1"}', cat(h('c')));
  writeFileSync(join(etc, 'cutover-binding.json'), JSON.stringify({ schema: 'souls/cutover-binding/2', worlds: [
    { oldWorldId: 'eden-1', canonicalSlug: 'eden', routesFile: '/r.json', clientDir: '/c' },
    { oldWorldId: 'lab-1', canonicalSlug: 'lab', routesFile: '/r.json', clientDir: '/c', v2Bodies: '/elsewhere/' }] }, null, 2));
  const bundled = run(['bundle', out, sha, '0.135', bins, page, client, pkg]);
  assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
  // the directory and origin step has its own test
  const env = { RELEASE_DATA: data, WORLDS_ROOT: join(data, 'worlds'), RELEASE_LIB: lib, RELEASE_ETC: etc, RELEASE_SERVICES: '' };
  const staged = run(['stage', out], env);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const moved = run(['move', sha, 'none'], env);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  const read = (...p) => readFileSync(join(...p), 'utf8');
  assert.equal(read(worlds, 'none/bodies.json'), released);
  assert.equal(read(worlds, 'older/bodies.json'), released);
  assert.equal(read(worlds, 'other/bodies.json'), cat(h('c')));
  assert.throws(() => read(worlds, 'fork/bodies.json'));
  assert.deepEqual(read(deployed).trim().split('\n').sort(), ['fork none', 'none has', 'older has', 'other has']);
  assert.match(moved.stdout, /bodies: other keeps its own catalogue \(this release's does not admit every body it does\)/);
  const binding = JSON.parse(read(etc, 'cutover-binding.json'));
  assert.equal(binding.worlds[0].bodiesDir, join(lib, 'web/assets/bodies'));
  assert.equal(binding.worlds[1].bodiesDir, undefined, 'a world that names its catalogue keeps it');
  assert.equal(read(lib, 'web/assets/bodies/bodies.json'), released);
  assert.match(moved.stdout, /bodies: the binding serves .* for eden; 1 already named a catalogue/);
  // again: nothing changes
  assert.match(run(['bodies', 'binding'], env).stdout, /for no other world; 2 already named a catalogue/);
  const pageHash = /"name":"page.tar","hash":"(1220[0-9a-f]{64})"/.exec(read(data, 'releases', sha, 'manifest.json'))[1];
  assert.match(run(['bodies', 'worlds', join(data, 'worlds/builds', pageHash, 'page.tar')], env).stdout, /bodies: none has this release's catalogue/);
});

test('mailbox: plan shows, apply makes the key once (0600) and adds only the missing flags, a second apply changes nothing', () => {
  const etc = join(dir, 'mailbox-etc'), key = join(etc, 'mailbox.key'), env = { RELEASE_ETC: etc, RELEASE_ACCOUNT: 'nobody-here' };
  const read = (f) => readFileSync(f, 'utf8');
  mkdirSync(etc, { recursive: true });
  assert.match(run(['mailbox', 'plan'], env).stdout, /no directory here .*nothing to set\nchanged: *\n?$/);
  writeFileSync(join(etc, 'directory.args'), 'DIRECTORYD_ARGS="--listen 127.0.0.9:7310 --store /s"\n');
  writeFileSync(join(etc, 'gateway-a.env'), 'GATEWAYD_ARGS=--listen 127.0.0.1:7500 --view-key /v\n', { mode: 0o640 });
  writeFileSync(join(etc, 'gateway-b.env'), 'GATEWAYD_ARGS=--listen 127.0.0.1:7501 --mailbox 127.0.0.1:1 --view-key /v\n');
  const plan = run(['mailbox', 'plan'], env);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /would make .*mailbox\.key \(a new key, 0600\)/);
  assert.match(plan.stdout, /^changed: key directory a b$/m);
  assert.equal(existsSync(key), false, 'a plan changes nothing');
  assert.doesNotMatch(read(join(etc, 'directory.args')), /mailbox/);
  const applied = run(['mailbox', 'apply'], env);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(read(key), /^[0-9a-f]{64}$/);
  assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(read(join(etc, 'directory.args')), `DIRECTORYD_ARGS="--listen 127.0.0.9:7310 --store /s --mailbox-key ${key}"\n`, 'inside its quotes');
  assert.equal(read(join(etc, 'gateway-a.env')), `GATEWAYD_ARGS=--listen 127.0.0.1:7500 --view-key /v --mailbox 127.0.0.9:7310 --mailbox-key ${key}\n`, 'the directory\'s own address');
  assert.equal(read(join(etc, 'gateway-b.env')), `GATEWAYD_ARGS=--listen 127.0.0.1:7501 --mailbox 127.0.0.1:1 --view-key /v --mailbox-key ${key}\n`, 'a flag already there is kept');
  assert.equal(statSync(join(etc, 'gateway-a.env')).mode & 0o777, 0o640, 'the file keeps its mode');
  const first = read(key), again = run(['mailbox', 'apply'], env);
  assert.match(again.stdout, /already have it\nchanged: *\n?$/);
  assert.equal(read(key), first, 'the key is never made again');
  // the check, with no gateway to ask, says so and passes
  rmSync(join(etc, 'gateway-a.env')); rmSync(join(etc, 'gateway-b.env'));
  const checked = run(['mailbox', 'check'], env);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /no gateway here to check/);
});

test('entries: plan lists each world\'s changes and changes nothing; the move stages a world\'s just before its deploy, which takes them, and a failed deploy leaves none', () => {
  const root = join(dir, 'entries'), bins = join(root, 'bins'), page = join(root, 'page'), out = join(root, 'bundle');
  const data = join(root, 'data'), etc = join(root, 'etc'), lib = join(root, 'lib'), worlds = join(data, 'worlds/worlds');
  for (const d of [etc, lib, page]) mkdirSync(d, { recursive: true });
  writeFileSync(join(page, 'index.html'), '<!doctype html>');
  // Stand-in worldd: `entries plan|stage --dir <w> --kinds <k>` says it changes the humanoid, and stage writes "new"
  // as <w>/entries.next. Stand-in deploy: records what it rehearses on and, unless FAIL_DEPLOY, swaps it in as the
  // real one does between the pin and the restart.
  exe(join(bins, 'worldd'), [
    'case "$1" in schemas) exit 0 ;; entries) ;; *) exit 1 ;; esac',
    '[ -d "$6/body" ] || exit 1',
    'echo "ride: a ride line the world prints"',
    'echo "entries: ${4##*/}: change eden:humanoid aaaaaaaaaaaa..bbbbbbbbbbbb (eden.humanoid.json)"',
    'if [ "$2" = stage ]; then mkdir -p "$4/entries.next"; echo new > "$4/entries.next/eden.humanoid.json"; echo "entries: ${4##*/}: 1 staged, 0 unchanged"; fi',
  ].join('\n'));
  exe(join(bins, 'gatewayd'), 'exit 0');
  exe(join(bins, 'directoryd'), 'exit 0');
  const deployed = join(root, 'deployed');
  exe(join(bins, 'deploy'), [
    'f="$WORLDS_ROOT/worlds/$1"',
    `if [ -d "$f/entries.next" ]; then echo "$1 rehearsed $(cat "$f/entries.next/eden.humanoid.json")" >> "${deployed}"; else echo "$1 rehearsed own" >> "${deployed}"; fi`,
    '[ -z "$FAIL_DEPLOY" ] || exit 1',
    'if [ -d "$f/entries.next" ]; then mv "$f/entries" "$f/entries.before"; mv "$f/entries.next" "$f/entries"; fi',
  ].join('\n'));
  exe(join(bins, 'gateway-upgrade'), 'exit 0');
  exe(join(bins, 'world-aside'), 'exit 0');
  exe(join(bins, 'assets-check'), 'exit 0');
  exe(join(bins, 'store-copy'), 'exit 0');
  const client = join(root, 'client'), pkg = join(root, 'pkg');
  for (const d of ['src', 'skill', 'served']) mkdirSync(join(client, d), { recursive: true });
  writeFileSync(join(client, 'served/build.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nconst out = process.argv[process.argv.indexOf('--out') + 1];\nmkdirSync(out, { recursive: true });\nwriteFileSync(out + '/eden.mjs', '// client');\n");
  mkdirSync(pkg, { recursive: true });
  for (const w of ['none', 'up']) {
    mkdirSync(join(worlds, w), { recursive: true });
    writeFileSync(join(worlds, w, 'world.json'), '{"format":"souls/world/1"}');
  }
  mkdirSync(join(worlds, 'up/entries'));
  writeFileSync(join(worlds, 'up/entries/eden.humanoid.json'), 'old\n');
  // a stale staging in a world with no entries is never taken
  mkdirSync(join(worlds, 'none/entries.next'));
  const bundled = run(['bundle', out, sha, '0.136.1', bins, page, client, pkg]);
  assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
  const env = { RELEASE_DATA: data, WORLDS_ROOT: join(data, 'worlds'), RELEASE_LIB: lib, RELEASE_ETC: etc, RELEASE_SERVICES: '' };
  const staged = run(['stage', out], env);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const read = (...p) => readFileSync(join(...p), 'utf8');

  const plan = run(['entries', 'plan', sha], env);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /^entries: none: kept: no entries$/m);
  assert.match(plan.stdout, /^entries: up: change eden:humanoid aaaaaaaaaaaa\.\.bbbbbbbbbbbb/m);
  assert.doesNotMatch(plan.stdout, /ride:/, 'the build\'s own lines are left out');
  assert.equal(read(worlds, 'up/entries/eden.humanoid.json'), 'old\n', 'a plan changes nothing');
  assert.equal(existsSync(join(worlds, 'up/entries.next')), false, 'a plan stages nothing');

  // A failed deploy leaves the world's own entries and nothing staged.
  const failed = run(['move', sha, 'up'], { ...env, FAIL_DEPLOY: '1' });
  assert.equal(failed.status, 3, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /entries: up: 1 staged, 0 unchanged\nmove: deploy up \(the canary\)/);
  assert.equal(read(worlds, 'up/entries/eden.humanoid.json'), 'old\n');
  assert.equal(existsSync(join(worlds, 'up/entries.next')), false);
  assert.deepEqual(read(deployed).trim().split('\n'), ['up rehearsed new'], 'the deploy rehearsed the release\'s entries');

  rmSync(deployed);
  const moved = run(['move', sha, 'up'], env);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.deepEqual(read(deployed).trim().split('\n'), ['up rehearsed new', 'none rehearsed own']);
  assert.equal(read(worlds, 'up/entries/eden.humanoid.json'), 'new\n', 'the deploy took them');
  assert.equal(read(worlds, 'up/entries.before/eden.humanoid.json'), 'old\n', 'the world\'s own kept beside them');
});

// reseed-world.sh (0.133): any moved world fresh from its own facts on a release's build, with stand-ins for the
// host's programs (systemctl, supervisor, deploy, world-aside, worldd) under a scratch folder: the check changes
// nothing, a run sets the old folder and bucket objects aside (nothing deleted), seeds the same facts, pins the build
// (here the one the world is on already, as after an importer fix ships) and brings the world back as it was; a second
// fresh reseed to the same build refuses, and reseed-eden-undo.sh puts the old world back.
//   node --test v2/tools/ops/cutover/reseed-world.test.mjs

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'souls-reseed-world-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const exe = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };

const sha = 'b'.repeat(40);
const world = `${'d'.repeat(32)}-${'e'.repeat(32)}-0`;
const data = join(dir, 'data'), etc = join(dir, 'etc'), lib = join(dir, 'lib'), bin = join(dir, 'bin');
const root = join(data, 'worlds'), rel = join(data, 'releases', sha), bucket = join(dir, 'bucket');
const state = join(dir, 'state');
for (const d of [etc, state, join(bucket, 'live', world), join(rel, 'reseed/kinds')]) mkdirSync(d, { recursive: true });

// systemctl: units' states are files; stop and start change them, and every call is logged.
exe(join(bin, 'systemctl'), `S=${state}; echo "$*" >> $S/systemctl.log; act=$1; shift
for u in "$@"; do case $act in is-active) cat "$S/$u" 2>/dev/null || echo inactive; [ "$(cat "$S/$u" 2>/dev/null)" = active ] || exit 3 ;; stop) echo inactive > "$S/$u" ;; start) echo active > "$S/$u" ;; esac; done`);
// supervisor: a build's hash is 1220 and its sha256; a pin is a file deploy reads.
exe(join(lib, 'supervisor'), `case $1 in hash) if command -v sha256sum > /dev/null; then s=$(sha256sum "$2"); else s=$(shasum -a 256 "$2"); fi; echo "1220$(echo "$s" | cut -c1-64)" ;; pin) echo "$3" > ${state}/pin ;; esac`);
exe(join(rel, 'bin/deploy'), `cat ${state}/pin`);
// world-aside: the bucket's objects of a world are files under live/<world>; --label moves them under aside/<label>/,
// --back moves them home; --dry-run counts.
exe(join(rel, 'bin/world-aside'), `B=${bucket}; w=$1 mode=$2 l=$3
case $mode in --label) from=$B/live/$w to=$B/aside/$l/$w ;; --back) from=$B/aside/$l/$w to=$B/live/$w ;; esac
n=$(ls "$from" 2>/dev/null | wc -l | tr -d ' ')
if [ "\${4:-}" = --dry-run ]; then echo "dry run: $n objects of $w would move; nothing changed"; exit 0; fi
mkdir -p "$to"; for f in $(ls "$from" 2>/dev/null); do cp "$from/$f" "$to/$f" && cmp -s "$from/$f" "$to/$f" && rm "$from/$f"; done
echo "moved $n objects"`);
// worldd seed: a fresh folder from the facts, named for the world, with the arguments it was given.
const worldd = `a="$*"; while [ $# -gt 0 ]; do case $1 in --dir) d=$2; shift ;; esac; shift; done
mkdir -p "$d"; printf '{"format": "souls/world/1", "name": "${world}", "fresh": true}' > "$d/world.json"; echo "$a" > "$d/args"
echo "seeded ${world}"`;
const built = `1220${createHash('sha256').update(`#!/bin/sh\n${worldd}\n`).digest('hex')}`;
exe(join(root, 'builds', built, 'worldd'), worldd);
writeFileSync(join(rel, 'manifest.json'), `{"commit":"${sha}","version":"0.133.9","files":[]}\n{"name":"worldd","hash":"${built}","path":"bin/worldd"}\n`);
writeFileSync(join(rel, 'reseed/kinds/bench.json'), '{"format": "souls-entry/1", "name": "eden:bench"}');

// The world: on the release's build already (the importer fix shipped with it), running, with its facts, its world.json
// (creator and entry point) and three objects in the bucket.
const folder = join(root, 'worlds', world);
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, 'facts.json'), '{"format": "souls/import-eden/1"}');
writeFileSync(join(folder, 'world.json'), `{"format": "souls/world/1", "name": "${world}", "creator": "${'f'.repeat(32)}-1", "entry": [1500, -2500]}`);
writeFileSync(join(folder, 'log'), 'the old log');
for (const k of ['record', 'checkpoint-1', 'part-1']) writeFileSync(join(bucket, 'live', world, k), k);
writeFileSync(join(state, 'pin'), `${built}\n`);
writeFileSync(join(state, `worldd@${world}`), 'active\n');
writeFileSync(join(state, `souls-gateway@${world}`), 'active\n');

const env = { PATH: `${bin}:${process.env.PATH}`, RESEED_DATA: data, RESEED_ETC: etc, RESEED_LIB: lib };
const run = (script, args, extra = {}) => spawnSync('bash', [join(here, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
const unit = u => readFileSync(join(state, `${u}@${world}`), 'utf8').trim();

test('a moved world reseeds fresh from its facts on the build it is on, with everything old set aside', () => {
  assert.equal(run('reseed-world.sh', ['eden', sha, 'check']).status, 2, 'a world is named by its folder');
  assert.equal(run('reseed-world.sh', [world, sha]).status, 2);

  const check = run('reseed-world.sh', [world, sha, 'check'], { RESEED_STAMP: '20261124T200000Z' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /the release +0\.133\.9 at b{40}, its worldd 1220[0-9a-f]{64} \(the build it is on\)/);
  assert.match(check.stdout, /creator +kept \(from world\.json\)/);
  assert.match(check.stdout, /entry point +1\.500,-2\.500 m/);
  assert.match(check.stdout, /3 of the world's objects at their keys/);
  assert.match(check.stdout, /and the world \(it was running\)/);
  assert.match(check.stdout, /check only; nothing changed/);
  assert.ok(existsSync(join(folder, 'log')) && !existsSync(join(root, 'aside')), 'the check changes nothing');

  const done = run('reseed-world.sh', [world, sha, 'run'], { RESEED_STAMP: '20261124T200000Z' });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const aside = join(root, 'aside', `${world}-20261124T200000Z`);
  assert.equal(readFileSync(join(aside, 'log'), 'utf8'), 'the old log', 'the old folder is aside, whole');
  assert.equal(readFileSync(join(aside, 'facts.json'), 'utf8'), '{"format": "souls/import-eden/1"}');
  assert.deepEqual(readdirSync(join(bucket, 'aside/20261124T200000Z', world)).sort(), ['checkpoint-1', 'part-1', 'record']);
  assert.deepEqual(readdirSync(join(bucket, 'live', world)), [], 'the old objects are aside, not deleted');
  assert.match(readFileSync(join(folder, 'world.json'), 'utf8'), /"fresh": true/, 'the fresh seed is in place');
  assert.ok(!existsSync(join(folder, 'log')));
  assert.equal(
    readFileSync(join(folder, 'args'), 'utf8').trim(),
    `seed --facts ${aside}/facts.json --dir ${join(root, 'aside', `.seed-${world}-20261124T200000Z`)} --entries ${rel}/reseed/kinds --souls 0 --at 1.500,-2.500 --creator ${'f'.repeat(32)}-1`,
    'seeded from the same facts, with its creator and entry point',
  );
  assert.equal(readFileSync(join(state, 'pin'), 'utf8').trim(), built);
  assert.equal(unit('worldd'), 'active', 'the world was running, and runs again');
  assert.equal(unit('souls-gateway'), 'active');
  const receipt = readFileSync(join(root, 'aside', `${world}-20261124T200000Z.reseed`), 'utf8');
  assert.match(receipt, new RegExp(`^world=${world}\nold=${built}\nnew=${built}\nlabel=20261124T200000Z\nrunning=yes\nbucket=moved\n$`));
  assert.match(done.stdout, /undo: bash .*reseed-eden-undo\.sh 20261124T200000Z check/);

  // A second fresh reseed to this build is one to resume or undo, not to start again.
  const again = run('reseed-world.sh', [world, sha, 'check'], { RESEED_STAMP: '20261124T210000Z' });
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stderr, /reseed 20261124T200000Z to this build is not undone: resume it/);
  const resumed = run('reseed-world.sh', [world, sha, 'resume', '20261124T200000Z', 'check']);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /steps done +1 stop: no; 2 folder aside: yes; 3 bucket aside: yes; 4-5 fresh seed in place: yes/);

  // The undo (Eden's, which reads the world from the receipt) puts the old world back and sets the fresh one aside.
  const undo = run('reseed-eden-undo.sh', ['20261124T200000Z', 'run'], { RESEED_TOOL: join(rel, 'bin/world-aside') });
  assert.equal(undo.status, 0, undo.stdout + undo.stderr);
  assert.equal(readFileSync(join(folder, 'log'), 'utf8'), 'the old log');
  assert.match(readFileSync(join(root, 'aside', `${world}-20261124T200000Z-fresh`, 'world.json'), 'utf8'), /"fresh": true/);
  assert.deepEqual(readdirSync(join(bucket, 'live', world)).sort(), ['checkpoint-1', 'part-1', 'record']);
  assert.match(readFileSync(join(root, 'aside', `${world}-20261124T200000Z.reseed`), 'utf8'), /\nundone=\d{8}T\d{6}Z\n$/);
  assert.equal(unit('worldd'), 'active');
  // and an undone reseed no longer blocks a fresh one
  assert.equal(run('reseed-world.sh', [world, sha, 'check'], { RESEED_STAMP: '20261124T220000Z' }).status, 0);
});

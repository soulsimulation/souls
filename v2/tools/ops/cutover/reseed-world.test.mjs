// reseed-world.sh (0.133): any moved world fresh from its own facts on a release's build, with stand-ins for the
// host's programs (systemctl, supervisor, deploy, worldd) under a scratch folder: the check changes nothing, a run sets
// the old folder aside, seeds the same facts on a fresh store generation (#4954: not one store object moves), pins the
// build in the fresh world's own record (here the one the world is on already, as after an importer fix ships) and
// brings the world back as it was; a second fresh reseed to the same build refuses, and reseed-eden-undo.sh puts the
// old world back by its folder alone, exactly.
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
// supervisor and deploy: a build's hash is 1220 and its sha256; a world's pin is its record, a file in the bucket at the
// place its folder's store generation names (#4954): live/<world>/record, or g/<label>/live/<world>/record.
const place = `g=$(cat ${root}/worlds/$2/generation 2>/dev/null); if [ -n "$g" ]; then P=${bucket}/g/$g/live/$2; else P=${bucket}/live/$2; fi`;
exe(join(lib, 'supervisor'), `case $1 in hash) if command -v sha256sum > /dev/null; then s=$(sha256sum "$2"); else s=$(shasum -a 256 "$2"); fi; echo "1220$(echo "$s" | cut -c1-64)" ;;
pin) [ -f ${state}/pinfail ] && exit 1; ${place}; mkdir -p "$P"; echo "$3" > "$P/record"; echo "$2" >> ${state}/pins ;;
generation) ${place}; cat ${root}/worlds/$2/generation 2>/dev/null || echo none ;; *) exit 2 ;; esac`);
// (a release's deploy and worldd from #4954 on carry 'generation-bad: ', the refusal of a bad generation file; a world
// with no record is refused as the real deploy refuses it)
exe(join(rel, 'bin/deploy'), `# generation-bad: \n${place}; [ -f "$P/record" ] || { echo "deploy: pin.missing: record-missing: $P/record" >&2; exit 2; }; cat "$P/record"`);
// world-aside, for a reseed before #4954 only: here it must never run.
exe(join(rel, 'bin/world-aside'), `echo "world-aside ran: $*" >> ${state}/aside.log; exit 1`);
// worldd seed: a fresh folder from the facts, named for the world, with the arguments it was given.
const worldd = `# generation-bad: 
a="$*"; while [ $# -gt 0 ]; do case $1 in --dir) d=$2; shift ;; esac; shift; done
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
// #4837: its stock and library, as a seed with --stock kept them: the fresh seed is given them again.
writeFileSync(join(folder, 'stock.json'), '{"format": "souls-world-stock/1", "libraries": {"books": "content/library/books.json"}}');
mkdirSync(join(folder, 'library'));
writeFileSync(join(folder, 'library/books.json'), '{"library": "books", "books": []}');
// The world's objects in the bucket: its record (its pin) and, standing in for Eden's 36,500, a few hundred more.
writeFileSync(join(bucket, 'live', world, 'record'), `${built}\n`);
for (let i = 0; i < 300; i++) writeFileSync(join(bucket, 'live', world, `part-${i}`), `part ${i}`);
// Every object in the bucket and its bytes, to show that none moved or changed.
const objects = (d = bucket, at = '') => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory()
  ? objects(join(d, e.name), `${at}${e.name}/`) : [[`${at}${e.name}`, readFileSync(join(d, e.name), 'utf8')]]);
const old = new Map(objects());
writeFileSync(join(state, `worldd@${world}`), 'active\n');
writeFileSync(join(state, `souls-gateway@${world}`), 'active\n');

const env = { PATH: `${bin}:${process.env.PATH}`, RESEED_DATA: data, RESEED_ETC: etc, RESEED_LIB: lib };
const run = (script, args, extra = {}) => spawnSync('bash', [join(here, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
const unit = u => readFileSync(join(state, `${u}@${world}`), 'utf8').trim();

test('a moved world reseeds fresh from its facts on the build it is on, on a fresh store generation: nothing in the store moves, and the undo is its folder', () => {
  assert.equal(run('reseed-world.sh', ['eden', sha, 'check']).status, 2, 'a world is named by its folder');
  assert.equal(run('reseed-world.sh', [world, sha]).status, 2);

  const check = run('reseed-world.sh', [world, sha, 'check'], { RESEED_STAMP: '20261124T200000Z' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /the release +0\.133\.9 at b{40}, its worldd 1220[0-9a-f]{64} \(the build it is on\)/);
  assert.match(check.stdout, /creator +kept \(from world\.json\)/);
  assert.match(check.stdout, /entry point +1\.500,-2\.500 m/);
  assert.match(check.stdout, /stock +the world's own \(stock\.json, library\/\)/);
  assert.match(check.stdout, /generation +the fresh world's objects under g\/20261124T200000Z\/; the old world's \(at their keys\) stay where they are: none moves/);
  assert.match(check.stdout, /and the world \(it was running\)/);
  assert.match(check.stdout, /check only; nothing changed/);
  assert.ok(existsSync(join(folder, 'log')) && !existsSync(join(root, 'aside')), 'the check changes nothing');

  const done = run('reseed-world.sh', [world, sha, 'run'], { RESEED_STAMP: '20261124T200000Z' });
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const aside = join(root, 'aside', `${world}-20261124T200000Z`);
  assert.equal(readFileSync(join(aside, 'log'), 'utf8'), 'the old log', 'the old folder is aside, whole');
  assert.equal(readFileSync(join(aside, 'facts.json'), 'utf8'), '{"format": "souls/import-eden/1"}');
  assert.match(readFileSync(join(folder, 'world.json'), 'utf8'), /"fresh": true/, 'the fresh seed is in place');
  assert.equal(readFileSync(join(folder, 'generation'), 'utf8'), '20261124T200000Z\n', 'on its own store generation');
  assert.ok(!existsSync(join(aside, 'generation')), 'the old folder names the old place: the keys as they are');
  // #4954: not one object moved or changed; the only new one is the fresh world's record, under g/<label>/.
  const after = new Map(objects());
  for (const [k, v] of old) assert.equal(after.get(k), v, `${k} stayed, with its bytes`);
  assert.deepEqual([...after.keys()].filter(k => !old.has(k)), [`g/20261124T200000Z/live/${world}/record`]);
  assert.ok(!existsSync(join(state, 'aside.log')), 'world-aside never ran');
  assert.ok(!existsSync(join(folder, 'log')));
  assert.equal(
    readFileSync(join(folder, 'args'), 'utf8').trim(),
    `seed --facts ${aside}/facts.json --dir ${join(root, 'aside', `.seed-${world}-20261124T200000Z`)} --entries ${rel}/reseed/kinds --souls 0 --at 1.500,-2.500 --creator ${'f'.repeat(32)}-1 --stock ${aside}/stock.json`,
    'seeded from the same facts, with its creator, entry point and stock (its library beside it)',
  );
  assert.equal(readFileSync(join(bucket, `g/20261124T200000Z/live/${world}/record`), 'utf8').trim(), built, 'pinned in its own record');
  assert.equal(unit('worldd'), 'active', 'the world was running, and runs again');
  assert.equal(unit('souls-gateway'), 'active');
  const receipt = readFileSync(join(root, 'aside', `${world}-20261124T200000Z.reseed`), 'utf8');
  assert.match(receipt, new RegExp(`^world=${world}\nold=${built}\nnew=${built}\nlabel=20261124T200000Z\nrunning=yes\nstore=g/20261124T200000Z/\n$`));
  assert.match(done.stdout, /undo: bash .*reseed-eden-undo\.sh 20261124T200000Z check/);

  // A second fresh reseed to this build is one to resume or undo, not to start again.
  const again = run('reseed-world.sh', [world, sha, 'check'], { RESEED_STAMP: '20261124T210000Z' });
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stderr, /reseed 20261124T200000Z to this build is not undone: resume it/);
  const resumed = run('reseed-world.sh', [world, sha, 'resume', '20261124T200000Z', 'check']);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /steps done +1 stop: no; 2 folder aside: yes; 3-5 fresh seed in place on g\/20261124T200000Z\/: yes/);

  // The undo (Eden's, which reads the world from the receipt) is one step: the old folder back, the fresh one aside,
  // and nothing in the store moved or written; the old world's record and pin are as they were.
  const pins = readFileSync(join(state, 'pins'), 'utf8');
  const undoCheck = run('reseed-eden-undo.sh', ['20261124T200000Z', 'check'], { RESEED_TOOL: join(rel, 'bin/world-aside') });
  assert.equal(undoCheck.status, 0, undoCheck.stdout + undoCheck.stderr);
  assert.match(undoCheck.stdout, /store +nothing moves: the reseed put the fresh world's objects under g\/20261124T200000Z\//);
  const undo = run('reseed-eden-undo.sh', ['20261124T200000Z', 'run'], { RESEED_TOOL: join(rel, 'bin/world-aside') });
  assert.equal(undo.status, 0, undo.stdout + undo.stderr);
  assert.equal(readFileSync(join(folder, 'log'), 'utf8'), 'the old log');
  assert.ok(!existsSync(join(folder, 'generation')));
  assert.match(readFileSync(join(root, 'aside', `${world}-20261124T200000Z-fresh`, 'world.json'), 'utf8'), /"fresh": true/);
  const undone = new Map(objects());
  for (const [k, v] of old) assert.equal(undone.get(k), v, `${k} is as it was`);
  assert.equal(undone.size, old.size + 1, 'only the fresh record, left under g/<label>/');
  assert.equal(readFileSync(join(state, 'pins'), 'utf8'), pins, 'the undo pins nothing: the old record holds the old pin');
  assert.ok(!existsSync(join(state, 'aside.log')), 'world-aside never ran');
  assert.match(readFileSync(join(root, 'aside', `${world}-20261124T200000Z.reseed`), 'utf8'), /\nundone=\d{8}T\d{6}Z\n$/);
  assert.equal(unit('worldd'), 'active');
  // and an undone reseed no longer blocks a fresh one
  assert.equal(run('reseed-world.sh', [world, sha, 'check'], { RESEED_STAMP: '20261124T220000Z' }).status, 0);
});

test('a reseed refuses, changing nothing, when the installed launcher or the release reads no store generation', () => {
  const oldLib = join(dir, 'old-lib');
  exe(join(oldLib, 'supervisor'), `case $1 in hash) ${'exec'} ${join(lib, 'supervisor')} "$@" ;; *) echo "usage: supervisor launch|..." >&2; exit 2 ;; esac`);
  const refused = run('reseed-world.sh', [world, sha, 'check'], { RESEED_LIB: oldLib, RESEED_STAMP: '20261124T230000Z' });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /the installed supervisor .* reads no store generation \(#4954\): install-v2/);
});

test('an undo of a label with no receipt says so (a probe that finds nothing no longer ends it silently under pipefail)', () => {
  const none = run('reseed-eden-undo.sh', ['20990101T000000Z', 'check']);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /no reseed receipt for 20990101T000000Z/);
});

test('a run whose pin failed says resume, and the resume pins the fresh world\'s own record', () => {
  // The store refuses every pin: the run stops at step 6 with the fresh folder in place and no record on its generation.
  // (`sleep` stands in so the reseed's tries again take no time.)
  const fast = join(dir, 'fast');
  exe(join(fast, 'sleep'), 'exit 0');
  const quick = { PATH: `${fast}:${env.PATH}` };
  writeFileSync(join(state, 'pinfail'), '');
  const stopped = run('reseed-world.sh', [world, sha, 'run'], { ...quick, RESEED_STAMP: '20261125T010000Z' });
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stderr, /the pin refused; resume: bash .*reseed-world\.sh \S+ b{40} resume 20261125T010000Z check/);
  assert.equal(readFileSync(join(folder, 'generation'), 'utf8'), '20261125T010000Z\n', 'the fresh folder is in place');
  assert.ok(!existsSync(join(bucket, `g/20261125T010000Z/live/${world}/record`)), 'with no record yet');
  rmSync(join(state, 'pinfail'));

  // The resume it names reads the missing record as not pinned, and runs the pin again.
  const check = run('reseed-world.sh', [world, sha, 'resume', '20261125T010000Z', 'check'], quick);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /pinned now +none \(no record on g\/20261125T010000Z\/ yet: step 6 pins it\)/);
  assert.match(check.stdout, /3-5 fresh seed in place on g\/20261125T010000Z\/: yes/);
  const resumed = run('reseed-world.sh', [world, sha, 'resume', '20261125T010000Z', 'run'], quick);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, /4-5\. the fresh seed: already in place/);
  assert.equal(readFileSync(join(bucket, `g/20261125T010000Z/live/${world}/record`), 'utf8').trim(), built, 'pinned in its own record');
  assert.equal(readFileSync(join(bucket, 'live', world, 'record'), 'utf8').trim(), built, 'the old record as it was');
  assert.equal(unit('worldd'), 'active', 'the world was running, and runs again');
});

// A template published from a seed's public support (`templates`, installed as publish-template) is one the same
// build's `worldd fork --template` accepts: its sealed header's kind pins are the seed's boot pins. The world is a rack
// bay and an upright, kinds whose entries join parts, so their pins follow their entries (0.135): published from the
// facts alone (`import_eden::load`), those pins differed and the fork was refused `template-pins-mismatch` (0.142, the
// Mars camp's rack, shade and loading yards). A world forked from a template has the punts and courses a world seeded
// from the same facts and entries starts with (`worldd::courses`): before, a world made from Eden's template had no
// punts, and its rides and boats no courses. Drives the built programs, as the ops tests do:
//   cargo build -p worldd -p templates && node --test tools/templates/publish.test.mjs   (from v2/)
// The Eden case needs Eden 2026's facts (`node v2/tools/import-eden/export/export.ts` from the repository root, or
// EDEN_FACTS); without them it says so and is skipped, as the Eden tests of `cargo test -p worldd` are ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const V2 = resolve(import.meta.dirname, '../..'), KINDS = resolve(V2, '../content/kinds');
const EDEN = process.env.EDEN_FACTS ? resolve(process.env.EDEN_FACTS) : resolve(V2, '../.local/import-eden/eden-2026.facts.json');
const BIN = join(process.env.CARGO_TARGET_DIR ? resolve(V2, process.env.CARGO_TARGET_DIR) : join(V2, 'target'), 'debug');

/** A rack bay and an upright standing on the ground: no slots in the facts (import-eden's joining fixture). */
const FACTS = {
  format: 'souls/import-eden/1',
  kinds: [
    { ref: 't-bay@1', hash: 'aa', name: 'mars:rack_bay', form: 'point' },
    { ref: 't-upright@1', hash: 'bb', name: 'mars:rack_upright', form: 'point' },
  ],
  things: [
    { id: 'e_bay', def: 't-bay@1', ref: 't-bay@1', parent: null, pose: [0, 0, 0, 0], world: [0, 0, 0, 0], scale_ppm: 1000000 },
    { id: 'e_upright', def: 't-upright@1', ref: 't-upright@1', parent: null, pose: [3000, 0, 0, 0], world: [3000, 0, 0, 0], scale_ppm: 1000000 },
  ],
  doors: [],
  places: [],
  ground: { tileM: 2, tiles: [{ tx: 0, tz: 0, heights: 'AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA', classes: 'AAECAw==' }] },
  bake: { things: 2 },
  byRef: { 't-bay@1': 1, 't-upright@1': 1 },
};

const run = (program, args, timeout = 120_000) => spawnSync(join(BIN, program), args, { encoding: 'utf8', timeout, maxBuffer: 1 << 28 });

/** The things `worldd seed` put on a course, as it printed them: `{ x, z, loop }` (m; the loop's period and start, none for a boat). */
function seededCourses(stdout) {
  const lines = [...new Set(stdout.split('\n'))];
  return lines.flatMap((l) => {
    const m = /^(?:punt|ride|boat): .*? at (-?[\d.]+),(-?[\d.]+) m(?:, plank at \S+ m)?(?:, loop (\d+) us from (\d+) us)?$/.exec(l);
    return m ? [{ x: +m[1], z: +m[2], loop: m[3] && `${m[3]} ${m[4]}` }] : [];
  });
}

/** The things on a course in a world's newest checkpoint (`templates courses`): `{ x, z, loop }`. */
function treeCourses(checkpoints) {
  const r = run('templates', ['courses', checkpoints], 600_000);
  assert.equal(r.status, 0, `courses: ${r.stderr}`);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const m = /^course: \S+ at (-?[\d.]+),(-?[\d.]+) m, loop (\d+) us from (\d+) us$/.exec(l);
    assert.ok(m, l);
    return { x: +m[1], z: +m[2], loop: `${m[3]} ${m[4]}` };
  });
}

/** Each course the seed printed is on a thing of the fork at the same place (to the mm it prints), with the same loop. */
function assertSameCourses(seeded, forked) {
  assert.ok(seeded.length > 0, 'the seed put something on a course');
  const left = [...forked];
  for (const c of seeded) {
    const k = left.findIndex((f) => Math.abs(f.x - c.x) <= 0.0015 && Math.abs(f.z - c.z) <= 0.0015 && (!c.loop || f.loop === c.loop));
    assert.ok(k >= 0, `the forked world has the seeded course at ${c.x},${c.z} m${c.loop ? ` (loop ${c.loop})` : ''}; it has ${forked.length} courses`);
    left.splice(k, 1);
  }
  assert.deepEqual(left, [], 'and no other');
}

/** `worldd seed --souls 0` of `facts` with `entries` (support), `templates` publishing it as `name`, and `worldd fork
 *  --template` of it: the seed's output and the forked world's folder. */
function seedPublishFork(d, facts, entries, name, extra = [], timeout = 120_000) {
  const support = join(d, 'support'), out = join(d, 'out'), forked = join(d, 'forked');
  const seeded = run('worldd', ['seed', '--facts', facts, '--entries', entries, '--souls', '0', ...extra, '--dir', support], timeout);
  assert.equal(seeded.status, 0, `seed: ${seeded.stderr}`);
  const published = run('templates', [facts, out, '--name', name, '--support', support], timeout);
  assert.equal(published.status, 0, `publish: ${published.stderr}`);
  const template = join(out, name);
  const fork = run('worldd', ['fork', '--from', join(template, 'ckpt'), '--template', template, '--to', forked, '--through', `${'ab'.repeat(16)}:1`, '--scope', 'cd'.repeat(16)], timeout);
  assert.equal(fork.status, 0, `fork: ${fork.stderr}`);
  return { seeded: seeded.stdout, forked };
}

test('a template published from a seed forks with the same build, and is never written over', () => {
  for (const p of ['worldd', 'templates']) assert.ok(existsSync(join(BIN, p)), `${join(BIN, p)}: cargo build -p worldd -p templates first`);
  const d = mkdtempSync(join(tmpdir(), 'tpl-publish-'));
  try {
    const facts = join(d, 'facts.json'), entries = join(d, 'entries'), support = join(d, 'support'), out = join(d, 'out');
    writeFileSync(facts, JSON.stringify(FACTS));
    mkdirSync(entries);
    for (const f of readdirSync(join(KINDS, 'construction')).filter((f) => f.endsWith('.json'))) copyFileSync(join(KINDS, 'construction', f), join(entries, f));
    copyFileSync(join(KINDS, 'body/humanoid.json'), join(entries, 'humanoid.json'));

    const seeded = run('worldd', ['seed', '--facts', facts, '--entries', entries, '--souls', '0', '--at', '0,0', '--dir', support]);
    assert.equal(seeded.status, 0, `seed: ${seeded.stderr}`);

    const published = run('templates', [facts, out, '--name', 'yard', '--support', support]);
    assert.equal(published.status, 0, `publish: ${published.stderr}`);
    assert.match(published.stdout, /^template yard: lineage [0-9a-f]{32}/);
    for (const f of ['template', 'header', 'boot', 'facts.json', 'entry.json', 'ckpt']) assert.ok(existsSync(join(out, 'yard', f)), f);
    assert.ok(existsSync(join(out, 'yard.source')), 'its source checkpoint beside it');
    assert.ok(!existsSync(join(out, '.yard.partial')), 'renamed into place when whole');
    const again = run('templates', [facts, out, '--name', 'yard', '--support', support]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /template-exists/);
    assert.match(run('templates', [facts, out, '--name', 'Yard', '--support', support]).stderr, /template-name-invalid/);

    const template = join(out, 'yard'), forked = join(d, 'forked');
    const fork = run('worldd', ['fork', '--from', join(template, 'ckpt'), '--template', template, '--to', forked, '--through', `${'ab'.repeat(16)}:1`, '--scope', 'cd'.repeat(16)]);
    assert.equal(fork.status, 0, `fork: ${fork.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(forked, 'world.json'), 'utf8')).fork, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a world forked from a template has the courses a seeded world starts with', () => {
  const d = mkdtempSync(join(tmpdir(), 'tpl-courses-'));
  try {
    // The yard with Eden's balloon beside it: a ride that flies a loop from its stop, so the world gives it a course.
    const facts = join(d, 'facts.json'), entries = join(d, 'entries');
    writeFileSync(facts, JSON.stringify({
      ...FACTS,
      kinds: [...FACTS.kinds, { ref: 't-balloon@1', hash: 'cc', name: 'eden:balloon', form: 'point' }],
      things: [...FACTS.things, { id: 'e_balloon', def: 't-balloon@1', ref: 't-balloon@1', parent: null, pose: [-3000, 0, 0, 0], world: [-3000, 0, 0, 0], scale_ppm: 1000000, name: 'balloon-1' }],
      bake: { things: 3 },
      byRef: { ...FACTS.byRef, 't-balloon@1': 1 },
    }));
    mkdirSync(entries);
    for (const f of readdirSync(join(KINDS, 'construction')).filter((f) => f.endsWith('.json'))) copyFileSync(join(KINDS, 'construction', f), join(entries, f));
    copyFileSync(join(KINDS, 'body/humanoid.json'), join(entries, 'humanoid.json'));
    copyFileSync(join(KINDS, 'rides/balloon.json'), join(entries, 'balloon.json'));
    const { seeded, forked } = seedPublishFork(d, facts, entries, 'yard', ['--at', '0,0']);
    const want = seededCourses(seeded);
    assert.equal(want.length, 1, `the seed gives the balloon its course: ${seeded}`);
    assertSameCourses(want, treeCourses(join(forked, 'checkpoints')));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a world forked from the published eden-2026 has a seeded Eden\'s punts and courses', { skip: !existsSync(EDEN) && `no Eden 2026 facts at ${EDEN}` }, () => {
  const d = mkdtempSync(join(tmpdir(), 'tpl-eden-'));
  try {
    const { seeded, forked } = seedPublishFork(d, EDEN, KINDS, 'eden-2026', [], 1_800_000);
    const want = seededCourses(seeded);
    assert.ok(want.some((c) => c.loop) && want.length > 1, `Eden's seed puts punts and rides on courses: ${want.length}`);
    assertSameCourses(want, treeCourses(join(forked, 'checkpoints')));
    console.log(`eden-2026: ${want.length} things on a course in the seed and in the forked world`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

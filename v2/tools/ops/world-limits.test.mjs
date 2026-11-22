// #4013 follow-up (#1960): world-limits.json becomes each placed world's limits.conf, and nothing else changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HEADER, apply, changes, parseConfig, render } from './world-limits.mjs';

const script = fileURLToPath(new URL('./world-limits.mjs', import.meta.url));
const repoConfig = fileURLToPath(new URL('./units/world-limits.json', import.meta.url));
const EDEN = `${'a'.repeat(32)}-${'b'.repeat(32)}-0`, SMALL = `${'c'.repeat(32)}-${'d'.repeat(32)}-0`;
const UNITS = '/etc/systemd/system';
const dropin = (i) => `${UNITS}/worldd@${i}.service.d/limits.conf`;

function machine() {
  const root = mkdtempSync(join(tmpdir(), '4013-limits-'));
  const authority = { format: 'souls/world-authority/1', worlds: { eden: { instance: EDEN }, small: { instance: SMALL } } };
  mkdirSync(join(root, 'etc/souls/placement-data'), { recursive: true });
  writeFileSync(join(root, 'etc/souls/placement-data/authority.json'), JSON.stringify(authority));
  // Both placed: place-world.sh made their drop-in folders.
  for (const i of [EDEN, SMALL]) mkdirSync(join(root, `${UNITS}/worldd@${i}.service.d`), { recursive: true });
  return { root, authority };
}

test("the repo's config gives Eden 8G and a 600 s start bound, and no other world anything", () => {
  const worlds = parseConfig(readFileSync(repoConfig, 'utf8'));
  assert.deepEqual(Object.keys(worlds), ['eden']);
  assert.equal(render('eden', worlds.eden), `${HEADER} (world eden); edit that file, not this one.\n[Service]\nMemoryMax=8G\nEnvironment=WORLD_START_WITHIN_S=600\n`);
});

test('bad limits are refused by name', () => {
  const c = (w) => JSON.stringify({ format: 'souls/world-limits/1', worlds: w });
  assert.throws(() => parseConfig(c({ eden: { memory_max: '8 G' } })), /memory_max/);
  assert.throws(() => parseConfig(c({ eden: { memory_max: '8G;x' } })), /memory_max/);
  assert.throws(() => parseConfig(c({ eden: { start_within_s: 0 } })), /start_within_s/);
  assert.throws(() => parseConfig(c({ eden: { CPUQuota: '50%' } })), /unknown limit CPUQuota/);
  assert.throws(() => parseConfig(c({ 'Eden!': {} })), /not a slug/);
  assert.throws(() => parseConfig(JSON.stringify({ worlds: {} })), /souls\/world-limits\/1/);
});

test("apply writes the listed, placed world's drop-in, then has nothing to do; an unlisted world gets none", () => {
  const { root, authority } = machine();
  try {
    const worlds = parseConfig(readFileSync(repoConfig, 'utf8'));
    const first = changes(worlds, authority, root);
    assert.deepEqual(first.map((c) => [c.op, c.path]), [['file', dropin(EDEN)]]);
    apply(first, root);
    assert.match(readFileSync(join(root, dropin(EDEN)), 'utf8'), /^MemoryMax=8G$/m);
    assert.equal(existsSync(join(root, dropin(SMALL))), false);
    assert.deepEqual(changes(worlds, authority, root), []);
    // A world registered but not placed here gets nothing.
    rmSync(join(root, `${UNITS}/worldd@${EDEN}.service.d`), { recursive: true });
    assert.deepEqual(changes(worlds, authority, root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a changed cap is rewritten, a world taken off the list loses its own file, a hand-written file is refused', () => {
  const { root, authority } = machine();
  try {
    apply(changes({ eden: { memory_max: '8G' }, small: { memory_max: '3G' } }, authority, root), root);
    const next = changes({ eden: { memory_max: '10G' } }, authority, root);
    assert.deepEqual(next.map((c) => [c.op, c.path]), [['file', dropin(EDEN)], ['remove', dropin(SMALL)]]);
    apply(next, root);
    assert.match(readFileSync(join(root, dropin(EDEN)), 'utf8'), /^MemoryMax=10G$/m);
    assert.equal(existsSync(join(root, dropin(SMALL))), false);
    // A limits.conf it did not write (O1's runs write their own) is never overwritten or removed.
    writeFileSync(join(root, dropin(SMALL)), '[Service]\nMemoryMax=1G\n');
    assert.deepEqual(changes({ eden: { memory_max: '10G' } }, authority, root), []);
    assert.throws(() => changes({ small: { memory_max: '3G' } }, authority, root), /not written by world-limits/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the command plans without writing and applies once', () => {
  const { root } = machine();
  try {
    const run = (mode) => execFileSync(process.execPath, [script, mode, '--config', repoConfig, '--root', root], { encoding: 'utf8' });
    assert.equal(run('plan'), `file ${dropin(EDEN)} (eden: MemoryMax=8G Environment=WORLD_START_WITHIN_S=600)\n`);
    assert.equal(existsSync(join(root, dropin(EDEN))), false);
    assert.equal(run('apply'), `file ${dropin(EDEN)} (eden: MemoryMax=8G Environment=WORLD_START_WITHIN_S=600)\n`);
    assert.equal(run('plan'), '');
    // A machine with no authority map yet (a fresh install's plan) has nothing to do.
    rmSync(join(root, 'etc/souls'), { recursive: true });
    assert.equal(run('plan'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

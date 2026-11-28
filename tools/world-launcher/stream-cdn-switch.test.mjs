// #4159: the stream CDN switch edits only the named world's v2StreamOrigin, in either binding form, and keeps the file's mode.
//   node --test tools/world-launcher/stream-cdn-switch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIRST_LOAD_CDN, STREAM_CDN, switched } from './stream-cdn-switch.mjs';

const one = { oldWorldId: 'eden-1', canonicalSlug: 'eden', routesFile: '/x/routes.json', clientDir: '/x/client' };
const two = { schema: 'souls/cutover-binding/2', worlds: [one, { ...one, oldWorldId: 'mars-1', canonicalSlug: 'mars' }] };

test('on sets, off removes, only the named world; an unknown slug is refused', () => {
  assert.equal(switched(one, 'eden', true).v2StreamOrigin, STREAM_CDN);
  assert.deepEqual(switched(switched(one, 'eden', true), 'eden', false), one);
  const on = switched(two, 'eden', true);
  assert.deepEqual(on.worlds.map((w) => w.v2StreamOrigin ?? null), [STREAM_CDN, null]);
  assert.deepEqual(switched(on, 'eden', false), two);
  assert.throws(() => switched(two, 'nowhere', true), /no world nowhere/);
});

test('#4986: --first-load switches firstLoadOrigin and leaves the stream switch as it was', () => {
  const both = switched(switched(two, 'eden', true), 'eden', true, 'firstLoadOrigin');
  assert.deepEqual(both.worlds.map((w) => [w.v2StreamOrigin ?? null, w.firstLoadOrigin ?? null]), [[STREAM_CDN, FIRST_LOAD_CDN], [null, null]]);
  assert.equal(FIRST_LOAD_CDN, 'https://cdn.soul.game');
  assert.deepEqual(switched(both, 'eden', false, 'firstLoadOrigin'), switched(two, 'eden', true));
  assert.throws(() => switched(two, 'eden', true, 'clientDir'), /no switch for clientDir/);
});

test('the command: the file rewritten whole with its mode, the old one kept beside it', () => {
  const scratch = new URL('../../.local/', import.meta.url).pathname;
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'stream-cdn-switch-')), file = join(dir, 'cutover-binding.json');
  try {
    writeFileSync(file, JSON.stringify(two), { mode: 0o640 });
    const run = (mode) => execFileSync(process.execPath, [new URL('./stream-cdn-switch.mjs', import.meta.url).pathname, '--binding', file, 'eden', mode], { encoding: 'utf8' });
    assert.equal(JSON.parse(run('on')).v2StreamOrigin, STREAM_CDN);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).worlds[0].v2StreamOrigin, STREAM_CDN);
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.equal(JSON.parse(run('off')).v2StreamOrigin, undefined);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), two);
    assert.equal(readdirSync(dir).filter((n) => n.includes('.bak.')).length >= 1, true);
    // started through a link, as production's /srv/sim-worlds/production is: it still runs
    const link = join(dir, 'linked-switch.mjs');
    symlinkSync(new URL('./stream-cdn-switch.mjs', import.meta.url).pathname, link);
    assert.equal(JSON.parse(execFileSync(process.execPath, [link, '--binding', file, 'eden', 'on'], { encoding: 'utf8' })).v2StreamOrigin, STREAM_CDN);
    const first = JSON.parse(execFileSync(process.execPath, [link, '--binding', file, '--first-load', 'eden', 'on'], { encoding: 'utf8' }));
    assert.deepEqual([first.v2StreamOrigin, first.firstLoadOrigin], [STREAM_CDN, FIRST_LOAD_CDN]);
    assert.equal(JSON.parse(execFileSync(process.execPath, [link, '--binding', file, '--first-load', 'eden', 'off'], { encoding: 'utf8' })).firstLoadOrigin, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

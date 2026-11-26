// #4159: the stream CDN switch edits only the named world's v2StreamOrigin, in either binding form, and keeps the file's mode.
//   node --test tools/world-launcher/stream-cdn-switch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_CDN, switched } from './stream-cdn-switch.mjs';

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

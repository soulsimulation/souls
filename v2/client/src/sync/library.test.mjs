// The library by build hash (Engine v2 R5, #2699): A4 and A5. Run: node --test v2/client/src/sync/
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildHash, load, run } from './library.mjs';

const HEAD = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
// (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
const ADD = new Uint8Array([
  ...HEAD,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
// (func (export "spin") (loop (br 0))): never returns.
const SPIN = new Uint8Array([
  ...HEAD,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b,
]);
// (import "env" "fetch" (func)): asks for a way out.
const FETCH = new Uint8Array([
  ...HEAD,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x02, 0x0d, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x05, 0x66, 0x65, 0x74, 0x63, 0x68, 0x00, 0x00,
]);

async function dir() {
  return mkdtemp(join(tmpdir(), 'souls-r5-'));
}

test('A4: a build is downloaded once, checked, cached and then loaded from the cache', async () => {
  const cache = await dir();
  const build = buildHash(ADD);
  let downloads = 0;
  const download = async () => {
    downloads += 1;
    return ADD;
  };
  const first = await load({ build, cache, download });
  assert.deepEqual([first.from, first.downloaded], ['download', ADD.length]);
  const second = await load({ build, cache, download });
  assert.deepEqual([second.from, second.downloaded, downloads], ['cache', 0, 1]);
  await rm(cache, { recursive: true });
});

test('A4: a wrong file is refused by name and never cached', async () => {
  const cache = await dir();
  const build = buildHash(ADD);
  const wrong = Uint8Array.from(ADD);
  wrong[wrong.length - 2] = 0x6b; // i32.add -> i32.sub
  await assert.rejects(load({ build, cache, download: async () => wrong }), { code: 'checker-not-the-build' });
  await assert.rejects(readFile(join(cache, `${build}.wasm`)), { code: 'ENOENT' });
  // A cached file that went bad is downloaded again, not used.
  await writeFile(join(cache, `${build}.wasm`), wrong);
  const got = await load({ build, cache, download: async () => ADD });
  assert.equal(got.from, 'download');
  await rm(cache, { recursive: true });
});

test('A4: not WASM, or a module with imports, is refused by name', async () => {
  const cache = await dir();
  const text = new TextEncoder().encode('not wasm');
  await assert.rejects(load({ build: buildHash(text), cache, download: async () => text }), { code: 'checker-not-wasm' });
  await assert.rejects(load({ build: buildHash(FETCH), cache, download: async () => FETCH }), {
    code: 'checker-has-imports',
  });
  await rm(cache, { recursive: true });
});

test('A5: another build runs in a worker, with nothing to import', async () => {
  assert.equal(await run(ADD, buildHash(ADD), 'add', [2, 3]), 5);
  assert.deepEqual(await run(ADD, buildHash(ADD), null), ['add']);
  assert.throws(() => run(FETCH, buildHash(FETCH), null), { code: 'checker-has-imports' });
});

test('A5: a build that never returns is ended at its time limit, and this thread keeps running', async () => {
  const t0 = performance.now();
  let ticks = 0;
  const clock = setInterval(() => (ticks += 1), 10);
  await assert.rejects(run(SPIN, buildHash(SPIN), 'spin', [], { ms: 200 }), { code: 'checker-timed-out' });
  clearInterval(clock);
  const ms = performance.now() - t0;
  assert.ok(ms >= 200 && ms < 2000, `${ms} ms`);
  assert.ok(ticks >= 5, `the main thread ran ${ticks} ticks while the worker spun`);
});

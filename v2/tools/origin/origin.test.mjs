// A1 of Engine v2 V2 (#2711): the origin's headers on a part, on the pointer and on a 404, as
// v2/docs/viewer-cache.md states them. Run: node --test v2/tools/origin/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createOrigin } from './origin.mjs';

const stream = 'ab12/cd-1/0/ef-2/0/everyone';
const part = Buffer.from([0xa1, 0x01, 0x07]);
let dir;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'v2-origin-'));
  mkdirSync(join(dir, stream), { recursive: true });
  writeFileSync(join(dir, stream, '7'), part);
  writeFileSync(join(dir, stream, '8.tmp'), part);
  writeFileSync(join(dir, stream, 'pointer'), Buffer.from([0xa0]));
  ({ server } = createOrigin(dir));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}/${stream}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a part is public, kept a year, immutable, not transformed, with its SHA-256 as a strong ETag', async () => {
  const r = await fetch(`${base}/7`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable, no-transform');
  assert.equal(r.headers.get('etag'), `"${createHash('sha256').update(part).digest('hex')}"`);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), part);
});

test('the pointer is kept for half a period, rounded up to the one whole second max-age can say', async () => {
  const r = await fetch(`${base}/pointer`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=1, no-transform');
});

test('every 404 is no-store: a part not yet written, a temporary file, a query string, a path outside', async () => {
  for (const path of [`${base}/8`, `${base}/8.tmp`, `${base}/7?x=1`, `${base}/../../../../../../etc/hosts`]) {
    const r = await fetch(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
  }
});

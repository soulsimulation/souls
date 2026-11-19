// A1 of Engine v2 V2 (#2711): the origin's headers on a part, on the pointer and on a 404, as
// v2/docs/viewer-cache.md states them. Run: node --test v2/tools/origin/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
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

test('W18: installed origin config allowlists public fields, refuses missing/mismatched config and public test keys', async () => {
  const auth = {
    AUTH_PROVIDER: 'clerk', CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from('clerk.example.test$').toString('base64')}`,
    CLERK_ISSUER_URL: 'https://clerk.example.test', CLERK_SATELLITE_DOMAIN: 'world.example.test', CLERK_SIGN_IN_URL: 'https://primary.example.test/sign-in',
    BACKEND_KEY: 'never-public', SESSION_TOKEN: 'never-public', ACCOUNT: 'never-public',
  };
  const { server: s } = createOrigin(dir, { auth });
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  const at = `http://127.0.0.1:${s.address().port}/v1/auth/config`;
  try {
    const r = await fetch(at);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await r.json(), { authProvider: 'clerk', clerkPublishableKey: auth.CLERK_PUBLISHABLE_KEY, clerkIssuer: auth.CLERK_ISSUER_URL, clerkSatellite: { domain: auth.CLERK_SATELLITE_DOMAIN, signInUrl: auth.CLERK_SIGN_IN_URL } });
    assert.equal(await (await fetch(at, { method: 'HEAD' })).text(), '');
    assert.equal((await fetch(at, { method: 'POST' })).status, 405);
    auth.CLERK_ISSUER_URL = 'https://other.example.test';
    assert.equal((await fetch(at)).status, 503);
    auth.CLERK_ISSUER_URL = 'https://clerk.example.test';
    auth.CLERK_PUBLISHABLE_KEY = auth.CLERK_PUBLISHABLE_KEY.replace('pk_live_', 'pk_test_');
    assert.equal((await fetch(at)).status, 200);
    const publicStatus = await new Promise((ok, fail) => get(at, { headers: { host: 'world.example.test' } }, r => { r.resume(); ok(r.statusCode); }).on('error', fail));
    assert.equal(publicStatus, 503);
    auth.AUTH_PROVIDER = '';
    const absent = await fetch(at);
    assert.equal(absent.status, 503);
    assert.match((await absent.json()).message, /Sign-in is not configured/);
  } finally { s.close(); }
});

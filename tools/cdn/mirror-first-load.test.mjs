// #4986: the first-load mirror reads only the page and its two versioned replica files, stores only their two keys,
// never overwrites, and refuses bytes that do not hash to the version their path names.
//   node --test tools/cdn/mirror-first-load.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { check, namedReplica, plan, store } from './mirror-first-load.mjs';

const JS = Buffer.from('export default async function init() {}\n'.repeat(40)), WASM = Buffer.from('\0asm' + 'w'.repeat(4000));
const V = createHash('sha256').update(JS).update(WASM).digest('hex').slice(0, 16), sha = (b) => createHash('sha256').update(b).digest('hex');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const html = (config) => `<!doctype html><html><head><script>window.__simConfig=${JSON.stringify(config)}</script></head></html>`;

/** A stand-in origin: the page and the launcher's versioned replica; every other path is recorded and refused. */
function origin({ version = V, wasm = WASM, cacheControl = IMMUTABLE } = {}) {
  const asked = [];
  const fetcher = async (url) => {
    const u = new URL(url); asked.push(u.pathname);
    if (u.pathname === '/w/eden/') return new Response(html({ worldKey: 'eden', v2Replica: `/w/eden/v2/replica/${version}/replica.js` }));
    if (u.pathname === `/w/eden/v2/replica/${version}/replica.js`) return new Response(JS, { headers: { 'cache-control': cacheControl } });
    if (u.pathname === `/w/eden/v2/replica/${version}/replica_bg.wasm`) return new Response(wasm, { headers: { 'cache-control': cacheControl } });
    return new Response('no', { status: 404 });
  };
  return { fetcher, asked };
}
/** A stand-in bucket speaking the three requests the mirror makes. */
function bucket(objects = new Map()) {
  const log = [];
  const fetcher = async (url, init) => {
    const key = new URL(url).pathname.replace(/^\/[^/]+\//, ''); log.push(`${init.method} ${key}`);
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 /);
    const o = objects.get(key);
    const headers = o && { 'content-type': o.type, 'cache-control': o.cache, 'content-encoding': 'br', 'x-amz-meta-sha256': o.sha };
    if (init.method === 'HEAD') return new Response(null, o ? { status: 200, headers } : { status: 404 });
    if (init.method === 'PUT') {
      if (o) return new Response(null, { status: 412 });
      assert.equal(init.headers['if-none-match'], '*');
      objects.set(key, { body: brotliDecompressSync(init.body), type: init.headers['content-type'], cache: init.headers['cache-control'], sha: init.headers['x-amz-meta-sha256'] });
      return new Response(null, { status: 200 });
    }
    const { 'content-encoding': _, ...plain } = headers ?? {};   // the real fetch decodes br and keeps the header; this one hands the file over
    return o ? Object.defineProperty(new Response(o.body, { status: 200, headers: plain }), 'headers', { value: new Headers(headers) }) : new Response(null, { status: 404 });
  };
  return { fetcher, log, objects };
}
const credentials = { accessKeyId: 'test-key', secretAccessKey: 'test-secret' };

test('the plan: the page, then exactly its two versioned replica files, hashed to the version', async () => {
  const o = origin(), p = await plan('https://soul.game/w/eden/', { fetcher: o.fetcher });
  assert.deepEqual(o.asked, ['/w/eden/', `/w/eden/v2/replica/${V}/replica.js`, `/w/eden/v2/replica/${V}/replica_bg.wasm`]);
  assert.equal(p.version, V);
  assert.deepEqual(p.objects.map((x) => [x.key, x.contentType, x.sha256]), [[`assets/replica/${V}/replica.js`, 'text/javascript; charset=utf-8', sha(JS)], [`assets/replica/${V}/replica_bg.wasm`, 'application/wasm', sha(WASM)]]);
  assert.deepEqual(brotliDecompressSync(p.objects[1].encoded), WASM);
});

test('refused before anything is stored: no versioned replica named, another host or path named, stale or changed bytes', async () => {
  for (const v2Replica of [undefined, '/w/eden/replica.js', 'https://elsewhere.example/w/eden/v2/replica/0123456789abcdef/replica.js', '/w/eden/v1/config', '/w/eden/v2/replica/0123456789abcdef/../../v1/config', '/__sim/worlds.json'])
    assert.throws(() => namedReplica(html({ v2Replica })), /names no versioned replica/, String(v2Replica));
  assert.throws(() => namedReplica('<html></html>'), /names no versioned replica/);
  await assert.rejects(plan('https://soul.game/w/eden/', { fetcher: origin({ cacheControl: 'no-store' }).fetcher }), /not the launcher's current version/);
  await assert.rejects(plan('https://soul.game/w/eden/', { fetcher: origin({ wasm: Buffer.from('other bytes') }).fetcher }), /hashes to [0-9a-f]{16}, not the/);
  await assert.rejects(plan('http://soul.game/w/eden/', { fetcher: origin().fetcher }), /https/);
});

test('store: written once with the immutable headers and read back; a second run finds them; other bytes at a key stop it', async () => {
  const p = await plan('https://soul.game/w/eden/', { fetcher: origin().fetcher }), b = bucket();
  const first = await store(p, { credentials, fetcher: b.fetcher });
  assert.deepEqual(first.results.map((r) => [r.key, r.disposition, r.verified]), [[`assets/replica/${V}/replica.js`, 'uploaded', true], [`assets/replica/${V}/replica_bg.wasm`, 'uploaded', true]]);
  assert.deepEqual([...b.objects.keys()], [`assets/replica/${V}/replica.js`, `assets/replica/${V}/replica_bg.wasm`], 'only the two replica keys');
  for (const o of b.objects.values()) assert.equal(o.cache, IMMUTABLE);
  assert.equal(JSON.stringify(first).includes('test-secret'), false);
  const again = await store(p, { credentials, fetcher: b.fetcher });
  assert.deepEqual(again.results.map((r) => r.disposition), ['existing', 'existing']);
  assert.equal(b.log.filter((l) => l.startsWith('PUT')).length, 2, 'never written twice');
  const taken = bucket(new Map([[`assets/replica/${V}/replica.js`, { body: Buffer.from('x'), type: 'text/javascript; charset=utf-8', cache: IMMUTABLE, sha: sha(Buffer.from('x')) }]]));
  await assert.rejects(store(p, { credentials, fetcher: taken.fetcher }), /refusing to overwrite/);
  assert.equal(taken.log.some((l) => l.startsWith('PUT')), false);
  await assert.rejects(store({ ...p, objects: [{ ...p.objects[0], key: 'assets/replica/../../w/eden/v1/config' }] }, { credentials, fetcher: b.fetcher }), /not a replica key/);
  await assert.rejects(store({ ...p, objects: [{ ...p.objects[0], key: 'assets/replica/0000000000000000/replica.js' }] }, { credentials, fetcher: b.fetcher }), /not a replica key/);
});

test('check: the CDN copy as a browser on the page gets it', async () => {
  const p = await plan('https://soul.game/w/eden/', { fetcher: origin().fetcher });
  const cdn = (patch = {}) => async (url, init) => {
    assert.equal(init.headers.origin, 'https://soul.game');
    const o = p.objects.find((x) => url.endsWith(x.key));
    return new Response(patch.body ?? o.body, { status: patch.status ?? 200, headers: { 'content-type': o.contentType, 'cache-control': IMMUTABLE, 'access-control-allow-origin': 'https://soul.game', 'cf-cache-status': 'HIT', ...patch.headers } });
  };
  assert.deepEqual((await check(p, { fetcher: cdn() })).map((r) => [r.url, r.problems]), p.objects.map((o) => [`https://cdn.soul.game/${o.key}`, []]));
  assert.match((await check(p, { fetcher: cdn({ headers: { 'access-control-allow-origin': 'https://elsewhere.example' } }) }))[0].problems[0], /not readable from https:\/\/soul\.game/);
  assert.match((await check(p, { fetcher: cdn({ headers: { 'content-type': 'application/octet-stream' } }) }))[1].problems[0], /content-type/);
  assert.deepEqual((await check(p, { fetcher: cdn({ body: 'other' }) }))[0].problems, ['bytes differ from the origin']);
  assert.deepEqual((await check(p, { fetcher: cdn({ status: 404, body: '' }) }))[0].problems, ['status 404']);
});

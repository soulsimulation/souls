// #4986: the first-load mirror reads only the page, its two versioned replica files, the launcher's file list and the
// listed build files; stores only their keys; never overwrites; refuses bytes that do not hash to what names them; and
// writes a set's marker only after every file of the set. No API or per-user path can be read or stored (A3).
//   node --test tools/cdn/mirror-first-load.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { allowedKey, check, mirror, namedReplica, plan, planApp, store } from './mirror-first-load.mjs';
import { APP_FILES, setOf } from '../world-launcher/app-files.mjs';

const JS = Buffer.from('export default async function init() {}\n'.repeat(40)), WASM = Buffer.from('\0asm' + 'w'.repeat(4000));
const V = createHash('sha256').update(JS).update(WASM).digest('hex').slice(0, 16), sha = (b) => createHash('sha256').update(b).digest('hex');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const html = (config) => `<!doctype html><html><head><script>window.__simConfig=${JSON.stringify(config)}</script></head></html>`;
const BUILD = { 'main-Dqe4hDOV.js': Buffer.from('import "./vendor-V87T1nx1.js";\n'.repeat(30)), 'vendor-V87T1nx1.js': Buffer.from('export const three = 3;\n'.repeat(50)), 'main-DeE5v0m5.css': Buffer.from('.a{color:red}\n'.repeat(20)),
  'kind-looks-BgoB7tkf.json': Buffer.from('{"looks":[]}'), 'sim-icon-32-45d4ec648f.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'wind-CPqJ2r_O.mp3': Buffer.from('ID3 sound') };
const listOf = (build) => { const files = Object.entries(build).map(([name, body]) => ({ name, bytes: body.length, sha256: sha(body) })); return { schema: APP_FILES, set: setOf(files), files }; };

/** A stand-in origin: the page, the launcher's versioned replica, its file list and build files; every other path is recorded and refused. */
function origin({ version = V, wasm = WASM, cacheControl = IMMUTABLE, build = BUILD, list = listOf(build), listStatus = 200 } = {}) {
  const asked = [];
  const fetcher = async (url) => {
    const u = new URL(url); asked.push(u.pathname);
    if (u.pathname === '/w/eden/') return new Response(html({ worldKey: 'eden', v2Replica: `/w/eden/v2/replica/${version}/replica.js` }));
    if (u.pathname === `/w/eden/v2/replica/${version}/replica.js`) return new Response(JS, { headers: { 'cache-control': cacheControl } });
    if (u.pathname === `/w/eden/v2/replica/${version}/replica_bg.wasm`) return new Response(wasm, { headers: { 'cache-control': cacheControl } });
    if (u.pathname === '/__sim/app-files.json') return new Response(JSON.stringify(list), { status: listStatus });
    const file = /^\/assets\/([^/]+)$/.exec(u.pathname)?.[1];
    if (file && build[file]) return new Response(build[file], { headers: { 'cache-control': cacheControl } });
    return new Response('no', { status: 404 });
  };
  return { fetcher, asked };
}
/** A stand-in bucket speaking the three requests the mirror makes. */
function bucket(objects = new Map(), { failPut = null } = {}) {
  const log = [];
  const fetcher = async (url, init) => {
    const key = new URL(url).pathname.replace(/^\/[^/]+\//, ''); log.push(`${init.method} ${key}`);
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 /);
    const o = objects.get(key);
    const headers = o && { 'content-type': o.type, 'cache-control': o.cache, ...(o.br ? { 'content-encoding': 'br' } : {}), 'x-amz-meta-sha256': o.sha };
    if (init.method === 'HEAD') return new Response(null, o ? { status: 200, headers } : { status: 404 });
    if (init.method === 'PUT') {
      if (o) return new Response(null, { status: 412 });
      if (failPut === key) return new Response(null, { status: 500 });
      assert.equal(init.headers['if-none-match'], '*');
      const br = init.headers['content-encoding'] === 'br';
      objects.set(key, { body: br ? brotliDecompressSync(init.body) : Buffer.from(init.body), br, type: init.headers['content-type'], cache: init.headers['cache-control'], sha: init.headers['x-amz-meta-sha256'] });
      return new Response(null, { status: 200 });
    }
    // the real fetch decodes br and keeps the header; this one hands the file over with the stored object's headers
    return o ? Object.defineProperty(new Response(o.body, { status: 200 }), 'headers', { value: new Headers(headers) }) : new Response(null, { status: 404 });
  };
  return { fetcher, log, objects };
}
const credentials = { accessKeyId: 'test-key', secretAccessKey: 'test-secret' };

test('A3: the only keys it writes are the versioned replica, a hashed build file and a set marker', () => {
  for (const key of [`assets/replica/${V}/replica.js`, `assets/replica/${V}/replica_bg.wasm`, 'assets/app/main-Dqe4hDOV.js', 'assets/app/main-DeE5v0m5.css', 'assets/app/sim-icon-32-45d4ec648f.png', `assets/app/sets/${'a'.repeat(32)}.json`]) assert.equal(allowedKey(key), true, key);
  for (const key of ['assets/app/index.html', 'assets/app/config.json', 'assets/app/../w/eden/v1/config', 'assets/app/sets/x.json', 'assets/app/sub/main-Dqe4hDOV.js', 'w/eden/v1/config', 'assets/replica/latest/replica.js',
    `assets/replica/${V}/other.js`, 'assets/app/worlds.json', 'assets/app/main-Dqe4hDOV.html', '__sim/worlds.json', 'assets/aa/' + 'a'.repeat(64) + '.glb']) assert.equal(allowedKey(key), false, key);
});

test('the replica plan: the page, then exactly its two versioned replica files, hashed to the version', async () => {
  const o = origin(), p = await plan('https://soul.game/w/eden/', { fetcher: o.fetcher });
  assert.deepEqual(o.asked, ['/w/eden/', `/w/eden/v2/replica/${V}/replica.js`, `/w/eden/v2/replica/${V}/replica_bg.wasm`]);
  assert.equal(p.version, V);
  assert.deepEqual(p.objects.map((x) => [x.key, x.contentType, x.sha256, x.encoding]), [[`assets/replica/${V}/replica.js`, 'text/javascript; charset=utf-8', sha(JS), 'br'], [`assets/replica/${V}/replica_bg.wasm`, 'application/wasm', sha(WASM), 'br']]);
  assert.deepEqual(brotliDecompressSync(p.objects[1].stored), WASM);
});

test('the replica is refused before anything is stored: none named, another host or path named, stale or changed bytes', async () => {
  for (const v2Replica of [undefined, '/w/eden/replica.js', 'https://elsewhere.example/w/eden/v2/replica/0123456789abcdef/replica.js', '/w/eden/v1/config', '/w/eden/v2/replica/0123456789abcdef/../../v1/config', '/__sim/worlds.json'])
    assert.throws(() => namedReplica(html({ v2Replica })), /names no versioned replica/, String(v2Replica));
  assert.throws(() => namedReplica('<html></html>'), /names no versioned replica/);
  await assert.rejects(plan('https://soul.game/w/eden/', { fetcher: origin({ cacheControl: 'no-store' }).fetcher }), /not an immutable answer/);
  await assert.rejects(plan('https://soul.game/w/eden/', { fetcher: origin({ wasm: Buffer.from('other bytes') }).fetcher }), /hashes to [0-9a-f]{16}, not the/);
  await assert.rejects(plan('http://soul.game/w/eden/', { fetcher: origin().fetcher }), /https/);
});

test('the web build plan: the launcher\'s list, then exactly the listed files, each the bytes the list names, the marker last', async () => {
  const o = origin(), p = await planApp('https://soul.game/w/eden/', { fetcher: o.fetcher }), list = listOf(BUILD);
  assert.deepEqual(o.asked, ['/__sim/app-files.json', ...Object.keys(BUILD).map((n) => `/assets/${n}`)], 'nothing else of the origin is read');
  assert.equal(p.set, list.set);
  assert.deepEqual(p.objects.map((x) => [x.key, x.encoding ?? 'identity']), [...Object.keys(BUILD).map((n) => [`assets/app/${n}`, /\.(js|css|json)$/.test(n) ? 'br' : 'identity']), [`assets/app/sets/${list.set}.json`, 'identity']]);
  assert.deepEqual(JSON.parse(p.objects.at(-1).body), list);
  assert.equal(await planApp('https://soul.game/w/eden/', { fetcher: origin({ listStatus: 404 }).fetcher }), null, 'an older launcher: no list, nothing to do');
  // a list naming anything but a hashed build file, a list that does not hash to its id, a file that differs, a file not immutable
  for (const name of ['../w/eden/v1/config', 'index.html', 'config.json', 'sub/main-Dqe4hDOV.js', '/w/eden/v1/world/snapshot']) {
    const files = [...listOf(BUILD).files, { name, bytes: 1, sha256: 'a'.repeat(64) }];
    await assert.rejects(planApp('https://soul.game/w/eden/', { fetcher: origin({ list: { schema: APP_FILES, set: setOf(files), files } }).fetcher }), /not a build file/, name);
  }
  await assert.rejects(planApp('https://soul.game/w/eden/', { fetcher: origin({ list: { ...list, set: '0'.repeat(32) } }).fetcher }), /does not hash to its set id/);
  await assert.rejects(planApp('https://soul.game/w/eden/', { fetcher: origin({ list, build: { ...BUILD, 'vendor-V87T1nx1.js': Buffer.from('changed') } }).fetcher }), /not the file the list names/);
  await assert.rejects(planApp('https://soul.game/w/eden/', { fetcher: origin({ cacheControl: 'no-cache' }).fetcher }), /not an immutable answer/);
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
  const taken = bucket(new Map([[`assets/replica/${V}/replica.js`, { body: Buffer.from('x'), br: true, type: 'text/javascript; charset=utf-8', cache: IMMUTABLE, sha: sha(Buffer.from('x')) }]]));
  await assert.rejects(store(p, { credentials, fetcher: taken.fetcher }), /refusing to overwrite/);
  assert.equal(taken.log.some((l) => l.startsWith('PUT')), false);
  await assert.rejects(store({ ...p, objects: [{ ...p.objects[0], key: 'assets/replica/../../w/eden/v1/config' }] }, { credentials, fetcher: b.fetcher }), /not a first-load key/);
  await assert.rejects(store({ ...p, objects: [{ ...p.objects[0], key: 'assets/replica/0000000000000000/replica.js' }] }, { credentials, fetcher: b.fetcher }), /not a replica key of this version/);
});

test('store, a web build: every file, then the marker; a failure before the end leaves no marker; unchanged files of the next release are found', async () => {
  const p = await planApp('https://soul.game/w/eden/', { fetcher: origin().fetcher }), b = bucket();
  const receipt = await store(p, { credentials, fetcher: b.fetcher });
  assert.equal(receipt.set, p.set);
  assert.deepEqual([...b.objects.keys()], [...Object.keys(BUILD).map((n) => `assets/app/${n}`), `assets/app/sets/${p.set}.json`]);
  assert.equal(b.objects.get('assets/app/main-DeE5v0m5.css').type, 'text/css; charset=utf-8'); assert.equal(b.objects.get('assets/app/sim-icon-32-45d4ec648f.png').br, false);
  assert.deepEqual(b.objects.get('assets/app/vendor-V87T1nx1.js').body, BUILD['vendor-V87T1nx1.js']);
  // a file that cannot be stored stops the run before the marker
  const broken = bucket(new Map(), { failPut: 'assets/app/main-DeE5v0m5.css' });
  await assert.rejects(store(p, { credentials, fetcher: broken.fetcher }), /PUT failed \(500\)/);
  assert.equal([...broken.objects.keys()].some((k) => k.startsWith('assets/app/sets/')), false, 'no marker over a partial set');
  await assert.rejects(store({ ...p, objects: [p.objects.at(-1), ...p.objects.slice(0, -1)] }, { credentials, fetcher: bucket().fetcher }), /marker must be last/);
  // the next release: main changed, vendor did not. Only the new files and the new marker are written
  const nextBuild = { ...BUILD, 'main-AAAAbbbb.js': Buffer.from('next main') }; delete nextBuild['main-Dqe4hDOV.js'];
  const next = await planApp('https://soul.game/w/eden/', { fetcher: origin({ build: nextBuild }).fetcher }), before = b.log.length;
  const second = await store(next, { credentials, fetcher: b.fetcher });
  assert.notEqual(next.set, p.set);
  assert.deepEqual(second.results.filter((r) => r.disposition === 'uploaded').map((r) => r.key), ['assets/app/main-AAAAbbbb.js', `assets/app/sets/${next.set}.json`]);
  assert.equal(b.log.slice(before).filter((l) => l.startsWith('PUT')).length, 2);
  // the same file name with other bytes (it should never happen): refused, and that release keeps loading from the origin
  const clash = await planApp('https://soul.game/w/eden/', { fetcher: origin({ build: { ...BUILD, 'vendor-V87T1nx1.js': Buffer.from('other vendor') } }).fetcher });
  await assert.rejects(store(clash, { credentials, fetcher: b.fetcher }), /refusing to overwrite assets\/app\/vendor-V87T1nx1\.js/);
  assert.equal(b.objects.has(`assets/app/sets/${clash.set}.json`), false);
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

test('mirror: a web build\'s marker is written only after its files pass the CDN check, never before', async () => {
  const p = await planApp('https://soul.game/w/eden/', { fetcher: origin().fetcher }), markerKey = `assets/app/sets/${p.set}.json`;
  const run = async (acao) => {
    const b = bucket(), order = [];
    const fetcher = async (url, init) => { order.push(`${init.method} ${new URL(url).pathname.replace(/^\/[^/]+\//, '')}`); return b.fetcher(url, init); };
    const cdnFetcher = async (url) => {
      const o = p.objects.find((x) => url.endsWith(x.key)); order.push(`CDN ${o.key}`);
      return new Response(o.body, { status: 200, headers: { 'content-type': o.contentType, 'cache-control': IMMUTABLE, 'access-control-allow-origin': acao } });
    };
    return { ...(await mirror(p, { credentials, fetcher, cdnFetcher })), order, b };
  };
  const good = await run('https://soul.game');
  assert.equal(good.marked, true); assert.deepEqual(good.wrong, []);
  const markerFirst = good.order.indexOf(`HEAD ${markerKey}`), lastFileCheck = good.order.lastIndexOf(`CDN assets/app/${Object.keys(BUILD).at(-1)}`);
  assert.ok(lastFileCheck >= 0 && lastFileCheck < markerFirst, 'every file is checked on the CDN before the marker is touched');
  assert.equal(good.order.at(-1), `CDN ${markerKey}`, 'then the marker itself is checked');
  assert.equal(good.receipt.results.at(-1).key, markerKey);
  // the CDN serves the files wrong for the page (CORS): the files are stored, the marker is not, pages stay on the host
  const bad = await run('https://elsewhere.example');
  assert.equal(bad.marked, false); assert.equal(bad.receipt.ok, false);
  assert.equal(bad.wrong.length, Object.keys(BUILD).length);
  assert.equal(bad.b.objects.has(markerKey), false);
  assert.equal(bad.order.some((l) => l.includes('assets/app/sets/')), false, 'the marker is never asked for');
});

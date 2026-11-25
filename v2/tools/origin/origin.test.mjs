// A1 of Engine v2 V2 (#2711): the origin's headers on a part, on the pointer and on a 404, as
// v2/docs/viewer-cache.md states them. Run: node --test v2/tools/origin/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, get } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createOrigin } from './origin.mjs';
import { readWorldRoutes } from './world-routes.mjs';
import { localAddresses, worldAddress } from '../../web/src/source/address.ts';
import { updateWorldRoute } from '../ops/proxy/route-config.mjs';
import { makeRoutes } from '../ops/proxy/routes.mjs';
import { pairAddress, worldOf } from '../../client/src/cli/souls.mjs';
import { canonicalRows } from '../../web/src/home/list.ts';

const stream = 'ab12/cd-1/0/ef-2/0/everyone';
const part = Buffer.from([0xa1, 0x01, 0x07]);
let dir;
let server;
let base;

before(async () => {
  const scratch = fileURLToPath(new URL('../../../.local/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, 'v2-origin-'));
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

test('O19b: trusted world metadata exposes only public bootstrap, isolates worlds, and refuses unsafe targets/requests', async () => {
  const file = join(dir, 'world-routes.json');
  const worlds = { eden: { gateway: 'http://127.0.0.1:1', stream: '/s/eden/', history: '/s/history/eden/', canonical: true }, other: { gateway: 'http://127.0.0.1:2', stream: '/s/other/', canonical: true } };
  const write = () => writeFileSync(file, JSON.stringify({ schema: 'souls/world-routes/1', worlds }));
  write();
  assert.deepEqual(Object.keys(readWorldRoutes(file)), ['eden', 'other']);
  const { server: s } = createOrigin(dir, { worldRoutes: file });
  await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  const at = `http://127.0.0.1:${s.address().port}`;
  try {
    for (const prefix of ['', '/preview']) for (const name of ['eden', 'other']) {
      const path = `${prefix}/w/${name}`, r = await fetch(`${at}${path}/v1/bootstrap`), body = await r.json();
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(body.world, name); assert.equal(body.stream, `/s/${name}/`);
      assert.equal(body.directory, '/'); assert.equal(body.gateway, `${path}/v2/ws`); assert.equal(body.creatorToken, `${path}/v2/creator-token`);
      assert.ok(!JSON.stringify(body).includes('127.0.0.1'));
      assert.equal(await (await fetch(`${at}${path}/v1/bootstrap`, { method: 'HEAD' })).text(), '');
    }
    assert.equal((await fetch(`${at}/w/missing/v1/bootstrap`)).status, 404);
    assert.equal((await fetch(`${at}/w/eden/v1/bootstrap?gateway=http://untrusted.example.test`)).status, 400);
    assert.equal((await fetch(`${at}/w/eden/v2/creator-token`, { method: 'POST', headers: { origin: 'https://untrusted.example.test' } })).status, 403);
    const publicTest = await new Promise((ok, fail) => get(`${at}/w/eden/v1/bootstrap`, { headers: { host: 'world.example.test', authorization: 'Bearer test:owner' } }, r => { r.resume(); ok(r.statusCode); }).on('error', fail));
    assert.equal(publicTest, 403);
    worlds.eden.canonical = false; write();
    assert.equal((await fetch(`${at}/w/eden/v1/bootstrap`)).status, 404);
    assert.equal((await fetch(`${at}/w/eden/v2/creator-token`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${at}/preview/w/eden/v1/bootstrap`)).status, 200);
    worlds.eden.canonical = true;
    const credentialTarget = new URL('http://127.0.0.1'); credentialTarget.username = 'fixture';
    for (const gateway of ['https://127.0.0.1', 'http://untrusted.example.test', credentialTarget.href, 'http://127.0.0.1/other', 'http://127.0.0.1?target=x', 'http://127.0.0.1#x']) {
      worlds.eden.gateway = gateway; write();
      assert.throws(() => readWorldRoutes(file));
      assert.equal((await fetch(`${at}/w/eden/v1/bootstrap`)).status, 503);
    }
  } finally { s.close(); }
});

test('O19b: coordinated metadata updates preserve other worlds and only explicitly active listed worlds enter canonical routing', async () => {
  const file = join(dir, 'placement-routes.json'), out = join(dir, 'routes');
  await updateWorldRoute(file, 'eden', { gateway: 'http://127.0.0.1:1', stream: '/s/eden/' });
  await Promise.all([
    updateWorldRoute(file, 'eden', { canonical: true }),
    updateWorldRoute(file, 'new-town', { gateway: 'http://127.0.0.1:2', stream: '/s/new-town/', canonical: true }),
  ]);
  let value = readWorldRoutes(file);
  assert.equal(value.eden.stream, '/s/eden/'); assert.equal(value.eden.canonical, true); assert.equal(value['new-town'].canonical, true);
  const fetchImpl = async url => new Response(url.endsWith('/v1/worlds') ? JSON.stringify({ worlds: [{ name: 'eden' }, { name: 'new-town' }, { name: 'unmapped' }] }) : '<?xml version="1.0"?><urlset></urlset>');
  const options = { directory: 'https://directory.example.test', launcher: 'https://today.example.test', origin: 'https://world.example.test', worldRoutes: file, out, fetchImpl };
  assert.deepEqual((await makeRoutes(options)).slugs, ['eden', 'new-town']);
  await updateWorldRoute(file, 'eden', { canonical: false });
  assert.deepEqual((await makeRoutes(options)).slugs, ['new-town']);
  value = readWorldRoutes(file);
  assert.equal(value.eden.gateway, 'http://127.0.0.1:1'); assert.equal(value['new-town'].canonical, true);
});

test('O19b: browser canonical and preview locations use same-origin bootstrap, ignoring public endpoint queries', async () => {
  for (const prefix of ['', '/preview']) {
    const base = `${prefix}/w/eden`, href = `https://world.example.test${base}/?directory=https://untrusted.example.test&gateway=wss://untrusted.example.test`;
    let asked;
    const get = async (url, options) => {
      asked = { url, options };
      return new Response(JSON.stringify({ world: 'eden', stream: '/s/eden/', directory: '/', gateway: `${base}/v2/ws`, creatorToken: `${base}/v2/creator-token` }));
    };
    const address = await worldAddress(href, get);
    assert.equal(asked.url, `https://world.example.test${base}/v1/bootstrap`);
    assert.equal(asked.options.redirect, 'error'); assert.equal(asked.options.credentials, 'omit');
    assert.equal(address.stream, 'https://world.example.test/s/eden/');
    assert.equal(address.directory, 'https://world.example.test'); assert.equal(address.gateway, `wss://world.example.test${base}/v2/ws`);
    await assert.rejects(worldAddress(href, async () => new Response(JSON.stringify({ world: 'eden', stream: '/s/eden/', directory: 'https://untrusted.example.test', gateway: `${base}/v2/ws`, creatorToken: `${base}/v2/creator-token` }))));
  }
  assert.equal(await worldAddress('https://world.example.test/'), null);
  assert.deepEqual(localAddresses('https://world.example.test/?directory=https://untrusted.example.test&gateway=wss://untrusted.example.test'), { directory: null, gateway: null });
  assert.deepEqual(localAddresses('http://localhost:9/?directory=http://localhost:8&gateway=ws://localhost:7/v2/ws'), { directory: 'http://localhost:8', gateway: 'ws://localhost:7/v2/ws' });
  assert.throws(() => localAddresses('http://localhost:9/?directory=https://untrusted.example.test'));
  assert.throws(() => localAddresses('http://localhost:9/?gateway=ws://untrusted.example.test/v2/ws'));
});

test('O19b: canonical pairing confirms its same-origin bootstrap and refuses a foreign bearer destination', async () => {
  assert.deepEqual(worldOf('https://world.example.test/w/eden/?gateway=wss://untrusted.example.test/v2/ws'), { directory: 'https://world.example.test', world: 'eden', gateway: 'wss://world.example.test/w/eden/v2/ws' });
  assert.deepEqual(worldOf('https://world.example.test/preview/w/new-town/'), { directory: 'https://world.example.test', world: 'new-town', gateway: 'wss://world.example.test/preview/w/new-town/v2/ws' });
  assert.throws(() => worldOf('http://localhost:9/local?gateway=wss://untrusted.example.test/v2/ws'), { code: 'pair-names-a-world' });
  const url = 'https://world.example.test/w/eden/';
  let asked;
  const get = async (address, options) => { asked = { address, options }; return new Response(JSON.stringify({ world: 'eden', directory: '/', gateway: '/w/eden/v2/ws' })); };
  assert.deepEqual(await pairAddress(url, get), worldOf(url));
  assert.equal(asked.address, `${url}v1/bootstrap`);
  assert.equal(asked.options.redirect, 'error');
  await assert.rejects(pairAddress(url, async () => new Response(JSON.stringify({ world: 'eden', directory: 'https://untrusted.example.test', gateway: '/w/eden/v2/ws' }))), { code: 'pair-world-routing' });
  await assert.rejects(pairAddress(url, async () => new Response(null, { status: 404 })), { code: 'pair-world-routing' });
});

test('O19b: home keeps today during preview and advertises only valid canonical bootstrap rows', async () => {
  const directory = { worlds: [{ name: 'eden' }, { name: 'preview-only' }, { name: 'new-town' }] };
  const today = { worlds: [{ slug: 'eden', name: 'Eden today' }] };
  const get = async url => {
    const world = /\/w\/([^/]+)/.exec(url)[1];
    if (world !== 'new-town') return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ world, stream: `/s/${world}/`, directory: '/', gateway: `/w/${world}/v2/ws`, creatorToken: `/w/${world}/v2/creator-token` }));
  };
  const listed = await canonicalRows(directory, today, 'https://world.example.test', get);
  assert.deepEqual(listed.map(w => [w.slug, w.system]), [['new-town', 'v2'], ['eden', 'today']]);
  assert.equal(listed.some(w => w.slug === 'preview-only'), false);
});

test('W17 archived canonical and preview endpoints refuse and address markers survive without sitemap entry',async()=>{
  const file=join(dir,'archived-routes.json'),out=join(dir,'archived-map');
  await updateWorldRoute(file,'garden',{gateway:'http://127.0.0.1:1',stream:'/s/w/instance/views/',canonical:true});
  const initial=readWorldRoutes(file).garden;
  await updateWorldRoute(file,'garden',{archived:true},{expected:initial});
  const {server:s}=createOrigin(dir,{worldRoutes:file});await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const at=`http://127.0.0.1:${s.address().port}`;
  try {
    for(const prefix of ['', '/preview'])for(const tail of ['v1/bootstrap','views/world.json','v2/creator-token']) {
      const response=await fetch(`${at}${prefix}/w/garden/${tail}`);assert.equal(response.status,410);assert.equal((await response.json()).refused,'world-archived');
    }
    const options={directory:'https://directory.example.test',launcher:'https://today.example.test',origin:'https://world.example.test',worldRoutes:file,out,
      fetchImpl:async url=>new Response(url.endsWith('/v1/worlds')?'{}':'<?xml version="1.0"?><urlset><url><loc>https://world.example.test/w/garden/</loc></url><url><loc>https://world.example.test/about</loc></url></urlset>')};
    assert.deepEqual((await makeRoutes(options)).slugs,['garden']);
    assert.ok(existsSync(join(out,'slugs/garden')));assert.ok(!readFileSync(join(out,'sitemap.xml'),'utf8').includes('/w/garden/'));
    await assert.rejects(updateWorldRoute(file,'garden',{archived:false},{expected:{...initial,gateway:'http://127.0.0.1:2'}}),/occupied/);
    assert.equal(readWorldRoutes(file).garden.archived,true);
    await updateWorldRoute(file,'garden',{archived:false});
    assert.deepEqual((await makeRoutes(options)).slugs,['garden'],'restoring or unlisted canonical address remains routed before the row becomes public');
  }finally{s.close();}
});


test('V9b: only public history/live refreshes its cache and strong ETag across epoch changes', async () => {
  const folder = join(dir, 'w', 'native-instance', 'history');
  mkdirSync(folder, { recursive: true });
  const url = `${new URL(base).origin}/w/native-instance/history/live`;
  const first = JSON.stringify({ format: 'souls/history-live/1', world: 'native-instance', lineage: 'ab'.repeat(16), stream: '../views/epoch-7/' });
  const next = first.replace('epoch-7', 'epoch-8');
  writeFileSync(join(folder, 'live'), first);
  const a = await fetch(url);
  assert.equal(a.status, 200); assert.equal(await a.text(), first);
  assert.equal(a.headers.get('cache-control'), 'public, max-age=1, no-transform');
  const old = a.headers.get('etag');
  assert.equal(old, `"${createHash('sha256').update(first).digest('hex')}"`);
  writeFileSync(join(folder, 'live'), next);
  const b = await fetch(url, { headers: { 'if-none-match': old } });
  assert.equal(b.status, 200); assert.equal(await b.text(), next);
  assert.equal(b.headers.get('cache-control'), 'public, max-age=1, no-transform');
  assert.equal(b.headers.get('etag'), `"${createHash('sha256').update(next).digest('hex')}"`);
  assert.notEqual(b.headers.get('etag'), old);
  writeFileSync(join(dir, 'live'), first);
  assert.equal((await fetch(`${new URL(base).origin}/live`)).headers.get('cache-control'), 'public, max-age=31536000, immutable, no-transform');
  assert.equal((await fetch(`${url}.tmp`)).status, 404);
});

test('V4: a day\'s event index is served at the day\'s URL, as a file or beside its split hours as `day`', async () => {
  const events = join(dir, 'w', 'split-instance', 'history', 'history', 'everyone', 'events');
  mkdirSync(join(events, '00020781'), { recursive: true });
  writeFileSync(join(events, '00020781', 'day'), 'day index');
  writeFileSync(join(events, '00020781', '05'), 'hour five');
  writeFileSync(join(events, '00020782'), 'whole day');
  const at = `${new URL(base).origin}/w/split-instance/history/history/everyone/events/`;
  const get = async (p) => { const r = await fetch(at + p); return [r.status, await r.text()]; };
  assert.deepEqual(await get('00020781'), [200, 'day index']);
  assert.deepEqual(await get('00020781/05'), [200, 'hour five']);
  assert.deepEqual(await get('00020782'), [200, 'whole day']);
  assert.equal((await get('00020783'))[0], 404);
});

test('C1 (#3673) A3: a browser asking for an unknown page gets a 404 "No page here" linking home; programs and APIs keep theirs', async () => {
  const at = base.slice(0, base.indexOf('/', 'http://'.length)), html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
  for (const path of ['/nope', '/l/old-lab', '/w/eden/nope', '/preview/w/eden/no/such/page', '/nope?x=1', '/w/eden/%3Cb%3E']) {
    const r = await fetch(`${at}${path}`, { headers: html }), body = await r.text();
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8', path);
    assert.equal(r.headers.get('cache-control'), 'no-store', path);
    assert.match(body, /<h1>No page here<\/h1>/, path);
    assert.match(body, /<a href="\/">See the worlds<\/a>/, path);
    assert.ok(!body.includes('<b>'), 'the path is escaped');
    const head = await fetch(`${at}${path}`, { method: 'HEAD', headers: html });
    assert.equal(head.status, 404);
    assert.equal(await head.text(), '');
  }
  // A program (no text/html in Accept) and the API paths keep their empty or JSON 404s.
  for (const [path, headers] of [['/nope', {}], [`/${stream}/8`, {}], ['/v1/nope', html], ['/w/eden/v1/nope', html], ['/s/nope', html], ['/preview/w/eden/v2/x', html]]) {
    const r = await fetch(`${at}${path}`, { headers });
    assert.equal(r.status, 404, path);
    assert.notEqual(r.headers.get('content-type'), 'text/html; charset=utf-8', path);
    assert.equal(await r.text(), '', path);
  }
  // A world route's own refusal stays JSON.
  const routed = await fetch(`${at}/w/missing/v1/bootstrap`, { headers: html });
  assert.equal(routed.headers.get('content-type'), 'application/json');
});

test('#4018: concurrent requests for one immutable file share one read and one buffer; a replaced or removed file answers as on disk', async () => {
  const big = Buffer.alloc(4 << 20, 7), name = join(dir, stream, '9');
  writeFileSync(name, big);
  for (const cacheBytes of [64 << 20, 0]) {
    const { server: s, stats } = createOrigin(dir, {}, { cacheBytes });
    await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${s.address().port}/${stream}/9`;
    try {
      // as they are: an encoded body's length is its own (the test after this one)
      const rs = await Promise.all(Array.from({ length: 40 }, () => fetch(url, { headers: { 'accept-encoding': 'identity' } })));
      for (const r of rs) {
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('etag'), `"${createHash('sha256').update(big).digest('hex')}"`);
        assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable, no-transform');
        assert.equal(r.headers.get('content-length'), String(big.length));
        assert.ok(big.equals(Buffer.from(await r.arrayBuffer())));
      }
      assert.equal(stats.reads, 1, `40 concurrent requests read the file once (cacheBytes ${cacheBytes})`);
      assert.equal(stats.immutable, 40);
      await fetch(url).then((r) => r.arrayBuffer());
      if (cacheBytes) assert.equal(stats.reads, 1, 'a held file is not read again');
      const other = Buffer.from([1, 2, 3]);
      writeFileSync(`${name}.tmp`, other);
      renameSync(`${name}.tmp`, name);
      const r = await fetch(url);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), other);
      assert.equal(r.headers.get('etag'), `"${createHash('sha256').update(other).digest('hex')}"`);
      rmSync(name);
      const gone = await fetch(url);
      assert.equal(gone.status, 404);
      assert.equal(gone.headers.get('cache-control'), 'no-store');
      writeFileSync(name, big);
    } finally {
      s.close();
    }
  }
  rmSync(name);
});

const raw = (url, headers = {}) => new Promise((ok, no) => get(url, { headers }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c)).on('end', () => ok({ res, body: Buffer.concat(chunks) }));
}).on('error', no));
const packable = Buffer.from(Array.from({ length: 4000 }, (_, i) => `node ${i % 97} at ${i % 13}\n`).join(''));

test('a large immutable file goes br, else gzip, to a reader that takes it; as it is to one that does not; its ETag is the decoded bytes\' hash', async () => {
  writeFileSync(join(dir, stream, 'big'), packable);
  const etag = `"${createHash('sha256').update(packable).digest('hex')}"`;
  const br = await raw(`${base}/big`, { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(br.res.headers['content-encoding'], 'br');
  assert.equal(br.res.headers.vary, 'accept-encoding');
  assert.equal(br.res.headers.etag, `W/${etag}`, 'an encoded copy\'s tag is weak');
  assert.equal(br.res.headers['cache-control'], 'public, max-age=31536000, immutable, no-transform');
  assert.equal(Number(br.res.headers['content-length']), br.body.length);
  assert.ok(br.body.length < packable.length / 4);
  assert.deepEqual(brotliDecompressSync(br.body), packable);
  const gz = await raw(`${base}/big`, { 'accept-encoding': 'gzip, br;q=0' });
  assert.equal(gz.res.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(gz.body), packable);
  const plain = await raw(`${base}/big`);
  assert.equal(plain.res.headers['content-encoding'], undefined);
  assert.equal(plain.res.headers.vary, 'accept-encoding');
  assert.equal(plain.res.headers.etag, etag, 'the bytes as they are keep the strong tag');
  assert.deepEqual(plain.body, packable);
  const small = await raw(`${base}/7`, { 'accept-encoding': 'br' });
  assert.equal(small.res.headers['content-encoding'], undefined);
  assert.deepEqual(small.body, part);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/big`)).arrayBuffer()), packable); // fetch decodes it
});

test('one Range gets those bytes of the decoded file (206), never encoded; an invalid one is ignored (200); a range past the end is a no-store 416', async () => {
  writeFileSync(join(dir, stream, 'big'), packable);
  const head = await raw(`${base}/big`, { range: 'bytes=0-15', 'accept-encoding': 'br' });
  assert.equal(head.res.statusCode, 206);
  assert.equal(head.res.headers['content-range'], `bytes 0-15/${packable.length}`);
  assert.equal(head.res.headers['content-encoding'], undefined);
  assert.deepEqual(head.body, packable.subarray(0, 16));
  assert.deepEqual((await raw(`${base}/big`, { range: 'bytes=-4' })).body, packable.subarray(-4));
  const invalid = await raw(`${base}/big`, { range: 'bytes=5-3' });
  assert.equal(invalid.res.statusCode, 200);
  assert.deepEqual(invalid.body, packable);
  const past = await raw(`${base}/big`, { range: `bytes=${packable.length}-` });
  assert.equal(past.res.statusCode, 416);
  assert.equal(past.res.headers['cache-control'], 'no-store');
  assert.equal(past.res.headers['content-range'], `bytes */${packable.length}`);
});

test('a viewer that takes nothing for stallMs is let go; a slow one that keeps taking finishes; an idle keep-alive stays', async () => {
  const big = Buffer.alloc(16 << 20, 3), name = join(dir, stream, '10');
  writeFileSync(name, big);
  const { server: s, stats } = createOrigin(dir, {}, { stallMs: 300 });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const port = s.address().port, path = `/${stream}/10`;
  try {
    // Asks for 16 MB and never reads: the origin closes it, rather than holding the socket and its buffer for as long
    // as the reader stays connected.
    // (The paused reader cannot see its socket close, so this watches the origin's side.)
    const c = connect(port, '127.0.0.1', () => { c.pause(); c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`); });
    c.on('error', () => {});
    const connections = () => new Promise((ok) => s.getConnections((_, n) => ok(n)));
    const t0 = Date.now();
    while (Date.now() - t0 < 3000 && (stats.stalled < 1 || (await connections()) > 0)) await new Promise((ok) => setTimeout(ok, 50));
    c.destroy();
    assert.equal(stats.stalled, 1, 'a stalled reader is let go');
    assert.equal(await connections(), 0, 'and its connection is closed');
    // Reads 16 MB a slice at a time with a pause after each, taking far longer than stallMs in all: never let go.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const t1 = Date.now();
    const body = await new Promise((ok, no) => {
      get({ port, host: '127.0.0.1', path, agent }, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); res.pause(); setTimeout(() => res.resume(), 2); });
        res.on('end', () => ok(Buffer.concat(chunks)));
        res.on('error', no);
      }).on('error', no);
    });
    assert.ok(Date.now() - t1 > 300, `the slow read took longer than stallMs (${Date.now() - t1} ms)`);
    assert.ok(big.equals(body), 'the slow reader got every byte');
    assert.equal(stats.stalled, 1);
    // Idle past stallMs between requests: the connection is kept (keepAliveTimeout governs idle, not stallMs).
    await new Promise((ok) => setTimeout(ok, 600));
    const reused = await new Promise((ok, no) => {
      const r = get({ port, host: '127.0.0.1', path: `/${stream}/7`, agent }, (res) => { res.resume(); res.on('end', () => ok(r.reusedSocket)); });
      r.on('error', no);
    });
    assert.equal(reused, true, 'an idle keep-alive connection outlives stallMs');
    agent.destroy();
  } finally {
    s.close();
    rmSync(name);
  }
});

test('concurrent encoded requests for one file share one compression, and a later one compresses nothing', async () => {
  writeFileSync(join(dir, stream, 'shared'), packable);
  const { server: s, stats } = createOrigin(dir);
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${s.address().port}/${stream}/shared`;
  try {
    const rs = await Promise.all(Array.from({ length: 20 }, () => raw(url, { 'accept-encoding': 'br' })));
    for (const r of rs) { assert.equal(r.res.headers['content-encoding'], 'br'); assert.deepEqual(brotliDecompressSync(r.body), packable); }
    assert.equal(stats.compressions, 1, '20 concurrent br requests, one compression');
    await raw(url, { 'accept-encoding': 'br' });
    assert.equal(stats.compressions, 1, 'a held copy is not compressed again');
    await raw(url, { 'accept-encoding': 'gzip' });
    assert.equal(stats.compressions, 2, 'gzip is its own copy');
  } finally {
    s.close();
  }
});

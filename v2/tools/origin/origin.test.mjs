// A1 of Engine v2 V2 (#2711): the origin's headers on a part, on the pointer and on a 404, as
// v2/docs/viewer-cache.md states them. Run: node --test v2/tools/origin/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
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

// Engine v2 O23 (#3324): the site's own pages on the new system's origin, with no launcher anywhere. The feed's shape
// cases are carried from tools/world-launcher/feed.test.mjs (paging, cursor, replaced items, item keys, refusals, cache
// header, credentials, ids); O18's release line becomes today's release item; /ops keeps its CSP and noindex and makes
// no outgoing request when served. Run: node --test v2/tools/origin/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOrigin } from './origin.mjs';
import { serveOps } from './ops.mjs';
import { build } from '../../client/served/build.mjs';

let dir, server, base;
const line = (o) => `${JSON.stringify(o)}\n`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'v2-site-'));
  for (const d of ['views', 'web', 'data', 'pkg']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'web', 'changelog.html'), '<!doctype html><title>Changelog · Souls</title><section id="v0.140">0.140</section>');
  writeFileSync(join(dir, 'web', 'changelog.md'), '# Changelog\n\n## 0.140 (2026-11-19)\n');
  writeFileSync(join(dir, 'pkg', 'replica.js'), 'export const test = true;');
  writeFileSync(join(dir, 'pkg', 'replica_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  build({ out: join(dir, 'client'), version: '0.0.0', pkg: join(dir, 'pkg') });
  ({ server } = createOrigin(join(dir, 'views'), { web: join(dir, 'web'), data: join(dir, 'data'), client: join(dir, 'client') }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const feed = (q = '', headers = {}) => fetch(`${base}/v1/feed${q}`, { headers });

test('served client: world GET/HEAD routes serve the installed bytes and matching config, and refuse writes or missing files', async () => {
  const config = await (await fetch(`${base}/w/eden/v1/config`)).json();
  const eden = await (await fetch(`${base}/w/eden/eden.mjs`)).arrayBuffer();
  assert.equal(createHash('sha256').update(Buffer.from(eden)).digest('hex'), config.soulClient.sha256);
  for (const f of config.soulClient.files) {
    for (const method of ['GET', 'HEAD']) {
      const r = await fetch(`${base}/w/new-town/${f.name}?upgrade=1`, { method });
      assert.equal(r.status, 200, `${method} ${f.name}`);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      assert.equal(Number(r.headers.get('content-length')), f.bytes);
      const body = Buffer.from(await r.arrayBuffer());
      if (method === 'HEAD') assert.equal(body.length, 0);
      else assert.deepEqual(body, readFileSync(join(dir, 'client', f.name)));
    }
  }
  const head = await fetch(`${base}/w/eden/v1/config`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const method of ['GET', 'HEAD']) {
    const guide = await fetch(`${base}/w/eden/llms.txt`, { method });
    assert.equal(guide.status, 200);
    assert.equal(guide.headers.get('cache-control'), 'no-cache');
    assert.equal(await guide.text(), method === 'HEAD' ? '' : readFileSync(join(dir, 'client', 'instructions.md'), 'utf8'));
  }
  assert.equal((await fetch(`${base}/w/eden/eden.mjs`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/w/eden/soul-client.json`)).status, 404, 'manifest is not a public client address');
  const missing = createOrigin(join(dir, 'views'), { client: join(dir, 'missing') }).server;
  await new Promise((ok) => missing.listen(0, '127.0.0.1', ok));
  try {
    for (const name of ['eden.mjs', 'creator.md', 'v1/config']) assert.equal((await fetch(`http://127.0.0.1:${missing.address().port}/w/eden/${name}`)).status, 404, name);
  } finally { missing.close(); }
});

test('R16: the replica\'s two files carry an ETag of their content, the same on GET and HEAD, changed when the file is', async () => {
  const etag = async (name, method = 'HEAD') => (await fetch(`${base}/w/eden/${name}`, { method })).headers.get('etag');
  const hashOf = (name) => `"${createHash('sha256').update(readFileSync(join(dir, 'client', name))).digest('hex')}"`;
  for (const name of ['replica.js', 'replica_bg.wasm']) {
    assert.equal(await etag(name), hashOf(name), `${name}: its content's hash`);
    assert.equal(await etag(name, 'GET'), await etag(name));
  }
  assert.equal(await etag('eden.mjs'), null, 'only the replica carries one');
  // A release moves a new client in: the same length, other bytes, another ETag.
  const wasm = join(dir, 'client', 'replica_bg.wasm'), was = readFileSync(wasm), old = await etag('replica_bg.wasm');
  writeFileSync(wasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 1]));
  try {
    assert.notEqual(await etag('replica_bg.wasm'), old, 'a changed file has another ETag');
    assert.equal(await etag('replica_bg.wasm'), hashOf('replica_bg.wasm'));
  } finally { writeFileSync(wasm, was); }
});

test('served client: the install bundle carries a self-contained origin adapter', async t => {
  const bins = join(dir, 'bins'), bundle = join(dir, 'bundle');
  mkdirSync(bins);
  for (const p of ['supervisor', 'worldd', 'gatewayd', 'directoryd', 'register-world', 'deploy', 'gateway-upgrade', 'import-accounts', 'import-world', 'templates']) writeFileSync(join(bins, p), '#!/bin/sh\n');
  execFileSync('bash', [fileURLToPath(new URL('../ops/install.sh', import.meta.url)), 'bundle', bundle, bins, join(dir, 'web')]);
  assert.deepEqual(readFileSync(join(bundle, 'origin', 'owner-overview-data.mjs')), readFileSync(new URL('../../../tools/world-launcher/owner-overview-data.mjs', import.meta.url)));
  const { createOrigin: installed } = await import(pathToFileURL(join(bundle, 'origin', 'origin.mjs')));
  const owner = await ownerFixture(t, installed);
  const privateReply = await owner.data(ownerHeaders);
  assert.equal(privateReply.status, 200, 'installed origin actually authenticates and loads its snapshot');
  assert.equal((await privateReply.json()).items[0].title, 'PRIVATE SNAPSHOT SENTINEL');
  const s = installed(join(dir, 'views'), { client: join(dir, 'client') }).server;
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/w/eden/eden.mjs`);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(join(dir, 'client', 'eden.mjs')));
  } finally { s.close(); }
});

test('A2: the feed in today\'s shape: empty, then oldest first, replaced items hidden, cursor paging, refusals', async () => {
  const r0 = await feed();
  assert.equal(r0.status, 200);
  assert.deepEqual(await r0.json(), { items: [], next: null });
  const news = join(dir, 'data', 'news.jsonl');
  appendFileSync(news, line({ id: 'f1', at: '2026-11-10T00:00:00.000Z', kind: 'announcement', title: 'Hello', body: 'The feed is open.', url: 'https://soul.game/changelog' }));
  appendFileSync(news, line({ id: 'f2', at: '2026-11-10T00:00:00.000Z', kind: 'event', title: 'Gathering', body: '', startsAt: '2026-12-01T18:00:00.000Z', place: 'the bandstand' }));
  appendFileSync(news, line({ id: 'f3', at: '2026-11-10T00:00:00.000Z', kind: 'release', title: 'Client 2.33.0', body: '', minClient: '2.33.0' }));
  appendFileSync(news, line({ id: 'f4', at: '2026-11-10T00:00:00.000Z', kind: 'event', title: 'Gathering, moved', body: '', startsAt: '2026-12-02T18:00:00.000Z', replaces: 'f2' }));
  const all = await (await feed()).json();
  assert.deepEqual(all.items.map((i) => i.id), ['f1', 'f3', 'f4']);
  assert.equal(all.next, 'f4');
  assert.deepEqual(Object.keys(all.items[0]), ['id', 'at', 'kind', 'title', 'body', 'url']);
  assert.equal(all.items[2].startsAt, '2026-12-02T18:00:00.000Z');
  assert.equal(all.items[1].minClient, '2.33.0');
  const p1 = await (await feed('?limit=1')).json();
  assert.deepEqual([p1.items.map((i) => i.id), p1.next], [['f1'], 'f1']);
  const p2 = await (await feed(`?after=${p1.next}&limit=1`)).json();
  assert.deepEqual([p2.items.map((i) => i.id), p2.next], [['f3'], 'f3'], 'the hidden f2 is skipped, not counted against the page');
  const p3 = await (await feed(`?after=${p2.next}`)).json();
  assert.deepEqual([p3.items.map((i) => i.id), p3.next], [['f4'], 'f4']);
  assert.deepEqual(await (await feed('?after=f4')).json(), { items: [], next: 'f4' });
  assert.equal((await feed('?after=nope')).status, 400);
  assert.equal((await feed('?limit=1000')).status, 400);
  // public cache headers; no credentials needed and none change the answer
  const pub = await feed();
  assert.match(pub.headers.get('cache-control'), /^public, max-age=\d+$/);
  assert.match(pub.headers.get('x-robots-tag'), /noindex/);
  assert.deepEqual(await (await feed('', { authorization: 'Bearer god_x' })).json(), all);
  assert.equal((await fetch(`${base}/v1/feed`, { method: 'POST', body: '{}' })).status, 405, 'read-only');

  // O18's release line (release.sh news) is today's release item, its id its line number; the next read sees it
  appendFileSync(news, line({ kind: 'release', version: '0.140', commit: 'a'.repeat(40), date: '2026-11-19', link: 'https://soul.game/changelog#v0.140' }));
  const rel = await (await feed('?after=f4')).json();
  assert.deepEqual(rel, { items: [{ id: 'f5', at: '2026-11-19T00:00:00.000Z', kind: 'release', title: 'Soul 0.140', body: 'Release 0.140 is live.', url: 'https://soul.game/changelog#v0.140' }], next: 'f5' });
});

test('A2: a malformed line is skipped and moves no other id; a line without a stored id keeps its line number (#1993)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'v2-site-ids-'));
  const l = (id, title) => JSON.stringify({ ...(id ? { id } : {}), at: '2026-11-10T00:00:00.000Z', kind: 'announcement', title, body: '' });
  writeFileSync(join(d, 'news.jsonl'), `${l(null, 'legacy')}\n${l('f2', 'two')}\n{"id":"f3","at":"2026-11-1\n${l('f4', 'four')}\n`);
  const { server: s } = createOrigin(join(dir, 'views'), { web: join(dir, 'web'), data: d });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  try {
    const at = `http://127.0.0.1:${s.address().port}/v1/feed`;
    assert.deepEqual((await (await fetch(at)).json()).items.map((i) => [i.id, i.title]), [['f1', 'legacy'], ['f2', 'two'], ['f4', 'four']]);
    assert.deepEqual((await (await fetch(`${at}?after=f2`)).json()).items.map((i) => i.id), ['f4'], 'a client that read up to f2 gets f4 next');
  } finally {
    s.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test('A1/A3: /changelog and /changelog.md are the page\'s files, no-cache; Accept: text/markdown gets the Markdown twin', async () => {
  for (const [path, type, want] of [['/changelog', /text\/html/, /id="v0.140"/], ['/changelog/', /text\/html/, /id="v0.140"/], ['/changelog.md', /text\/markdown/, /^# Changelog/]]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type'), type, path);
    assert.equal(r.headers.get('cache-control'), 'no-cache', path);
    assert.match(await r.text(), want, path);
  }
  const md = await fetch(`${base}/changelog`, { headers: { accept: 'text/markdown, text/html;q=0.5' } });
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(md.headers.get('vary'), /Accept/);
  // a stream path is still a stream path
  assert.equal((await fetch(`${base}/ab/pointer`)).status, 404);
});

test('A4: /ops carries noindex and its CSP, and makes no outgoing request when served', async () => {
  const r = await fetch(`${base}/ops`), html = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const data = await fetch(`${base}/ops?json=1`);
  assert.deepEqual([data.status, (await data.json()).code], [503, 'owner-access-unconfigured'], 'the owner data fails closed');
  assert.equal((await fetch(`${base}/ops`, { method: 'POST' })).status, 405);

  // served with every way out of this process refusing: it still answers, and nothing tried to leave
  const tried = [], saved = { fetch: globalThis.fetch, http: http.request, https: https.request, connect: net.connect, socket: net.Socket.prototype.connect };
  const refuse = (what) => () => { tried.push(what); throw Error(`outgoing ${what}`); };
  globalThis.fetch = refuse('fetch'); http.request = refuse('http'); https.request = refuse('https'); net.connect = refuse('net'); net.Socket.prototype.connect = refuse('socket');
  let status, body;
  try {
    const res = { writeHead(s) { status = s; return this; }, end(b) { body = String(b); } };
    serveOps({ method: 'GET', headers: {} }, res, new URL('http://origin/ops'));
  } finally {
    Object.assign(globalThis, { fetch: saved.fetch }); http.request = saved.http; https.request = saved.https; net.connect = saved.connect; net.Socket.prototype.connect = saved.socket;
  }
  assert.equal(status, 200);
  assert.match(body, /Owner overview/);
  assert.deepEqual(tried, []);
});

// O23b uses the existing directory authority rather than another verifier. These transport fixtures prove the
// origin's boundary; the directory's real-provider verification and public sign-in remain separate qualification.
const OPS_PUBLIC = 'https://ops.example.test';
const OPS_ENV = upstream => ({ AUTH_PROVIDER: 'clerk',
  CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.example.test$').toString('base64'),
  CLERK_ISSUER_URL: 'https://clerk.example.test', CLERK_AUTHORIZED_PARTIES: OPS_PUBLIC,
  SOULS_OPS_PUBLIC_ORIGIN: OPS_PUBLIC, SOULS_OPS_DIRECTORY: upstream, SIM_SITE_OWNERS: 'acct_owner' });

async function ownerFixture(t, factory = createOrigin) {
  const requests = [], held = [];
  let mode = 'normal';
  const authority = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (mode === 'hold') { held.push(res); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: OPS_PUBLIC }).end(); return; }
    if (mode === 'oversize') { res.end('x'.repeat(4097)); return; }
    if (mode === 'malformed') { res.end('{'); return; }
    if (mode === 'missing-account') { res.end(JSON.stringify({ principal: 'not-authority' })); return; }
    const token = req.headers.authorization;
    if (!['Bearer fixture-owner-session', 'Bearer fixture-other-session'].includes(token)) {
      res.writeHead(401).end(JSON.stringify({ refused: 'token-signature' })); return;
    }
    res.end(JSON.stringify({ account: token === 'Bearer fixture-owner-session' ? 'acct_owner' : 'acct_other', principal: 'private-principal' }));
  });
  await new Promise(ok => authority.listen(0, '127.0.0.1', ok));
  const env = OPS_ENV(`http://127.0.0.1:${authority.address().port}`);
  const data = join(dir, `ops-${requests.length}-${authority.address().port}`); mkdirSync(data);
  const { projectRecords } = await import('../../../tools/world-launcher/owner-overview-data.mjs');
  const snapshot = projectRecords({ observedAt: new Date().toISOString(), issues: [{ number: 3578,
    title: 'PRIVATE SNAPSHOT SENTINEL', url: 'https://github.com/soulsimulation/souls/issues/3578',
    state: 'OPEN', updatedAt: new Date().toISOString(), assignees: [], comments: [], labels: [] }] });
  const file = join(data, 'owner-overview.json'); writeFileSync(file, JSON.stringify(snapshot));
  const { server: origin } = factory(join(dir, 'views'), { data, auth: env });
  await new Promise(ok => origin.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${origin.address().port}`;
  t.after(() => {
    for (const res of held) res.destroy();
    authority.closeAllConnections(); origin.closeAllConnections(); authority.close(); origin.close();
  });
  return { env, url, file, requests, held, mode: value => { mode = value; },
    data: (headers = {}, method = 'GET') => fetch(url + '/ops?json=1', { headers, method }) };
}
const ownerHeaders = { authorization: 'Bearer fixture-owner-session' };

test('O23b: configured owner, non-owner, no bypass, private snapshot shape and dynamic allowlist', async t => {
  const f = await ownerFixture(t);
  let r = await f.data(); assert.equal(r.status, 401); assert.equal(f.requests.length, 0);
  for (const authorization of ['Bearer dev:owner', 'Bearer invalid', 'Basic unrelated']) {
    r = await f.data({ authorization }); assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'sign-in');
  }
  r = await f.data({ authorization: 'Bearer fixture-other-session' }); assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, code: 'not-owner' });
  r = await f.data({ ...ownerHeaders, origin: 'https://caller.example.test', 'x-forwarded-for': '203.0.113.9',
    'x-souls-operator': 'not-authority', 'souls-soul': 'not-authority' });
  assert.equal(r.status, 200);
  const body = await r.json(); assert.equal(body.ok, true); assert.equal(body.source.state, 'cached');
  assert.equal(body.items[0].title, 'PRIVATE SNAPSHOT SENTINEL'); assert.deepEqual(Object.keys(body).sort(), ['items', 'ok', 'snapshot', 'source']);
  assert.equal(JSON.stringify(body).includes('private-principal'), false);
  for (const [name, value] of Object.entries({ 'cache-control': 'private, no-store, max-age=0', vary: 'Authorization, Cookie',
    'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' })) assert.equal(r.headers.get(name), value);
  const upstream = f.requests.at(-1);
  assert.equal(upstream.method, 'POST'); assert.equal(upstream.url, '/v1/account/session');
  assert.equal(upstream.headers.origin, OPS_PUBLIC);
  assert.equal(upstream.headers['x-forwarded-for'], undefined); assert.equal(upstream.headers['x-souls-operator'], undefined);
  assert.equal(upstream.headers['souls-soul'], undefined); assert.equal(upstream.headers.cookie, undefined);
  r = await f.data({ cookie: '__session=fixture-owner-session' }); assert.equal(r.status, 200);
  r = await f.data(ownerHeaders, 'HEAD'); assert.equal(r.status, 200); assert.equal(await r.text(), '');
  f.env.CATALOG_GENE_OWNER_ID = 'acct_owner'; f.env.SIM_SITE_OWNERS = 'acct_other';
  r = await f.data(ownerHeaders); assert.equal(r.status, 403, 'explicit owners override compatibility fallback immediately');
  delete f.env.SIM_SITE_OWNERS; r = await f.data(ownerHeaders); assert.equal(r.status, 200);
  delete f.env.CATALOG_GENE_OWNER_ID; r = await f.data(ownerHeaders); assert.equal(r.status, 503);
});

test('O23b: shell and public config exclude private settings; authorized snapshot preserves last-valid behavior', async t => {
  const f = await ownerFixture(t), calls = f.requests.length;
  let r = await fetch(f.url + '/ops'); assert.equal(r.status, 200);
  const html = await r.text(); assert.match(html, /pk_live_/); assert.match(r.headers.get('content-security-policy'), /script-src 'sha256-/);
  for (const privateValue of ['PRIVATE SNAPSHOT SENTINEL', 'acct_owner', f.env.SOULS_OPS_DIRECTORY, 'owner-overview.json']) assert.equal(html.includes(privateValue), false);
  assert.equal(f.requests.length, calls, 'serving configured shell never calls directory');
  r = await fetch(f.url + '/v1/auth/config'); assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(await r.json()).sort(), ['authProvider', 'clerkIssuer', 'clerkPublishableKey']);
  r = await f.data(ownerHeaders); assert.equal((await r.json()).source.state, 'cached');
  writeFileSync(f.file, '{'); r = await f.data(ownerHeaders);
  const stale = await r.json(); assert.equal(stale.source.state, 'stale'); assert.equal(stale.items[0].title, 'PRIVATE SNAPSHOT SENTINEL');
  rmSync(f.file); r = await f.data(ownerHeaders); assert.equal((await r.json()).source.state, 'stale');
  for (const path of ['/ops/snapshot.json', '/ops/metadata.json', '/owner-overview.json']) assert.equal((await fetch(f.url + path)).status, 404);
});

test('O23b: untrusted configuration, authority failures, redirects and oversized replies fail closed', async t => {
  const f = await ownerFixture(t), upstream = f.env.SOULS_OPS_DIRECTORY;
  for (const value of ['https://127.0.0.1', 'http://localhost:7310', 'http://example.test', upstream + '/arbitrary', upstream + '?upstream=other', upstream + '/']) {
    f.env.SOULS_OPS_DIRECTORY = value;
    const r = await f.data(ownerHeaders); assert.equal(r.status, 503); assert.equal(f.requests.length, 0);
  }
  f.env.SOULS_OPS_DIRECTORY = upstream;
  const originalKey = f.env.CLERK_PUBLISHABLE_KEY;
  f.env.CLERK_PUBLISHABLE_KEY = originalKey.replace('pk_live_', 'pk_test_');
  assert.equal((await f.data(ownerHeaders)).status, 503, 'ops never enables test-provider owner access');
  f.env.CLERK_PUBLISHABLE_KEY = originalKey;
  f.env.SOULS_OPS_PUBLIC_ORIGIN = 'https://unlisted.example.test'; assert.equal((await f.data(ownerHeaders)).status, 503);
  f.env.SOULS_OPS_PUBLIC_ORIGIN = OPS_PUBLIC;
  for (const mode of ['redirect', 'oversize', 'malformed', 'missing-account']) {
    f.mode(mode); const r = await f.data(ownerHeaders); assert.equal(r.status, 503, mode);
    assert.deepEqual(await r.json(), { ok: false, code: 'owner-access-unconfigured' });
  }
  f.mode('normal'); assert.equal((await f.data({ cookie: '__session=fixture-owner-session; __session=fixture-other-session' })).status, 401);
  assert.equal((await f.data({ authorization: 'Bearer ' + 'x'.repeat(32769) })).status, 431, 'HTTP parser refuses an oversized header before routing');
});

test('O23b: directory work has finite concurrency and a total deadline', async t => {
  const f = await ownerFixture(t); f.mode('hold');
  const first = f.data(ownerHeaders), second = f.data(ownerHeaders);
  const until = Date.now() + 1000;
  while (f.held.length < 2 && Date.now() < until) await new Promise(ok => setTimeout(ok, 5));
  assert.equal(f.held.length, 2);
  const busy = await f.data(ownerHeaders); assert.equal(busy.status, 429);
  for (const pending of [first, second]) { const r = await pending; assert.equal(r.status, 503); }
  assert.equal(f.requests.length, 2, 'no retry/poll/background work');
  f.mode('normal'); assert.equal((await f.data(ownerHeaders)).status, 200, 'capacity returns after deadline');
});

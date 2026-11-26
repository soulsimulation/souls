// 0.135 W1: a signed-in person's New world is made on the new engine. The launcher asks the directory's create
// (POST /v1/worlds, as v2/crates/directoryd/src/worlds/list/http.rs answers it: `world-starting` until placement has
// forked and started the world and registered its route, then the row) once per request with the token the request
// carries, and answers 202 with the click's key and address while the world is starting; the page asks again with them
// and a fresh token. The world is then served at /w/<slug>/ and listed, with no old world made. The directory here is
// a stand-in with that contract (its tokens expire, as a Clerk session token does); its placement writes the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const scratch = new URL('../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A launcher with a binding and a stand-in directory. `dir` options: `starting` world-starting answers per key before
 *  it is placed, `expireMs` how long a token is accepted after its first use, `route` false: placed without its route
 *  (the test writes it), `fail` a queue of failures for the next asks ('drop' no answer, 'store' store-unreachable),
 *  `gateway` the gatewayd its route names. */
async function fixture(t, { dir: opts = {}, launcher: extra = {} } = {}) {
  const dir = mkdtempSync(new URL('w1-create-', scratch)), data = join(dir, 'data'), file = join(dir, 'binding.json'), routes = join(dir, 'routes.json');
  const client = join(dir, 'client'), bodies = join(dir, 'bodies'), web = join(dir, 'web');
  for (const d of [data, client, bodies, web]) mkdirSync(d, { recursive: true });
  const described = (name, text) => { const bytes = Buffer.from(text); writeFileSync(join(client, name), bytes); return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const files = [described('replica.js', 'test module'), described('replica_bg.wasm', 'test wasm')];
  writeFileSync(join(client, 'soul-client.json'), JSON.stringify({ ...described('eden.mjs', 'client'), contract: 'souls-v2/1', version: '3.0.0', skill: described('skill.md', 'skill'), files }));
  writeFileSync(join(bodies, 'bodies.json'), '{"format":"souls/bodies/1","bodies":[]}');
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>Souls</title></head><body><div id="root"></div></body></html>');
  writeFileSync(join(data, 'worlds.json'), JSON.stringify({ schema: 'world-launcher-registry/1', legacyBases: [], worlds: [{ slug: 'eden', name: 'Eden', template: 'empty', createdAt: 1, owner: 'synthetic-owner' }] }));
  const { v2Switch } = await import('./v2-switch.mjs');
  v2Switch({ binding: file, slug: 'eden', stream: '/s/eden/', routes, client, staticDir: join(dir, 'static-eden'), bodies });
  const writeRoute = (slug) => {
    const table = JSON.parse(readFileSync(routes, 'utf8'));
    table.worlds[slug] = { gateway: opts.gateway ?? 'http://127.0.0.1:1', stream: `/s/w/${slug}/views/1/`, history: `/s/w/${slug}/history/`, canonical: true };
    writeFileSync(routes, JSON.stringify(table));
  };

  const stub = { asks: [], settings: [], rows: new Map(), expired: 0, firstSeen: new Map(), startingLeft: new Map(), fail: [...(opts.fail ?? [])] };
  const directory = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const answer = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    // the public list (asked with no sign-in) leaves an unlisted world out, as directoryd's list_for(None) does
    if (req.method === 'GET' && req.url === '/v1/worlds') return answer(200, { worlds: [...stub.rows.values()].filter((r) => r.unlisted !== true), templates: ['hello-hamlet'] });
    if (req.method === 'POST' && req.url === '/v1/worlds/settings') {
      // a world's switches, by its creator alone (http.rs settings)
      const ask = JSON.parse(Buffer.concat(chunks).toString('utf8')), token = /^Bearer (test:\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      stub.settings.push({ ...ask, token });
      if (!token) return answer(401, { refused: 'token-missing' });
      const row = stub.rows.get(ask.world);
      if (!row) return answer(404, { refused: 'world-missing' });
      if (row.creator !== `principal-of-${token.slice(5).split('.')[0]}`) return answer(403, { refused: 'not-the-creator' });
      if (typeof ask.unlisted === 'boolean') row.unlisted = ask.unlisted;
      return answer(200, { world: row });
    }
    if (req.method !== 'POST' || req.url !== '/v1/worlds') return answer(404, { refused: 'not-found' });
    const ask = JSON.parse(Buffer.concat(chunks).toString('utf8')), token = /^Bearer (test:\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    stub.asks.push({ ...ask, token });
    const failure = stub.fail.shift();
    if (failure === 'drop') return req.socket.destroy();
    if (failure === 'store') return answer(503, { refused: 'store-unreachable', detail: '' });
    if (!token) return answer(401, { refused: 'token-missing' });
    // a token is good for `expireMs` from its first use, as a Clerk session token is for about a minute
    if (!stub.firstSeen.has(token)) stub.firstSeen.set(token, Date.now());
    if (opts.expireMs && Date.now() - stub.firstSeen.get(token) > opts.expireMs) { stub.expired++; return answer(401, { refused: 'token-expired' }); }
    const person = token.slice(5).split('.')[0];   // `test:ada.3` is ada's third token
    if (ask.template !== 'hello-hamlet') return answer(409, { refused: 'template-missing', detail: ask.template });
    const made = stub.rows.get(ask.name);
    if (made) return made.key === ask.key ? answer(200, { world: made, epoch: 1 }) : answer(409, { refused: 'name-taken', detail: ask.name });
    const left = stub.startingLeft.get(ask.key) ?? opts.starting ?? 1;
    if (left > 0) { stub.startingLeft.set(ask.key, left - 1); return answer(503, { refused: 'world-starting', detail: '' }); }
    if (opts.route !== false) writeRoute(ask.name);
    const row = { name: ask.name, label: ask.label, template: ask.template, creator: `principal-of-${person}`, made: 1700000000, ready: true, key: ask.key };
    stub.rows.set(ask.name, row);
    return answer(200, { world: row, epoch: 1 });
  });
  const D = await testPort(1); await new Promise(r => directory.listen(D, '127.0.0.1', r));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, started = [];
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, eager: 0, base: '/', log: () => {}, cutoverBindingFile: file, webDir: web,
    v2DirectoryUrl: `http://127.0.0.1:${D}`, v2Create: true, v2CreatePollMs: 20, v2CreateBudgetMs: 2000, ...extra,
    command: (w) => { started.push(w.slug); throw new Error('no old world may start'); } });
  t.after(async () => { await launcher.close(); directory.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = async (body, authorization) => {
    const r = await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { base, data, stub, create, writeRoute, started };
}

test('W1: New world goes to the directory as the signed-in person, answers 202 while starting, then is served and listed', async t => {
  const { base, data, stub, create, started } = await fixture(t);
  const ask = { name: 'Willow Hollow', template: 'hello-hamlet', godName: 'Ada' };

  // signed out: refused, nothing asked of the directory
  assert.equal((await create(ask)).status, 401);
  assert.equal(stub.asks.length, 0);

  const first = await create(ask, 'Bearer dev:ada');
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual([first.body.code, first.body.slug], ['world.starting', 'willow-hollow']); assert.match(first.body.key, /^[0-9a-f]{32}$/);
  assert.doesNotMatch(first.body.message, /nothing was made/i);
  assert.equal(stub.asks.length, 1, 'one ask per request: the token is not sent again');

  const made = await create({ ...ask, key: first.body.key, slug: first.body.slug }, 'Bearer dev:ada');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.slug, made.body.url, made.body.engine, made.body.claimed], ['willow-hollow', '/w/willow-hollow/?dev=1&new=1', 'new', true]);
  assert.deepEqual(stub.asks.map(a => [a.key, a.name, a.label, a.template, a.token]), Array(2).fill([first.body.key, 'willow-hollow', 'Willow Hollow', 'hello-hamlet', 'test:ada']),
    'as the signed-in person (the dev sign-in is the directory\'s test sign-in), one key for the click');
  assert.equal(stub.rows.get('willow-hollow').creator, 'principal-of-ada', 'owned by that person');

  // served at its own address, from the stream, and listed under its label
  const page = await fetch(`${base}/w/willow-hollow/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200); assert.equal(page.headers.get('x-souls-engine'), 'new');
  const c = JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(await page.text())[1]);
  assert.deepEqual([c.worldKey, c.worldName, c.v2Stream], ['willow-hollow', 'Willow Hollow', '/s/w/willow-hollow/views/1/']);
  const listed = (await (await fetch(`${base}/__sim/worlds.json`)).json()).worlds.find(w => w.slug === 'willow-hollow');
  assert.deepEqual([listed?.name, listed?.engine, listed?.template, listed?.god], ['Willow Hollow', 'new', 'hello-hamlet', true], 'listed at once, from a list read after the row');
  assert.equal((await (await fetch(`${base}/__sim/worlds/willow-hollow`)).json()).world?.name, 'Willow Hollow', 'the one-world read the page asks for');
  assert.deepEqual(started, [], 'no old world process was started');
  assert.equal(existsSync(join(data, 'worlds', 'willow-hollow')), false, 'no old world folder was made');

  // the page's /v1/me names the signed-in visitor; signed out it is 401, as on an old world
  const me = await fetch(`${base}/w/willow-hollow/v1/me`, { headers: { authorization: 'Bearer dev:ada' } });
  assert.equal(me.status, 200); assert.equal((await me.json()).me.userId, 'dev:ada');
  assert.equal((await fetch(`${base}/w/willow-hollow/v1/me`)).status, 401);

  // a new click with the same name gets the next address; a refusal is passed on by name, and nothing is served
  assert.equal((await create(ask, 'Bearer dev:bo')).body.slug, 'willow-hollow-2');
  const refused = await create({ name: 'Elsewhere', template: 'nowhere' }, 'Bearer dev:ada');
  assert.equal(refused.status, 409); assert.equal(refused.body.code, 'template-missing');
  assert.equal((await fetch(`${base}/w/elsewhere/`, { headers: { accept: 'text/html' } })).status, 404);
  assert.equal((await create({ name: 'x'.repeat(41), template: 'hello-hamlet' }, 'Bearer dev:ada')).status, 400, 'the form\'s 40 characters');

  // paused on the site (soul.game until Gene's yes): refused before the directory is asked
  const before = stub.asks.length;
  assert.equal((await fetch(`${base}/__sim/op/set-site`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"creation":false}' })).status, 200);
  const paused = await create({ name: 'Paused', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(paused.status, 503); assert.equal(paused.body.code, 'site.creation-paused');
  assert.equal(stub.asks.length, before);
});

test('W1: a token that expires while the world starts is never sent again; the page\'s fresh token finishes the same world', async t => {
  const { stub, create } = await fixture(t, { dir: { expireMs: 150, starting: 3 } });
  const ask = { name: 'Slow Start', template: 'hello-hamlet' };
  let out = await create(ask, 'Bearer dev:ada.1'), n = 1;
  const { key, slug } = out.body;
  while (out.status === 202) { await sleep(200); out = await create({ ...ask, key, slug }, `Bearer dev:ada.${++n}`); }   // longer than a token lives
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.slug, 'slow-start');
  assert.equal(stub.expired, 0, 'no expired token reached the directory');
  assert.deepEqual(stub.asks.map(a => a.token), [1, 2, 3, 4].map(i => `test:ada.${i}`), 'each ask with the token its request carried');
  assert.equal(new Set(stub.asks.map(a => a.key)).size, 1); assert.equal(stub.rows.size, 1, 'one world');
  // what the old loop did: the first token again, after it has expired, is refused
  const stale = await create({ ...ask, key, slug }, 'Bearer dev:ada.1');
  assert.equal(stale.status, 401); assert.equal(stub.expired, 1);
});

test('W1: placed but not yet routed within the request: 202 "still starting", then the same world when the route lands', async t => {
  const { stub, create, writeRoute } = await fixture(t, { dir: { starting: 0, route: false }, launcher: { v2CreateBudgetMs: 300 } });
  const ask = { name: 'Late Route', template: 'hello-hamlet' };
  const t0 = Date.now(), first = await create(ask, 'Bearer dev:ada');
  assert.ok(Date.now() - t0 < 2000, 'the request ends within its budget');
  assert.equal(first.status, 202); assert.equal(first.body.code, 'world.starting');
  assert.match(first.body.message, /still starting.*world list/i); assert.doesNotMatch(first.body.message, /nothing was made/i);
  writeRoute(first.body.slug);
  const done = await create({ ...ask, key: first.body.key, slug: first.body.slug }, 'Bearer dev:ada');
  assert.equal(done.status, 201); assert.equal(done.body.slug, 'late-route', 'the same address, never late-route-2');
  assert.equal(stub.rows.size, 1);
});

test('W1: no answer and store-unreachable are asked again with the same key; still nothing is a resumable 503', async t => {
  const { stub, create } = await fixture(t, { dir: { starting: 0, fail: ['drop', 'store'] } });
  const made = await create({ name: 'Bumpy', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(stub.asks.length, 3); assert.equal(new Set(stub.asks.map(a => a.key)).size, 1, 'one key across the retries');

  stub.fail.push(...Array(500).fill('store'));
  const down = await create({ name: 'Down', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(down.status, 503); assert.equal(down.body.code, 'directory.unreachable');
  assert.match(down.body.key, /^[0-9a-f]{32}$/); assert.equal(down.body.slug, 'down');
  assert.doesNotMatch(down.body.message, /nothing was made/i);
  stub.fail.length = 0;
  const after = await create({ name: 'Down', template: 'hello-hamlet', key: down.body.key, slug: down.body.slug }, 'Bearer dev:ada');
  assert.equal(after.status, 201); assert.equal(after.body.slug, 'down', 'the same address, never down-2');
});

test('W1: the per-address limit counts a create in flight; asking again for it is not another create', async t => {
  const { create } = await fixture(t, { dir: { starting: 5 }, launcher: { createLimit: 1 } });
  const first = await create({ name: 'One', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(first.status, 202);
  assert.equal((await create({ name: 'Two', template: 'hello-hamlet' }, 'Bearer dev:ada')).status, 429, 'the first is still in flight');
  assert.equal((await create({ name: 'One', template: 'hello-hamlet', key: first.body.key, slug: first.body.slug }, 'Bearer dev:ada')).status, 202);
});

test('W1: a refusal gives its per-address slot back', async t => {
  const { create } = await fixture(t, { dir: { starting: 5 }, launcher: { createLimit: 1 } });
  assert.equal((await create({ name: 'Nowhere', template: 'nowhere' }, 'Bearer dev:ada')).status, 409);
  assert.equal((await create({ name: 'Somewhere', template: 'hello-hamlet' }, 'Bearer dev:ada')).status, 202, 'the refused create did not use the slot');
});

test('W1: a resume with an address this launcher did not give is refused before the directory is asked', async t => {
  const { stub, create } = await fixture(t);
  const key = 'a'.repeat(32);
  for (const [name, slug] of [['Mars', 'mars'], ['Anything', 'mars'], ['Anything', 'eden'], ['Willow', 'other'], ['Willow', 'willow-1'], ['Eden', 'eden']]) {
    const out = await create({ name, template: 'hello-hamlet', key, slug }, 'Bearer dev:ada');
    assert.equal(out.status, 400, `${name} → ${slug}`); assert.equal(out.body.code, 'invalid');
  }
  assert.equal(stub.asks.length, 0, 'none of them reached the directory');
  // an issued key keeps its own address: the same key with another one is refused too
  const first = await create({ name: 'Willow', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(first.status, 202);
  assert.equal((await create({ name: 'Willow', template: 'hello-hamlet', key: first.body.key, slug: 'willow-2' }, 'Bearer dev:ada')).status, 400);
  assert.equal(stub.asks.length, 1);
});

test('W1: on by default where a cutover binding is in place (Gene\'s yes, 24 Nov)', async t => {
  const { stub, create } = await fixture(t, { launcher: { v2Create: undefined } });
  const out = await create({ name: 'Default On', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(stub.asks.length, 1, 'no flag: New world is the directory\'s create');
  assert.equal(out.status, 202, JSON.stringify(out.body));
});

test('W1: with the flag off, New world is not sent to the directory', async t => {
  const { stub, create } = await fixture(t, { launcher: { v2Create: false } });
  const out = await create({ name: 'Old Way', template: 'empty' }, 'Bearer dev:ada');
  assert.equal(stub.asks.length, 0);
  assert.notEqual(out.body.engine, 'new'); assert.equal(out.body.code, 'boot-failed', 'the old create ran (its world command is refused here)');
});

test('26 Nov: a created world answers its agents: the bootstrap the client pairs from, its gateway\'s paths and its socket', async t => {
  // the world's gatewayd: answers each agent path it is sent, and takes the socket
  const seen = [];
  const gateway = createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { seen.push([req.method, req.url, req.headers.authorization ?? null, Buffer.concat(chunks).toString('utf8')]); res.writeHead(200, { 'content-type': 'application/json' }).end('{"from":"gatewayd"}'); });
  });
  gateway.on('upgrade', (req, socket) => { seen.push(['UPGRADE', req.url]); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  const G = await testPort(1); await new Promise(r => gateway.listen(G, '127.0.0.1', r));
  t.after(() => gateway.close());
  const { base, create } = await fixture(t, { dir: { gateway: `http://127.0.0.1:${G}` } });
  const first = await create({ name: 'Mars Lab', template: 'hello-hamlet' }, 'Bearer dev:ada');
  const made = await create({ name: 'Mars Lab', template: 'hello-hamlet', key: first.body.key, slug: first.body.slug }, 'Bearer dev:ada');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const slug = made.body.slug, at = `${base}/w/${slug}`;

  // the bootstrap, as the v2 origin gives a moved world's (v2/tools/origin/world-routes.mjs), from its route
  const boot = await fetch(`${at}/v1/bootstrap`);
  assert.equal(boot.status, 200);
  assert.deepEqual(await boot.json(), { world: slug, stream: `/s/w/${slug}/views/1/`, history: `/s/w/${slug}/history/`, directory: '/', gateway: `/w/${slug}/v2/ws`, creatorToken: `/w/${slug}/v2/creator-token` });
  // (its world, directory and gateway are what the client's pairAddress checks before any pairing: on the 404 before,
  // every `pair <url>` stopped with `pair-world-routing`)
  assert.equal((await fetch(`${at}/v1/bootstrap`, { method: 'POST' })).status, 405, 'read-only');

  // a creator's token and the entries go to the world's gatewayd, at its own /v2/ paths, body and bearer unchanged
  const token = await fetch(`${at}/v2/creator-token`, { method: 'POST', headers: { authorization: 'Bearer creator-x', 'content-type': 'application/json' }, body: '{"ask":1}' });
  assert.deepEqual([token.status, await token.json()], [200, { from: 'gatewayd' }]);
  assert.equal((await fetch(`${at}/v2/entries`, { headers: { authorization: 'Bearer soul-x' } })).status, 200);
  assert.deepEqual(seen, [['POST', '/v2/creator-token', 'Bearer creator-x', '{"ask":1}'], ['GET', '/v2/entries', 'Bearer soul-x', '']]);

  // its socket reaches the gatewayd's /v2/ws (a replaced agent's `?free=1` too)
  const { connect } = await import('node:net');
  const upgrade = (path) => new Promise((resolve) => {
    const s = connect(Number(new URL(base).port), '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${Buffer.alloc(16).toString('base64')}\r\n\r\n`));
    let got = ''; s.on('data', (d) => { got += d; }); s.on('close', () => resolve(got)); s.on('error', () => resolve(got));
  });
  assert.match(await upgrade(`/w/${slug}/v2/ws`), /^HTTP\/1\.1 101/);
  assert.match(await upgrade(`/w/${slug}/v2/ws?free=1`), /^HTTP\/1\.1 101/);
  assert.deepEqual(seen.slice(2), [['UPGRADE', '/v2/ws'], ['UPGRADE', '/v2/ws?free=1']]);

  // a world with no route is still not served, and its socket is refused as before
  const none = await fetch(`${base}/w/nowhere/v1/bootstrap`);
  assert.deepEqual([none.status, (await none.json()).code], [404, 'world.not-served']);
  assert.match(await upgrade('/w/nowhere/v2/ws'), /^HTTP\/1\.1 404/);
});

test('26 Nov: a created world\'s creator unlists and lists it as an old world\'s owner does, in the directory, and the list follows', async t => {
  // live (my-mars-lab-2): POST /__sim/worlds/<slug>/unlisted was the fence's 409 world.new-engine, and the world stayed listed
  const { base, stub, create } = await fixture(t);
  const first = await create({ name: 'Mars Lab', template: 'hello-hamlet' }, 'Bearer dev:ada');
  const made = await create({ name: 'Mars Lab', template: 'hello-hamlet', key: first.body.key, slug: first.body.slug }, 'Bearer dev:ada');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const slug = made.body.slug;
  const unlist = async (unlisted, authorization) => {
    const r = await fetch(`${base}/__sim/worlds/${slug}/unlisted`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ unlisted }) });
    return { status: r.status, body: await r.json() };
  };
  const listed = async () => (await (await fetch(`${base}/__sim/worlds.json`)).json()).worlds.find(w => w.slug === slug);
  assert.equal((await listed())?.name, 'Mars Lab');

  // signed out, or someone else: refused, and it stays listed
  assert.deepEqual([(await unlist(true)).status, stub.settings.length], [401, 0], 'signed out: the directory is not asked');
  const other = await unlist(true, 'Bearer dev:bo');
  assert.deepEqual([other.status, other.body.code, other.body.refused], [403, 'forbidden', 'not-the-creator']);
  assert.equal((await unlist('yes', 'Bearer dev:ada')).status, 400, 'unlisted: true or false');
  assert.equal((await listed())?.name, 'Mars Lab', 'still listed');

  // its creator: the directory sets the row, asked with her own sign-in; off the list at once, its page still served
  const off = await unlist(true, 'Bearer dev:ada');
  assert.deepEqual([off.status, off.body], [200, { ok: true, slug, unlisted: true }]);
  assert.deepEqual(stub.settings.at(-1), { world: slug, unlisted: true, token: 'test:ada' });
  assert.equal(await listed(), undefined, 'off the list');
  const page = await fetch(`${base}/w/${slug}/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200); assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/, 'served, not indexed');
  assert.equal(JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(await page.text())[1]).worldName, 'Mars Lab', 'under the name the directory last gave');
  // and stays off once the launcher's copy is asked again (the directory's public list leaves it out)
  assert.equal((await (await fetch(`${base}/__sim/worlds/${slug}`)).json()).world?.unlisted, true);

  // listed again by its creator
  const on = await unlist(false, 'Bearer dev:ada');
  assert.deepEqual([on.status, on.body.unlisted], [200, false]);
  assert.equal((await listed())?.name, 'Mars Lab', 'back on the list');
});

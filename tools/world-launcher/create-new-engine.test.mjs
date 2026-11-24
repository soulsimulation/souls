// 0.135 W1: a signed-in person's New world is made on the new engine. The launcher forwards it to the directory's create
// (POST /v1/worlds, as v2/crates/directoryd/src/worlds/list/http.rs answers it: `world-starting` until placement has
// forked and started the world and registered its route, then the row), and the world is then served at /w/<slug>/ and
// listed, with no old world made. The directory here is a stand-in with that contract; placement writes the route.
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

test('W1: New world goes to the directory as the signed-in person, waits for placement, then is served and listed', async t => {
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

  // the directory: one row per key, `world-starting` on a key's first ask (placement is under way), the row on the next;
  // placement registers the world's route in the routes file before it reports ready
  const asks = [], rows = new Map();
  const directory = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const answer = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/v1/worlds') return answer(200, { worlds: [...rows.values()], templates: ['hello-hamlet'] });
    if (req.method !== 'POST' || req.url !== '/v1/worlds') return answer(404, { refused: 'not-found' });
    const ask = JSON.parse(Buffer.concat(chunks).toString('utf8')), person = /^Bearer test:(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    asks.push({ ...ask, authorization: req.headers.authorization });
    if (!person) return answer(401, { refused: 'token-missing' });
    if (ask.template !== 'hello-hamlet') return answer(409, { refused: 'template-missing', detail: ask.template });
    if (!asks.slice(0, -1).some(a => a.key === ask.key)) return answer(503, { refused: 'world-starting', detail: '' });
    const table = JSON.parse(readFileSync(routes, 'utf8'));
    table.worlds[ask.name] = { gateway: 'http://127.0.0.1:1', stream: `/s/w/${ask.name}/views/1/`, history: `/s/w/${ask.name}/history/`, canonical: true };
    writeFileSync(routes, JSON.stringify(table));
    const row = { name: ask.name, label: ask.label, template: ask.template, creator: `principal-of-${person}`, made: 1700000000, ready: true };
    rows.set(ask.name, row);
    return answer(200, { world: row, epoch: 1 });
  });
  const D = await testPort(1); await new Promise(r => directory.listen(D, '127.0.0.1', r));
  const P = await testPort(3), base = `http://127.0.0.1:${P}`, started = [];
  const launcher = await openLauncher({ port: P, range: [P + 1, P + 2], dataDir: data, eager: 0, base: '/', log: () => {}, cutoverBindingFile: file, webDir: web,
    v2DirectoryUrl: `http://127.0.0.1:${D}`, v2Create: true, v2CreatePollMs: 20,
    command: (w) => { started.push(w.slug); throw new Error('no old world may start'); } });
  t.after(async () => { await launcher.close(); directory.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = (body, authorization) => fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body) });

  // signed out: refused, nothing asked of the directory
  assert.equal((await create({ name: 'Willow Hollow', template: 'hello-hamlet' })).status, 401);
  assert.equal(asks.length, 0);

  const made = await create({ name: 'Willow Hollow', template: 'hello-hamlet', godName: 'Ada' }, 'Bearer dev:ada');
  const out = await made.json();
  assert.equal(made.status, 201, JSON.stringify(out));
  assert.deepEqual([out.slug, out.url, out.engine, out.claimed], ['willow-hollow', '/w/willow-hollow/?dev=1&new=1', 'new', true]);
  assert.equal(asks.length, 2, 'asked twice: placement under way, then ready');
  assert.equal(asks[0].key, asks[1].key, 'one key for the one click'); assert.match(asks[0].key, /^[0-9a-f]{32}$/);
  assert.deepEqual(asks.map(a => [a.name, a.label, a.template, a.authorization]), Array(2).fill(['willow-hollow', 'Willow Hollow', 'hello-hamlet', 'Bearer test:ada']),
    'as the signed-in person (the dev sign-in is the directory\'s test sign-in)');
  assert.equal(rows.get('willow-hollow').creator, 'principal-of-ada', 'owned by that person');

  // served at its own address, from the stream, and listed under its label
  const page = await fetch(`${base}/w/willow-hollow/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200); assert.equal(page.headers.get('x-souls-engine'), 'new');
  const c = JSON.parse(/<script>window\.__simConfig=(\{.*?\})<\/script>/.exec(await page.text())[1]);
  assert.deepEqual([c.worldKey, c.worldName, c.v2Stream], ['willow-hollow', 'Willow Hollow', '/s/w/willow-hollow/views/1/']);
  const list = await (await fetch(`${base}/__sim/worlds.json`)).json();
  const listed = list.worlds.find(w => w.slug === 'willow-hollow');
  assert.deepEqual([listed?.name, listed?.engine, listed?.template, listed?.god], ['Willow Hollow', 'new', 'hello-hamlet', true]);
  assert.equal((await (await fetch(`${base}/__sim/worlds/willow-hollow`)).json()).world?.name, 'Willow Hollow', 'the one-world read the page asks for');
  assert.deepEqual(started, [], 'no old world process was started');
  assert.equal(existsSync(join(data, 'worlds', 'willow-hollow')), false, 'no old world folder was made');

  // the page's /v1/me names the signed-in visitor; signed out it is 401, as on an old world
  const me = await fetch(`${base}/w/willow-hollow/v1/me`, { headers: { authorization: 'Bearer dev:ada' } });
  assert.equal(me.status, 200); assert.equal((await me.json()).me.userId, 'dev:ada');
  assert.equal((await fetch(`${base}/w/willow-hollow/v1/me`)).status, 401);

  // the same name again gets the next address; a directory refusal is passed on by name, and nothing is served
  const second = await (await create({ name: 'Willow Hollow', template: 'hello-hamlet' }, 'Bearer dev:bo')).json();
  assert.equal(second.slug, 'willow-hollow-2');
  const refused = await create({ name: 'Elsewhere', template: 'nowhere' }, 'Bearer dev:ada');
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'template-missing');
  assert.equal((await fetch(`${base}/w/elsewhere/`, { headers: { accept: 'text/html' } })).status, 404);

  // paused on the site (soul.game until Gene's yes): refused before the directory is asked
  const before = asks.length;
  assert.equal((await fetch(`${base}/__sim/op/set-site`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"creation":false}' })).status, 200);
  const paused = await create({ name: 'Paused', template: 'hello-hamlet' }, 'Bearer dev:ada');
  assert.equal(paused.status, 503); assert.equal((await paused.json()).code, 'site.creation-paused');
  assert.equal(asks.length, before);
});

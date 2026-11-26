// The agents' relay and the front door's routing to it (stage 2c, #4152): agent paths reach the relay's port, viewer
// paths the origin's, and the relay carries a socket to the world's mapped gateway and refuses as world-routes.mjs does.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createAgents } from './agents.mjs';

const caddy = readFileSync(fileURLToPath(new URL('../ops/proxy/soul-game.caddy', import.meta.url)), 'utf8');
/** The front door's named matcher's path regexp, as RE2 reads it (these patterns mean the same in JavaScript). */
const matcher = (name) => new RegExp(new RegExp(`@${name} path_regexp (?:\\w+ )?(\\S+)`).exec(caddy)[1]);
/** The first loopback port the front door's `handle @<name>` block proxies to (for agents: a switched world's relay). */
const upstream = (name) => new RegExp(`handle @${name} \\{[\\s\\S]*?reverse_proxy localhost:(\\d+)`).exec(caddy)[1];

test('the front door sends every agent path to the relay on 7330; the page and its reads stay with today\'s launcher (F4)', () => {
  const agents = matcher('agents');
  assert.equal(upstream('agents'), '7330');
  for (const base of ['/w/eden', '/w/new-town']) {
    for (const path of ['v2/ws', 'v2/creator-token', 'v2/creator-upload', 'v2/creator-edit', 'v2/creator-helper', 'v2/entries', 'v2/kinds', `v2/uploads/1220${'ab'.repeat(32)}`]) assert.ok(agents.test(`${base}/${path}`), `${base}/${path} reaches the relay`);
    for (const path of ['v2/uploads/abc', `v2/uploads/1220${'ab'.repeat(32)}/x`, 'v2/uploads/']) assert.ok(!agents.test(`${base}/${path}`), `${base}/${path} is no upload`);
    for (const path of ['', 'views/world.json', 'eden.mjs', 'v1/config']) assert.ok(!agents.test(`${base}/${path}`), `${base}/${path} stays with today's launcher`);
  }
  // a switched world's bootstrap goes to the viewers' origin, for the new Soul client's pairing (F4)
  const bootstrap = matcher('bootstrap');
  assert.equal(upstream('bootstrap'), '7320');
  assert.ok(bootstrap.test('/w/eden/v1/bootstrap') && !bootstrap.test('/w/eden/v1/bootstrapx') && !agents.test('/w/eden/v1/bootstrap'));
  assert.doesNotMatch(caddy, /@native|@page|preview/, 'no page, native read or preview route to the new system');
  for (const path of ['/w/eden/v2/ws/x', '/w/eden/v2/wsx', '/v2/ws', '/w/eden/s/v2/ws', '/preview/w/eden/v2/ws']) assert.ok(!agents.test(path), path);
});

test('the front door sends the owner\'s Soul calls of a world page to the directory on 7310, its retire too (0.137)', () => {
  const paths = /@pairing path (.+)/.exec(caddy)[1].trim().split(/\s+/);
  assert.equal(upstream('pairing'), '7310');
  // Retire for good on a Soul card of a new-engine world: answered 404 by today's launcher when it was not routed
  for (const p of ['/v1/account/souls', '/v1/account/souls/profile', '/v1/account/souls/retire', '/v1/account/view-token']) assert.ok(paths.includes(p), p);
  // The card's Keep (clears the agent's ask) and Disconnect on a new-engine world: the old page's revoke has the Soul's id between
  for (const p of ['/v1/account/souls/keep', '/v1/account/souls/revoke']) assert.ok(paths.includes(p), p);
});

let dir, gateway, relay, stats, port, asked;
before(async () => {
  const scratch = fileURLToPath(new URL('../../../.local/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, 'v2-agents-'));
  // A gateway stand-in: answers its socket path with 101 and echoes what follows.
  // K3: an allowed upload answers its bytes, immutable; any other path 404
  gateway = createServer((req, res) => (req.url === `/v2/uploads/1220${'cd'.repeat(32)}` ? res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'public, max-age=31536000, immutable' }).end('glb') : res.writeHead(404).end()));
  gateway.on('upgrade', (req, socket) => {
    asked = req.url;
    if (req.url !== '/v2/ws' && req.url !== '/v2/ws?free=1') return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  await new Promise((ok) => gateway.listen(0, '127.0.0.1', ok));
  const routes = join(dir, 'worlds.json');
  writeFileSync(routes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: {
    eden: { gateway: `http://127.0.0.1:${gateway.address().port}`, stream: '/s/eden/', canonical: true },
    old: { gateway: `http://127.0.0.1:${gateway.address().port}`, stream: '/s/old/', canonical: true, archived: true },
  } }));
  ({ server: relay, stats } = createAgents(routes));
  await new Promise((ok) => relay.listen(0, '127.0.0.1', ok));
  port = relay.address().port;
});
after(() => {
  relay.close(); gateway.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Opens a raw socket upgrade at `path`; resolves with the socket and the first bytes answered. */
const upgrade = (path, extra = '') => new Promise((ok, fail) => {
  const s = connect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extra}\r\n`));
  s.once('data', (d) => ok({ s, head: String(d) }));
  s.once('error', fail);
});

test('the relay carries an agent socket to the world\'s gateway and counts it while open', async () => {
  const { s, head } = await upgrade('/w/eden/v2/ws');
  assert.match(head, /^HTTP\/1\.1 101 /);
  assert.equal(stats.open, 1);
  const echoed = new Promise((ok) => s.once('data', (d) => ok(String(d))));
  s.write('hello gateway');
  assert.equal(await echoed, 'hello gateway');
  s.end();
  await new Promise((ok) => s.once('close', ok));
  for (let i = 0; i < 50 && stats.open; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.equal(stats.open, 0);
  const preview = await upgrade('/preview/w/eden/v2/ws');
  assert.match(preview.head, /^HTTP\/1\.1 101 /);
  preview.s.destroy();
});

test('a replaced agent\'s sign-in that asks only if its Soul is free keeps its `?free=1`; any other query is refused', async () => {
  const { s, head } = await upgrade('/w/eden/v2/ws?free=1');
  s.destroy();
  assert.match(head, /^HTTP\/1\.1 101 /);
  assert.equal(asked, '/v2/ws?free=1');
  for (const path of ['/w/eden/v2/ws?free=0', '/w/eden/v2/ws?free=1&x=1', '/w/eden/v2/entries?free=1']) {
    const other = await upgrade(path);
    other.s.destroy();
    assert.match(other.head, /^HTTP\/1\.1 (400|405) /, path);
  }
});

test('the relay refuses as the origin does: unrouted, archived, foreign Origin, not a world path', async () => {
  for (const [path, extra, status, word] of [
    ['/w/nowhere/v2/ws', '', 404, 'world-not-routed'],
    ['/w/old/v2/ws', '', 410, 'world-archived'],
    ['/w/eden/v2/ws', 'Origin: https://elsewhere.example.test\r\n', 403, 'origin-refused'],
    ['/w/eden/v1/other', '', 404, 'world-not-routed'],
  ]) {
    const { s, head } = await upgrade(path, extra);
    s.destroy();
    assert.match(head, new RegExp(`^HTTP/1\\.1 ${status} `), path);
    assert.match(head, new RegExp(word), path);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/s/eden/pointer`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/w/eden/v2/ws`)).status, 405);
});

test('K3: a switched world\'s allowed upload passes through the relay as the gateway serves it, GET and HEAD only', async () => {
  const at = `http://127.0.0.1:${port}/w/eden/v2/uploads/1220`;
  const r = await fetch(`${at}${'cd'.repeat(32)}`);
  assert.equal(r.status, 200); assert.equal(await r.text(), 'glb');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'immutable, as the gateway says');
  assert.equal((await fetch(`${at}${'cd'.repeat(32)}`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${at}${'ef'.repeat(32)}`)).status, 404, 'not an allowed upload');
  assert.equal((await fetch(`${at}${'cd'.repeat(32)}`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/w/old/v2/uploads/1220${'cd'.repeat(32)}`)).status, 410, 'an archived world serves none');
});

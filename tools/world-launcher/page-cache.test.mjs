// node --test tools/world-launcher/page-cache.test.mjs (#2515, Scaling E3; proxy and a fake world on a free block of ports)
// A burst of arrivals costs the world one page build every 2 s: the launcher keeps the world page (the answer the world
// marks X-Sim-Page) by its path, whether it has a query, the world process and the host headers, never the query itself
// or the caller's cookie. The public world list carries the CDN's brief-keep header without a token, never with one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(3);

const PORT = P0 + 2, RANGE = [P0, P0 + 1];
const dir = mkdtempSync(join(tmpdir(), 'launcher-page-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
const webDir = join(dir, 'web'); mkdirSync(webDir);
const hits = join(dir, 'hits.log');
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_HITS: hits } });
const L = await openLauncher({ port: PORT, range: RANGE, dataDir: join(dir, 'data'), webDir, templatesDir, command, eager: 0, log: () => {} });
after(async () => { await L.close(); });
const api = (p, o = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => (existsSync(hits) ? readFileSync(hits, 'utf8') : '').split('\n');
const pages = () => log().filter((l) => l === '/' || l.startsWith('/?')).length;
const browser = { accept: 'text/html,application/xhtml+xml', cookie: '__session=signed-in' };
const made = await api('/__sim/worlds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Page Town' }) });
const { slug } = await made.json(), w = `/w/${slug}`;
await (await api(w + '/healthz')).arrayBuffer();   // the world is up before the burst

test('A1: 200 arrivals at 20 a second cause at most 6 page builds in the world', async () => {
  const before = pages(), all = [];
  for (let i = 0; i < 200; i++) { all.push(api(`${w}/${i % 2 ? `?utm=${i}` : ''}`, { headers: browser }).then(async (r) => { assert.equal(r.status, 200); await r.arrayBuffer(); })); await sleep(50); }
  await Promise.all(all);
  const built = pages() - before;
  assert.ok(built >= 1 && built <= 6, `${built} page builds for 200 arrivals`);
  // the uneven arm's wave: 50 arrivals at once after the page has lapsed wait for one build
  await sleep(2100);
  const wave = pages(), tags = await Promise.all(Array.from({ length: 50 }, (_, i) => api(`${w}/?wave=${i}`, { headers: browser }).then(async (r) => { await r.arrayBuffer(); return r.headers.get('x-sim-cache'); })));
  assert.equal(pages() - wave, 1, 'one page build for a wave of 50'); assert.equal(tags.filter((t) => t === null).length, 1);
});

test('A2: a request with a random query string is served from the cache; the query-less page keeps its own headers', async () => {
  await sleep(2100);
  const first = await api(`${w}/?ref=${Math.random()}`, { headers: browser });
  assert.equal(first.headers.get('x-sim-cache'), null, 'the first arrival is proxied to the world'); await first.arrayBuffer();
  const again = await api(`${w}/?ref=${Math.random()}`, { headers: browser });
  assert.equal(again.headers.get('x-sim-cache'), 'hit'); assert.equal(again.headers.get('x-robots-tag'), 'noindex, nofollow'); await again.arrayBuffer();
  const bare = await api(`${w}/`, { headers: browser }); await bare.arrayBuffer();
  assert.equal(bare.headers.get('x-robots-tag'), null, 'the indexable page is never answered with a query variant\'s noindex');
  // another host is its own entry (the page's URLs are made from it); another route is never answered with the page
  const other = await api(`${w}/?x=1`, { headers: { ...browser, 'x-forwarded-host': 'other.example' } }); await other.arrayBuffer();
  assert.equal(other.headers.get('x-sim-cache'), null);
  const studio = log().filter((l) => l.startsWith('/studio')).length;
  for (const q of ['?a=1', '?a=2']) assert.equal(await (await api(`${w}/studio${q}`, { headers: browser })).text(), `<p>studio /studio${q}</p>`);
  assert.equal(log().filter((l) => l.startsWith('/studio')).length - studio, 2, 'an HTML route the world does not mark as its page is not kept');
});

test('A4: a signed-in browser gets the world\'s own page bytes from the cache', async () => {
  await sleep(2100);
  const fromWorld = await api(`${w}/`, { headers: { accept: 'text/html' } });
  assert.equal(fromWorld.headers.get('x-sim-cache'), null); const worldBytes = Buffer.from(await fromWorld.arrayBuffer());
  const signedIn = await api(`${w}/`, { headers: browser });
  assert.equal(signedIn.headers.get('x-sim-cache'), 'hit');
  assert.deepEqual(Buffer.from(await signedIn.arrayBuffer()), worldBytes);
  assert.ok(worldBytes.includes('window.__simConfig'));
});

test('A3: the public world list carries the CDN header without a token, not with one', async () => {
  const anon = await api('/__sim/worlds.json');
  assert.equal(anon.headers.get('cloudflare-cdn-cache-control'), 'max-age=5, stale-while-revalidate=30'); await anon.arrayBuffer();
  const signed = await api('/__sim/worlds.json', { headers: { authorization: 'Bearer dev:alice' } });
  assert.equal(signed.headers.get('cloudflare-cdn-cache-control'), null); await signed.arrayBuffer();
});

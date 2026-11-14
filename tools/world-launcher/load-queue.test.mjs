// #2304: loads are queued by priority and capped; pages and crawlers load nothing. Stub worlds (fake-world.mjs) on a
// free block of ports, from a registry (and recorded horizons) written before the launcher opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawlerAgent, openLauncher } from './launcher.mjs';
import { ChildPool, UNLOADED } from './children.mjs';
import { BUSY_CODES } from './soul/eden.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const N = 50;
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms, what) => { const t0 = Date.now(); for (;;) { if (await ok()) return; if (Date.now() - t0 > ms) assert.fail(`not within ${ms} ms: ${what}`); await wait(20); } };
const slugs = (n) => Array.from({ length: n }, (_, i) => `w${String(i + 1).padStart(2, '0')}`);
const SOUL = { authorization: 'Bearer soul_test', 'content-type': 'application/json' };
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** A launcher over `n` registered worlds, none running; `horizon(slug)` (optional) is each one's recorded horizon. */
async function launcher(n, { bootMs = 50, horizon, ...o } = {}) {
  const P = await testPort(n + 2);   // (each launcher its own block: a stopped world's port may linger)
  const dir = mkdtempSync(join(tmpdir(), 'load-queue-')), dataDir = join(dir, 'data');
  mkdirSync(dataDir); const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
  const webDir = join(dir, 'web'); mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><head><title>Souls</title><link rel="canonical" href="https://x/"></head><body></body></html>');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  const names = slugs(n);
  writeFileSync(join(dataDir, 'worlds.json'), JSON.stringify({ worlds: names.map((slug, i) => ({ slug, name: `World ${slug}`, template: 'empty', createdAt: i })) }));
  if (horizon) writeFileSync(join(dataDir, 'horizons.json'), JSON.stringify(Object.fromEntries(names.map((s) => [s, horizon(s)]))));
  const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1', FAKE_BOOT_MS: String(bootMs) } });
  const L = await openLauncher({ port: P, range: [P + 1, P + n + 1], dataDir, webDir, templatesDir, command, eager: 0, keepAlive: false, prewarm: false, maxRunning: n + 1, log: () => {},
    stillEveryMs: 1e9, stillAlarmMs: 1e9, ...o });
  return { L, base: `http://127.0.0.1:${P}`, names };
}
const act = (base, slug) => { const t0 = Date.now(); return fetch(`${base}/w/${slug}/v1/edge/act`, { method: 'POST', headers: SOUL, body: '{}' }).then(async (r) => ({ status: r.status, ms: Date.now() - t0, retry: r.headers.get('retry-after'), body: await r.json() })); };

test('A6/A1/A7: 50 alarms due in the same second load at most 4 at a time and are all served; an act meanwhile goes first', { timeout: 120_000 }, async () => {
  const due = Date.now() - 1;
  const { L, base, names } = await launcher(N, { bootMs: 300, unloadStill: true, horizon: () => ({ still: true, untilWallMs: null, moveWallMs: due, at: due }) });
  try {
    let peak = 0; const watch = setInterval(() => { peak = Math.max(peak, [...L.pool.kids.values()].filter((k) => k.status === 'starting').length, L.pool.loadStats().loading); }, 5);
    assert.deepEqual(L.still.alarms().length, N, 'every alarm is due at once');
    await wait(100);
    const h = await (await fetch(`${base}/__sim/healthz`)).json();
    assert.equal(h.loads.parallel, 4);
    assert.equal(h.loads.loading, 4);
    assert.equal(h.loads.waitingByReason.winddown, N - 4, 'the rest wait, by reason (A7)');
    const last = names.at(-1), r = await act(base, last);   // the last alarm in the queue: its act goes before the other alarms
    assert.equal(r.status, 200); assert.equal(r.body.acted, true);
    const up = (s) => L.pool.state(s)?.upSince ?? Infinity, before = names.filter((s) => s !== last && up(s) > up(last)).length;
    assert.ok(before >= N - 12, `the act's world loaded before ${before} of the other ${N - 1} (they were waiting)`);
    await until(() => names.every((s) => L.pool.status(s).status === 'running'), 60_000, 'every alarm served');
    clearInterval(watch);
    assert.ok(peak <= 4, `at most 4 loads at once (peak ${peak})`);
    const s = (await (await fetch(`${base}/__sim/healthz`)).json()).loads;
    assert.equal(s.waiting, 0); assert.equal(s.lastWaitsMs.n, N);
    assert.ok(s.lastWaitsMs.median > 0 && s.lastWaitsMs.p95 >= s.lastWaitsMs.median && s.lastWaitsMs.max >= s.lastWaitsMs.p95, JSON.stringify(s.lastWaitsMs));
    console.log(`# A6: ${N} alarms, peak ${peak} loads at once; act served in ${r.ms} ms, ahead of ${before}; waits ${JSON.stringify(s.lastWaitsMs)}`);
  } finally { await L.close(); }
});

test('A6/A4/A3: a crawler fetching 50 world pages loads none; a visitor gets the page without a load, its data request loads it', { timeout: 60_000 }, async () => {
  const { L, base, names } = await launcher(N, { unloadStill: true });
  try {
    const pages = await Promise.all(names.map((s) => fetch(`${base}/w/${s}/`, { headers: { 'user-agent': GOOGLEBOT, accept: 'text/html' } })));
    for (const p of pages) { assert.equal(p.status, 200); assert.match(p.headers.get('content-type'), /text\/html/); assert.match(await p.text(), /<title>World w\d\d · Souls<\/title>/); }
    const data = await fetch(`${base}/w/w01/v1/config`, { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
    assert.equal(data.status, 503, 'a crawler gets the page only'); assert.equal((await data.json()).code, 'world.unloaded');
    await wait(200);
    assert.deepEqual(names.filter((s) => L.pool.status(s).status !== 'stopped'), [], 'no world loaded');
    // A3: a visitor's page and its static files come from here; its first data request loads the world
    const page = await fetch(`${base}/w/w02/`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200); assert.equal(page.headers.get('x-sim-cache'), 'unloaded');
    assert.equal((await fetch(`${base}/w/w02/assets/app.js`)).status, 200);
    assert.equal(L.pool.status('w02').status, 'stopped', 'the page and its files loaded nothing');
    assert.equal((await fetch(`${base}/w/w02/v1/config`)).status, 200);
    assert.equal(L.pool.status('w02').status, 'running', 'the data request loaded it');
    assert.equal(crawlerAgent('Mozilla/5.0 HeadlessChrome/120 EdenEyes/1'), false, 'the Eyes renderer is not a crawler');
  } finally { await L.close(); }
});

test('A2: an act to a world fourth in the queue is held and served; past the hold it gets world.waking, which the client retries', { timeout: 60_000 }, async () => {
  const { L, base } = await launcher(4, { bootMs: 500, loadParallel: 1, loadHoldMs: 6000 });
  try {
    const acts = [];
    for (const s of slugs(4)) { acts.push(act(base, s)); await wait(30); }
    await wait(50);
    assert.equal(L.pool.status('w04').status, 'waiting', 'w04 is fourth: one loading, two ahead of it');
    const out = await Promise.all(acts);
    for (const r of out) assert.equal(r.status, 200, JSON.stringify(r));
    assert.ok(out[3].ms >= 1400, `the fourth waited for three loads (${out[3].ms} ms)`);
  } finally { await L.close(); }
  const { L: L2, base: b2 } = await launcher(1, { bootMs: 1500, loadHoldMs: 300 });
  try {
    const r = await act(b2, 'w01');
    assert.equal(r.status, 503); assert.equal(r.body.code, 'world.waking'); assert.equal(r.retry, '5');
    assert.ok(BUSY_CODES.has('world.waking'), 'the Soul client waits out Retry-After and asks again');
    await until(() => L2.pool.status('w01').status === 'running', 5000, 'the load goes on');
    assert.equal((await act(b2, 'w01')).status, 200);
  } finally { await L2.close(); }
});

test('A5: with --unload-still nothing loads at start (no eager loads); without it the eager loads stay', { timeout: 30_000 }, async () => {
  const { L } = await launcher(3, { unloadStill: true, eager: 3 });
  try { await wait(500); assert.deepEqual(slugs(3).map((s) => L.pool.status(s).status), ['stopped', 'stopped', 'stopped']); } finally { await L.close(); }
  const { L: L2 } = await launcher(3, { eager: 3 });
  try { await until(() => slugs(3).every((s) => L2.pool.status(s).status === 'running'), 5000, 'eager loads'); } finally { await L2.close(); }
});

test('A5: in a handover a world the release asks to leave unloaded is not moved; a request then loads it here', { timeout: 30_000 }, async () => {
  const P = await testPort(4), logDir = mkdtempSync(join(tmpdir(), 'load-queue-h-'));
  const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } });
  const pool = (range, o = {}) => new ChildPool({ root: process.cwd(), range, logDir, command, healthPath: (s) => `/w/${s}/healthz`, loadParallel: 4, ...o });
  const a = pool([P, P + 1]), b = pool([P + 2, P + 3], { afterRelease: async () => false });
  try {
    const w = { slug: 'still' };
    await a.ensure(w);
    const { port, child: { pid } } = a.state('still');
    b.adopt(w, { port, pid, script: fake });
    assert.equal(await b.takeOver('still', () => a.stop('still')), UNLOADED);
    assert.equal(b.status('still').status, 'stopped');
    assert.equal(a.status('still').status, 'stopped', 'the previous process is gone');
    assert.ok(Number.isInteger(await b.ensure(w, { reason: 'act' })), 'loaded on its next request');
    assert.equal(b.status('still').status, 'running');
  } finally { await a.closeAll(); await b.closeAll(); }
});

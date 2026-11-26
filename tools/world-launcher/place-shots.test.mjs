import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { drawRun, placeShotKeeper, placeShots, targetKey } from './place-shots.mjs';

const target = { ref: 'e_balloon', title: 'Eden balloon', point: [-20, 6.2, -9], radius: 5.6, enclosed: false };
const places = [{ target }, { target: { ...target, ref: 'e_moved' } }, { target: { ...target, ref: 'e_new' } }];

test('a moved world\'s kept Explore picture is served small and immutable; a place without a current one is drawn by the page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'place-shots-')), sha = 'a'.repeat(64);
  mkdirSync(join(dir, 'eden'));
  writeFileSync(join(dir, 'eden', `${sha}.webp`), Buffer.from('RIFF0000WEBP'));
  writeFileSync(join(dir, 'eden', 'index.json'), JSON.stringify({ schema: 'place-shots/1', shots: {
    e_balloon: { target: targetKey(target), sha, bytes: 12 }, e_moved: { target: targetKey({ ...target, point: [0, 0, 0] }), sha, bytes: 12 } } }));
  const told = [], shots = placeShots({ dir, log: (s) => told.push(s) });
  assert.deepEqual(shots.views('eden', ['e_balloon', 'e_moved', 'e_new', 'e_gone'], places), [
    { ref: 'e_balloon', status: 'ready', thumb: `/v1/world/context/shot/${sha}.webp` },
    { ref: 'e_moved', status: 'unavailable', draw: 'page' },
    { ref: 'e_new', status: 'unavailable', draw: 'page' },
    { ref: 'e_gone', status: 'unavailable', draw: 'page' }]);
  shots.views('eden', ['e_new'], places);
  assert.equal(told.length, 1, 'said once per world and index'); assert.match(told[0], /eden has 2 of 3 places without a kept picture/);
  assert.equal(shots.views('other', ['e_balloon'], places)[0].draw, 'page', 'another world\'s pictures are its own');
  const server = createServer((req, res) => { if (!shots.serve(req, res, 'eden', req.url)) res.writeHead(418).end(); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/v1/world/context/shot/${sha}.webp`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await r.arrayBuffer()).byteLength, 12);
    assert.equal((await fetch(`${base}/v1/world/context/shot/${sha}.webp`, { headers: { 'if-none-match': `"${sha}"` } })).status, 304);
    assert.equal((await fetch(`${base}/v1/world/context/shot/${'b'.repeat(64)}.webp`)).status, 404);
    assert.equal((await fetch(`${base}/v1/world/context/shot/x/index.json`)).status, 418, 'only a hash-named picture is the route');
  } finally { server.close(); }
});

test('a world with no picture of its own shows its fullest kept place picture on the home page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'place-shots-')), small = 'a'.repeat(64), big = 'b'.repeat(64);
  mkdirSync(join(dir, 'eden'));
  for (const [sha, n] of [[small, 10], [big, 20]]) writeFileSync(join(dir, 'eden', `${sha}.webp`), Buffer.alloc(n));
  writeFileSync(join(dir, 'eden', 'index.json'), JSON.stringify({ schema: 'place-shots/1', shots: {
    a: { target: 't', sha: small, bytes: 10 }, b: { target: 't', sha: big, bytes: 20 }, gone: { target: 't', sha: 'c'.repeat(64), bytes: 99 } } }));
  const shots = placeShots({ dir });
  assert.equal(shots.cover('eden'), `/v1/world/context/shot/${big}.webp`, 'the most bytes, among files that exist');
  assert.equal(shots.cover('other'), null, 'none kept: no picture');
});

test('#5038: the keeper draws a moved world\'s missing pictures ahead of visitors, one run at a time, and keeps them across releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'place-shots-keep-')), runs = [], told = [];
  const worlds = [{ slug: 'eden', places }, { slug: 'mars', places: [{ target }] }];
  // a drawing run that draws every place of its world but `skip`
  let skip = new Set(), open = 0, most = 0;
  const run = async ({ slug, page, out }) => {
    runs.push([slug, page]); open++; most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 5));
    mkdirSync(out, { recursive: true });
    const kept = {};
    for (const { target: t } of worlds.find((w) => w.slug === slug).places) {
      if (skip.has(t.ref)) continue;
      const sha = createHash('sha256').update(slug + t.ref).digest('hex');
      writeFileSync(join(out, `${sha}.webp`), Buffer.from('RIFF0000WEBP')); kept[t.ref] = { target: targetKey(t), sha, bytes: 12 };
    }
    writeFileSync(join(out, 'index.json'), JSON.stringify({ schema: 'place-shots/1', shots: kept }));
    open--; return { code: 0 };
  };
  const shots = placeShots({ dir }), at = { t: 0 };
  const keep = (extra = {}) => placeShotKeeper({ shots, dir, worlds: () => worlds, page: (s) => `https://example.test/w/${s}/`, run, log: (s) => told.push(s), firstMs: 1e9, everyMs: 1e9, now: () => at.t, ...extra });
  const k = keep();
  try {
    skip = new Set(['e_new']);
    await k.check();
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 20)); while (k.status().running) await new Promise((r) => setTimeout(r, 5)); }
    assert.deepEqual(runs, [['eden', 'https://example.test/w/eden/'], ['mars', 'https://example.test/w/mars/']], 'each world with missing pictures, in turn');
    assert.equal(most, 1, 'one drawing run at a time');
    assert.deepEqual(k.status().missing, { eden: 1, mars: 0 });
    assert.deepEqual(shots.views('eden', ['e_balloon', 'e_new'], places).map((v) => v.status), ['ready', 'unavailable'], 'a visitor gets the kept pictures');
    assert.equal(k.status().last.slug, 'mars');
    await k.check();
    assert.equal(runs.length, 2, 'a run that left the same place missing is not repeated');
    at.t += 7 * 3600_000; skip = new Set();
    await k.check();
    assert.deepEqual(runs.at(-1)[0], 'eden', 'after the retry time it is tried again');
    assert.deepEqual(k.status().missing, { eden: 0, mars: 0 });
  } finally { k.close(); }
  // the next release: a new keeper over the same kept pictures draws nothing
  const next = keep();
  try { assert.equal(await next.check(), null); assert.equal(runs.length, 3, 'nothing is drawn again after a release'); } finally { next.close(); }
  // a place that moves is drawn again; nothing is drawn while there is no room for it
  worlds[1].places = [{ target: { ...target, point: [1, 2, 3] } }];
  const tight = keep({ canStart: () => false });
  try { assert.equal(await tight.check(), null); assert.equal(runs.length, 3, 'no run without room'); } finally { tight.close(); }
  const moved = keep();
  try { await moved.check(); assert.deepEqual(runs.at(-1)[0], 'mars', 'the moved place is drawn again'); } finally { moved.close(); }
  assert.ok(told.some((s) => /drawing 1 of 3 places of eden ahead of visitors/.test(s)), told.join('\n'));
});

test('#5038: a drawing run is its own process, ended at its deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'place-shots-run-'));
  // a page that never answers its snapshot: the CLI waits on it until the deadline ends the run
  const server = createServer(() => {});
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const t0 = Date.now(), r = await drawRun({ page: `http://127.0.0.1:${server.address().port}/w/eden/`, out: join(dir, 'eden'), deadlineMs: 1500 });
    assert.equal(r.signal, 'SIGTERM'); assert.ok(Date.now() - t0 < 12_000);
    const stop = new AbortController(), running = drawRun({ page: `http://127.0.0.1:${server.address().port}/w/eden/`, out: join(dir, 'eden'), deadlineMs: 60_000, signal: stop.signal });
    setTimeout(() => stop.abort(), 300);
    assert.equal((await running).signal, 'SIGTERM', 'a closing launcher ends its run');
  } finally { server.closeAllConnections(); server.close(); }
});

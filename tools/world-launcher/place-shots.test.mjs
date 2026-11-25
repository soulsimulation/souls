import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeShots, targetKey } from './place-shots.mjs';

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

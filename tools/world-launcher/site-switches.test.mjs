// node --test tools/world-launcher/site-switches.test.mjs
// #2540 A1/A2: the operator's site switches (op.mjs set-site). Uploads off refuses POST to the four upload routes with
// 503 site.uploads-paused and nothing else; creation off refuses POST /__sim/worlds with 503 site.creation-paused and
// nothing else; acts, viewing and asset reads pass; each change is an audit row and survives a launcher restart.
// Fake world processes (fake-world.mjs), a temp data dir, free ports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

const P = await testPort(3), base = `http://127.0.0.1:${P}`, dir = mkdtempSync(join(tmpdir(), 'site-switches-'));
const fake = new URL('./fake-world.mjs', import.meta.url).pathname;
const command = (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port), FAKE_ACT: '1' } });
const open = () => openLauncher({ port: P, range: [P + 1, P + 2], dataDir: join(dir, 'data'), command, eager: 0, log: () => {} });
let L = await open();
after(async () => { await L?.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body ?? {}) });
const setSite = async (b) => { const r = await post('/__sim/op/set-site', b); assert.equal(r.status, 200); return (await r.json()).site; };
const site = async () => (await (await fetch(`${base}/__sim/healthz`)).json()).site;
async function paused(r, code) {
  assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '600');
  const b = await r.json(); assert.equal(b.code, code); assert.equal(b.retry_after, 600); assert.deepEqual(b.limit, { scope: 'site' }); assert.match(b.message, /paused on this site.*Try again in 10 minutes/);
}
const notPaused = async (r) => { const t = await r.text(); assert.doesNotMatch(t, /paused/, `${r.status} ${t.slice(0, 120)}`); return r.status; };

test('uploads off refuses the four upload routes and nothing else; creation off refuses creation and nothing else', async () => {
  assert.deepEqual(await site(), { uploads: true, creation: true }, 'both on by default');
  const made = await post('/__sim/worlds', { name: 'Switch world' }); assert.equal(made.status, 201, await made.clone().text());
  const { slug } = await made.json(), w = `/w/${slug}`;
  const sha = 'a'.repeat(64), bytes = new Uint8Array([1, 2, 3]);
  const uploads = () => [post(`${w}/v1/god/assets`, bytes, { authorization: 'Bearer god_x' }), post(`${w}/v1/art/media`, bytes, { authorization: 'Bearer god_x' }), post(`${w}/v1/edge/body/uploads`, bytes, { authorization: 'Bearer s_x' }), post(`/__sim/worlds/${slug}/thumbnail`, bytes)];
  const others = () => [fetch(`${base}${w}/assets/${sha}.glb`), fetch(`${base}${w}/v1/god/assets/${sha}`), fetch(`${base}${w}/art/${sha}.png`), fetch(`${base}${w}/v1/world/snapshot`), post(`${w}/v1/edge/act`, { capability: 'wave' }, { authorization: 'Bearer sim_s_soul1_secret' })];

  assert.deepEqual(await setSite({ uploads: false }), { uploads: false, creation: true });
  for (const r of await Promise.all(uploads())) await paused(r, 'site.uploads-paused');
  const [, , , snap, act] = await Promise.all(others().map((p) => p.then(notPaused)));
  assert.equal(snap, 200, 'viewing passes'); assert.equal(act, 200, 'an act passes');
  assert.equal(await notPaused(await fetch(`${base}/__sim/worlds/${slug}/thumbnail`, { method: 'DELETE' })), 401, 'clearing a thumbnail is not an upload');
  const second = await post('/__sim/worlds', { name: 'Still made' }); assert.equal(second.status, 201, 'creation is not refused by the uploads switch');
  assert.deepEqual(await site(), { uploads: false, creation: true });

  assert.deepEqual(await setSite({ uploads: true, creation: false }), { uploads: true, creation: false });
  await paused(await post('/__sim/worlds', { name: 'Not made' }), 'site.creation-paused');
  for (const r of await Promise.all(uploads())) await notPaused(r);
  const [, , , snap2, act2] = await Promise.all(others().map((p) => p.then(notPaused)));
  assert.equal(snap2, 200); assert.equal(act2, 200);
  assert.deepEqual(await site(), { uploads: true, creation: false });
  assert.equal((await post('/__sim/op/set-site', { uploads: 'off' })).status, 400, 'only booleans');
  assert.equal((await post('/__sim/op/set-site', { uploads: false }, { 'x-forwarded-for': '203.0.113.9' })).status, 403, 'operator only');
});

test('each change is an audit row and survives a launcher restart', async () => {
  const rows = (await (await post('/__sim/op/audit', {})).json()).audit.filter((x) => x.op === 'set-site');
  assert.deepEqual(rows.map((x) => [x.by, x.before, x.site]), [
    ['operator', { uploads: true, creation: true }, { uploads: false, creation: true }],
    ['operator', { uploads: false, creation: true }, { uploads: true, creation: false }],
  ]);
  await L.close(); L = await open();
  assert.deepEqual(await site(), { uploads: true, creation: false }, 'read back from worlds.json');
  await paused(await post('/__sim/worlds', { name: 'After restart' }), 'site.creation-paused');
  assert.deepEqual(await setSite({ creation: true }), { uploads: true, creation: true });
  assert.equal((await post('/__sim/worlds', { name: 'Open again' })).status, 201);
});

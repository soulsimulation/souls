// #2049: a Soul's wake rules go with it when it travels or is paired again. In another world the rules naming a place or a
// Soul of the old one are dropped, each with a reason in serve's log. The real CLI and serve against a stand-in world.
// #2082: thing-state rules name the old world's things, so they are dropped too; serve reads a catalog copy another process
// replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carryWake, wakeCatalog } from './soul/eden.mjs';

/** A stand-in world: a quiet inbox and stream, travel to `/w/other` as another Soul id, and pairing that mints a new token. */
async function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-wake-travel-')), w = { dir, token: 'synthetic-first-token' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://w'), p = url.pathname.replace(/^\/w\/other/, '');
    for await (const _ of req) { /* drain */ }
    const json = (status, v) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); } };
    const base = `http://127.0.0.1:${server.address().port}`;
    if (p === '/v1/edge/inbox/listen') { await new Promise((r) => setTimeout(r, Number(url.searchParams.get('timeoutMs')) > 0 ? 200 : 0)); return json(200, { inbox: { connected: true }, backlog: [] }); }
    if (p === '/v1/edge/wait') { await new Promise((r) => setTimeout(r, 200)); return json(200, { events: [], cursor: url.searchParams.get('after') ?? 'c_0' }); }
    if (p === '/v1/edge/travel') return json(200, { ok: true, base: `${base}/w/other`, soulId: 's_there', token: 'synthetic-travel-token' });
    if (p === '/v1/agent/me') return json(req.headers.authorization === `Bearer ${w.token}` ? 200 : 401, { soul: { id: 's_me' } });
    if (p === '/v1/souls/s_me/pair') return json(200, { code: 'PAIR1' });
    if (p === '/v1/agent/pair') { w.token = 'synthetic-second-token'; return json(200, { token: w.token }); }
    return json(404, { error: { code: 'not-found', message: p } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_me', token: w.token, identity: 'id_synthetic' }), { mode: 0o600 });
  w.cli = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* text */ } done({ code, err, json: j }); });
  });
  w.log = () => { try { return readFileSync(join(dir, '.eden-serve.log'), 'utf8'); } catch { return ''; } };
  t.after(async () => { await w.cli('serve', '--stop'); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return w;
}
const until = async (f, ms = 8_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };
const ids = (r) => r.json.rules.map((x) => x.id);

test('#2049: wake rules survive pairing again whole, and travel without the ones naming the old world\'s places or Souls', async (t) => {
  const w = await world(t);
  assert.equal((await w.cli('serve')).code, 0);
  for (const args of [['act-ended'], ['soul-arrives', '{"who":"s_mira"}'], ['soul-arrives', '{"where":"g-hall"}'], ['soul-arrives'], ['place-busy', '{"place":"g-yard","atLeast":2}'], ['thing-state', '{"thing":"e_ch","field":"open"}']]) {
    const r = await w.cli('wake', 'add', ...args);
    assert.equal(r.code, 0, r.err);
  }
  let r = await w.cli('wake');
  assert.deepEqual(ids(r), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'plan-finished', 'event-starting', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6']);

  // Paired again: the old token stopped working, so pairing mints a new one for the same Soul in the same world. The serve
  // restarts for it and every rule is kept.
  w.token = 'synthetic-retired';
  r = await w.cli('pair', 's_me');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.serve?.restarted, true, JSON.stringify(r.json));
  r = await w.cli('wake');
  assert.deepEqual(ids(r), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'plan-finished', 'event-starting', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'], 'kept across pairing again');

  // Travel: the rules go along, except w2 (a Soul of the old world), w3 and w5 (its places), w6 (its thing); each drop is logged.
  r = await w.cli('travel', 'other');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.serve?.restarted, true, JSON.stringify(r.json));
  r = await w.cli('wake');
  assert.deepEqual(ids(r), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'plan-finished', 'event-starting', 'w1', 'w4'], 'kept across travel');
  assert.deepEqual(r.json.rules.find((x) => x.id === 'w4').params, { who: 'any', where: 'here' });
  const log = await until(() => (/dropped w6/.test(w.log()) ? w.log() : null));
  assert.match(log, /wake: dropped w2: it names Soul s_mira of the world this Soul left/);
  assert.match(log, /wake: dropped w3: it names place g-hall of the world this Soul left/);
  assert.match(log, /wake: dropped w5: it names place g-yard of the world this Soul left/);
  assert.match(log, /wake: dropped w6: it names thing e_ch of the world this Soul left/);
  assert.equal((await w.cli('wake', 'add', 'act-ended')).json.added, 'w7', 'new ids do not reuse the dropped ones');
});

const chest = (open) => ({ places: [{ id: 'g-v', name: 'Village', kind: 'area', at: [0, 0] }], acts: [], things: [{ id: 'e_ch', name: 'porch-chest', kind: 'core-chest', place: 'g-v', at: [1, 0] }],
  kinds: { 'core-chest': { acts: [{ verb: 'open', label: 'Open' }], state: { open, locked: false } } } });

test('#2082: a thing-state rule stays in the same world, and the catalog lookups follow the copy\'s version', () => {
  const rule = { id: 'w1', kind: 'thing-state', params: { thing: 'e_ch', field: 'open' }, every: 0, was: 'false' };
  assert.deepEqual(carryWake({ rules: [rule], next: 2 }, true).wake.rules, [rule], 'same world: kept with its state');
  assert.deepEqual(carryWake({ rules: [rule], next: 2 }, false).dropped, [{ id: 'w1', why: 'it names thing e_ch of the world this Soul left' }]);
  const v1 = wakeCatalog(null, { world: 'W', etag: '"1"', catalog: chest(false) }, 'W');
  assert.equal(wakeCatalog(v1, { world: 'W', etag: '"1"', catalog: chest(false) }, 'W'), v1, 'same version: not built again');
  const v2 = wakeCatalog(v1, { world: 'W', etag: '"2"', catalog: chest(true) }, 'W');
  assert.deepEqual([v2.etag, v2.ix.cat.kinds['core-chest'].state.open], ['"2"', true], 'a new version: built from it');
  assert.equal(wakeCatalog(v2, { world: 'X', etag: '"2"', catalog: chest(true) }, 'W'), null, 'a copy of another world is not read');
});

test('#2082: serve reads a catalog copy another process replaced, and thing-state wakes on it', async (t) => {
  const w = await world(t), at = JSON.parse(readFileSync(join(w.dir, '.eden-agent.json'), 'utf8')).world;
  const copy = (etag, open) => writeFileSync(join(w.dir, 'world-catalog.json'), JSON.stringify({ world: at, etag, fetchedAt: new Date().toISOString(), catalog: chest(open) }));
  copy('"1"', false);
  writeFileSync(join(w.dir, 'world-live.json'), JSON.stringify({ world: at, receivedAt: Date.now(), live: { souls: [], things: {} } }));
  assert.equal((await w.cli('serve')).code, 0);
  assert.equal((await w.cli('wake', 'add', 'thing-state', '{"thing":"e_ch","field":"open"}', '--every', '0')).code, 0);
  const was = () => { try { return JSON.parse(readFileSync(join(w.dir, '.eden-serve.json'), 'utf8')).wake.rules.find((x) => x.id === 'w1')?.was; } catch { return undefined; } };
  assert.equal(await until(was), 'false', 'the first look took the default in');
  copy('"2"', true);   // as a command would: the kind's default changed, the live row is still empty
  assert.ok(await until(() => /wake: w1 \(e_ch open is now true\)/.test(w.log())), w.log());
});

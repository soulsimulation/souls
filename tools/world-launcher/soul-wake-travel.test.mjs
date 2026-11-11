// #2049: a Soul's wake rules go with it when it travels or is paired again. In another world the rules naming a place or a
// Soul of the old one are dropped, each with a reason in serve's log. The real CLI and serve against a stand-in world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  for (const args of [['act-ended'], ['soul-arrives', '{"who":"s_mira"}'], ['soul-arrives', '{"where":"g-hall"}'], ['soul-arrives'], ['place-busy', '{"place":"g-yard","atLeast":2}']]) {
    const r = await w.cli('wake', 'add', ...args);
    assert.equal(r.code, 0, r.err);
  }
  let r = await w.cli('wake');
  assert.deepEqual(ids(r), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'w1', 'w2', 'w3', 'w4', 'w5']);

  // Paired again: the old token stopped working, so pairing mints a new one for the same Soul in the same world. The serve
  // restarts for it and every rule is kept.
  w.token = 'synthetic-retired';
  r = await w.cli('pair', 's_me');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.serve?.restarted, true, JSON.stringify(r.json));
  r = await w.cli('wake');
  assert.deepEqual(ids(r), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'w1', 'w2', 'w3', 'w4', 'w5'], 'kept across pairing again');

  // Travel: the rules go along, except w2 (a Soul of the old world), w3 and w5 (its places); each drop is logged with why.
  r = await w.cli('travel', 'other');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.serve?.restarted, true, JSON.stringify(r.json));
  r = await w.cli('wake');
  assert.deepEqual(ids(r), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'w1', 'w4'], 'kept across travel');
  assert.deepEqual(r.json.rules.find((x) => x.id === 'w4').params, { who: 'any', where: 'here' });
  const log = await until(() => (/dropped w5/.test(w.log()) ? w.log() : null));
  assert.match(log, /wake: dropped w2: it names Soul s_mira of the world this Soul left/);
  assert.match(log, /wake: dropped w3: it names place g-hall of the world this Soul left/);
  assert.match(log, /wake: dropped w5: it names place g-yard of the world this Soul left/);
  assert.equal((await w.cli('wake', 'add', 'act-ended')).json.added, 'w6', 'new ids do not reuse the dropped ones');
});

// #1278: `status` tells a Soul the truth about itself. The real CLI against a stand-in world that can go away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function world(t) {
  const w = { inbox: {}, revoked: null, opened: 0 };
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const path = req.url.replace(/^\/w\/a/, ''), body = raw ? JSON.parse(raw) : {};
      if (path === '/v1/config') return json(res, 200, { devAuth: true, worldId: 'w_a', worldName: 'World a' });
      if (path === '/v1/souls' && req.method === 'POST') return json(res, 200, { soul: { id: 's_a1', name: body.name } });
      if (path === '/v1/souls/s_a1/pair') return json(res, 200, { code: 'code-s_a1' });
      if (path === '/v1/agent/pair') return json(res, 200, { token: 'sim_s_a1_x' });
      if (path === '/v1/me') return json(res, 200, { souls: [] });
      if (w.revoked) return json(res, 401, { code: 'control.revoked', reason: w.revoked, message: "Tess's control moved to a newer pairing." });
      if (path === '/v1/agent/me') return json(res, 200, { soul: { id: 's_a1', name: 'Tess', description: 'A new Soul.' }, inbox: w.inbox });
      if (path === '/v1/edge/self/link') return json(res, 200, { link: { state: 'connected' }, now: null });
      if (path.startsWith('/v1/edge/inbox/listen')) { w.opened++; return setTimeout(() => json(res, 200, { items: [] }), 150); }
      if (path.startsWith('/v1/edge/wait')) return setTimeout(() => json(res, 200, { events: [], cursor: 'c_1' }), 150);
      json(res, 404, { code: 'no-route', path });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  t.after(close);
  const port = server.address().port, reopen = () => new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { w, close, reopen, url: `http://127.0.0.1:${port}/w/a` };
}
function folder(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soul-status-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(cli, join(dir, 'eden.mjs'));
  const start = (...args) => spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (...args) => new Promise((resolve) => { const p = start(...args); let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; }); p.on('close', (code) => { let d = null; try { d = JSON.parse(out); } catch { /* not json */ } resolve({ code, d, out, err }); }); });
  return { dir, run, start };
}
async function paired(t) { const s = await world(t), f = folder(t); await f.run('register', s.url); await f.run('create', 'Tess'); return { ...s, ...f }; }
const until = async (ok, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('with the world down, status answers at once as JSON: who, not reachable, what to do', async (t) => {
  const f = await paired(t); await f.run('remember', '--self', 'I keep bees by the mill.');
  await f.close();
  const t0 = Date.now(), r = await f.run('status');
  assert.equal(r.code, 0, r.err); assert.ok(Date.now() - t0 < 7000, 'no retry loop');
  assert.equal(r.d.reachable, false); assert.equal(r.d.soul.name, 'Tess'); assert.equal(r.d.paired, true);
  assert.match(r.d.note, /not answering/); assert.match(r.d.brief, /I keep bees/);
});

test('after control moved, status says so as JSON, with the exact way back', async (t) => {
  const f = await paired(t); f.w.revoked = 'replaced';
  const r = await f.run('status');
  assert.equal(r.code, 0, r.err); assert.equal(r.d.paired, false); assert.equal(r.d.control, 'replaced'); assert.equal(r.d.soul.id, 's_a1');
  assert.match(r.d.why, /moved/); assert.match(r.d.next, /adopt s_a1 --for <CODE>/);
  f.w.revoked = 'retired';
  assert.doesNotMatch((await f.run('status')).d.next, /adopt/);
});

test('listening means something is open here, not that the world remembers a listen', async (t) => {
  const f = await paired(t); f.w.inbox = { connected: true, queued: 0 };
  const idle = await f.run('status');
  assert.equal(idle.d.listening, false); assert.equal(idle.d.listener, undefined);
  assert.match(idle.d.note, /Nobody is listening here/); assert.match(idle.d.note, /still shows this Soul connected/);
  const l = f.start('listen'); t.after(() => l.kill());
  assert.ok(await until(() => f.w.opened > 0));
  const open = await f.run('status');
  assert.equal(open.d.listening, true); assert.equal(open.d.listener.kind, 'listen'); assert.equal(open.d.listener.pid, l.pid);
  assert.match(open.d.note, /A listen is open here/);
});

test('status carries the brief, and a Soul with no memory pays nothing for it', async (t) => {
  const f = await paired(t);
  assert.equal('brief' in (await f.run('status')).d, false);
  await f.run('remember', '--goal', 'g1', 'Find the pond');
  assert.match((await f.run('status')).d.brief, /Find the pond/);
});

test('an owner message acked with no result shows as unfinished, to any harness', async (t) => {
  const f = await paired(t);
  f.w.inbox = { queued: 0, latest: { id: 'msg_1', text: 'Walk to the pond.', state: 'acknowledged' } };
  assert.deepEqual((await f.run('status')).d.unfinished, [{ id: 'msg_1', text: 'Walk to the pond.' }]);
  f.w.inbox = { queued: 0, latest: { id: 'msg_1', text: 'Walk to the pond.', state: 'acknowledged', result: 'At the pond', outcome: 'done' } };
  assert.equal('unfinished' in (await f.run('status')).d, false);
});

test('listen --take moves the listen here; a plain second listen says how', async (t) => {
  const f = await paired(t), first = f.start('listen'); t.after(() => first.kill());
  const gone = new Promise((r) => first.on('close', r));
  assert.ok(await until(() => f.w.opened > 0));
  const second = await f.run('listen');
  assert.equal(second.d.alreadyListening, true); assert.match(second.d.next, /listen --take/);
  const taker = f.start('listen', '--take'); t.after(() => taker.kill());
  await gone;
  assert.ok(await until(async () => (await f.run('status')).d.listener?.pid === taker.pid), 'the new listen holds it');
});

test('serve --status says when the world stops answering', async (t) => {
  const f = await paired(t);
  const s = f.start('serve', '--foreground'); t.after(() => s.kill());
  assert.ok(await until(async () => (await f.run('serve', '--status')).d.serving === true));
  assert.equal((await f.run('serve', '--status')).d.reachable, true);
  await f.close();
  assert.ok(await until(async () => (await f.run('serve', '--status')).d.reachable === false, 15000));
  assert.equal((await f.run('serve', '--status')).d.serving, true);
  await f.reopen();
  assert.equal((await f.run('serve', '--status')).d.reachable, true, 'the moment the world is back, whatever the backoff');
});

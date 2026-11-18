// #1278: `status` tells a Soul the truth about itself. The real CLI against a stand-in world that can go away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      if (w.answer) return w.answer(res);
      if (path === '/v1/edge/say' && w.hold) return setTimeout(() => json(res, 200, { ok: true }), w.hold);
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
  const start = (...args) => spawn(process.execPath, ['eden.mjs', ...args], { cwd: dir, env: { ...process.env, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (...args) => new Promise((resolve) => { const t0 = Date.now(), p = start(...args); let out = '', err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; }); p.on('close', (code) => { let d = null; try { d = JSON.parse(out); } catch { /* not json */ } resolve({ code, d, out, err, ms: Date.now() - t0 }); }); });
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
  const f = await paired(t); f.w.revoked = 'retired';
  assert.doesNotMatch((await f.run('status')).d.next, /adopt/);
  f.w.revoked = 'replaced';   // #2246: after this the home unpairs Tess and drops the dead token, so it asks the world no more
  const r = await f.run('status');
  assert.equal(r.code, 0, r.err); assert.equal(r.d.paired, false); assert.equal(r.d.control, 'replaced'); assert.equal(r.d.soul.id, 's_a1');
  assert.match(r.d.why, /moved/); assert.match(r.d.next, /adopt s_a1 --for <CODE>/);
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

test('a world that answers badly is not a world that is down, and status still answers', async (t) => {
  const f = await paired(t);
  const say = async (answer) => { f.w.answer = answer; const r = await f.run('status'); f.w.answer = null; return r; };
  const busy = await say((res) => json(res, 503, { code: 'world.busy', retry_after_s: 1 }));
  assert.equal(busy.code, 0); assert.equal(busy.d.reachable, true); assert.equal(busy.d.busy, 'world.busy'); assert.equal(busy.d.soul.name, 'Tess');
  const rate = await say((res) => json(res, 429, { code: 'client.rate' }));
  assert.equal(rate.code, 0); assert.equal(rate.d.reachable, true); assert.equal(rate.d.busy, 'client.rate');
  const broken = await say((res) => json(res, 500, { code: 'internal' }));
  assert.equal(broken.code, 0); assert.equal(broken.d.reachable, false); assert.equal(broken.d.worldSaid, 'internal');
  const cut = await say((res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '99' }); res.write('{'); setTimeout(() => res.destroy(), 30); });
  assert.equal(cut.code, 0, cut.err); assert.equal(cut.d.reachable, false);
  const stalled = await say(() => {});
  assert.equal(stalled.code, 0, stalled.err); assert.equal(stalled.d.reachable, false);
  const refused = await say((res) => json(res, 401, { code: 'unauthorized', message: 'Bad token.' }));
  assert.equal(refused.code, 0); assert.equal(refused.d.paired, false); assert.equal(refused.d.control, 'unauthorized'); assert.match(refused.d.next, /adopt s_a1/);
  await say((res) => json(res, 503, { code: 'world.busy', retry_after_s: 1 }));
  await f.run('status');
  assert.equal((await f.run('status')).d.slowed, undefined, 'an answer clears a slowed sentence');
  const gone = await say((res) => json(res, 404, { code: 'no-world' }));
  assert.equal(gone.code, 0); assert.equal(gone.d.reachable, false); assert.equal(gone.d.worldSaid, 'no-world');
});

test('a write in flight through serve does not stand in front of status', async (t) => {
  const f = await paired(t); f.w.hold = 8000;
  const s = f.start('serve', '--foreground'); t.after(() => s.kill());
  assert.ok(await until(async () => (await f.run('serve', '--status')).d.serving === true));
  const writing = f.run('say', 'A long thought.'); await new Promise((r) => setTimeout(r, 400));
  const now = await f.run('status');
  assert.equal(now.d.reachable, true); assert.ok(now.ms < 3000, `${now.ms} ms`);
  await writing;
});

test('its own listen is known however it was started, and only in its own folder', async () => {
  const { isListenOf } = await import('./soul/eden.mjs');
  for (const c of ['node eden.mjs listen', 'node eden.mjs listen --take', 'node /a/eden.mjs Tess listen', 'node eden.mjs Mary Ann listen', 'node eden.mjs @a listen --after msg_1']) assert.equal(isListenOf('/f', c, '/f'), true, c);
  assert.equal(isListenOf('/f', 'node eden.mjs listen', '/g'), false, 'another folder');
  for (const c of ['node eden.mjs status', '/bin/sh -c listener-daemon', 'node other.mjs listen']) assert.equal(isListenOf('/f', c, '/f'), false, c);
});

test('a lock naming some other process is not a listener, and --take leaves that process alone', async (t) => {
  const f = await paired(t), other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000) // listener-daemon'], { stdio: 'ignore' }); t.after(() => other.kill());
  const gone = new Promise((r) => other.on('close', () => r(true)));
  const lockDir = join(f.dir, '.souls/souls/s_a1/runtime'); writeFileSync(join(lockDir, '.listen.lock'), JSON.stringify({ pid: other.pid, start: new Date().toISOString(), beatAt: new Date().toISOString(), soul: 's_other' }) + '\n');
  assert.equal((await f.run('status')).d.listening, false);
  const taker = f.start('listen', '--take'); t.after(() => taker.kill());
  assert.ok(await until(async () => (await f.run('status')).d.listener?.pid === taker.pid));
  assert.equal(await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 300))]), false, 'still running');
});

test('an owner message acked with no result shows as unfinished, to any harness', async (t) => {
  const f = await paired(t);
  f.w.inbox = { queued: 0, latest: { id: 'msg_1', text: 'Walk to the pond.', state: 'acknowledged' } };
  assert.deepEqual((await f.run('status')).d.unfinished, [{ id: 'msg_1', text: 'Walk to the pond.' }]);
  f.w.inbox = { queued: 0, latest: { id: 'msg_1', text: 'Walk to the pond.', state: 'acknowledged', result: 'At the pond', outcome: 'done' } };
  assert.equal('unfinished' in (await f.run('status')).d, false);
  // a world that lists them shows them behind a newer message, too
  f.w.inbox = { queued: 1, latest: { id: 'msg_2', text: 'And wave.', state: 'sent' }, unfinished: [{ id: 'msg_1', text: 'Walk to the pond.' }] };
  assert.deepEqual((await f.run('status')).d.unfinished, [{ id: 'msg_1', text: 'Walk to the pond.' }]);
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

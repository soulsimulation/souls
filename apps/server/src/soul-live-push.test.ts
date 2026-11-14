// #1755: serve keeps the live picture by the world's push. The world's real live route, push and event stream over a fake
// ledger (apps/server/src/edge/catalog/live-testing.ts), the real CLI's `serve --foreground` as a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import {getRequestListener} from '@hono/node-server';
import {fakeLiveWorld} from './edge/catalog/live-testing.ts';
import {eventsFixture} from './edge/events/testing.ts';

const CLI = fileURLToPath(new URL('../../../tools/world-launcher/soul/eden.mjs', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T, ms = 5000, every = 10): Promise<T | null> { const end = Date.now() + ms; for (;;) { const v = f(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } }

async function setup(t: any, {push = true} = {}) {
  const w = fakeLiveWorld(), f = eventsFixture(['Roger'], {events: {live: push ? w.hub : null}});
  const fixture = getRequestListener(f.app.fetch), live = getRequestListener(w.app.fetch), seen: {path: string; at: number}[] = [];
  let refuse = false, cut = false;
  const server = createServer((req, res) => {
    const path = req.url!.split('?')[0]!; seen.push({path, at: Date.now()});
    if (cut && path === '/v1/edge/events') { req.socket.destroy(); return; }
    if (refuse && path === '/v1/edge/events') { res.writeHead(503, {'content-type': 'application/json', 'retry-after': '1'}); return res.end('{"error":{"code":"world.busy"}}'); }
    if (path === '/v1/edge/live') return live(req, res);
    if (path === '/v1/edge/catalog') { res.writeHead(200, {'content-type': 'application/json', etag: '"cat-1"'}); return res.end(JSON.stringify({contract: 'soul-catalog/1', worldId: 'w-1', scope: 'public', placeVerbs: [], anywhere: [], places: [], things: [], acts: [], counts: {places: 0, things: 0, acts: 0, kinds: 0}})); }
    return fixture(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const dir = mkdtempSync(join(tmpdir(), 'souls-live-push-'));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({world: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, soul: f.id('Roger'), token: f.id('Roger')}), {mode: 0o600});
  let log = '';
  const child = spawn(process.execPath, [CLI, 'serve', '--foreground'], {cwd: dir, stdio: ['ignore', 'ignore', 'pipe']});
  child.stderr.on('data', (d: Buffer) => { log += d; });
  t.after(async () => {
    try { child.kill('SIGCONT'); child.kill('SIGTERM'); } catch { /* gone */ }
    await sleep(100); w.hub.close(); server.closeAllConnections(); server.close(); f.destroy(); rmSync(dir, {recursive: true, force: true});
  });
  const copy = (): any => { try { return JSON.parse(readFileSync(join(dir, 'world-live.json'), 'utf8')); } catch { return null; } };
  const rowOf = (id: string): any => copy()?.live?.souls?.find((r: any) => r.id === id);
  // the copy's row for s_b at x (the world rounds to 0.1 m)
  const bAt = (x: number) => rowOf('s_b')?.at?.[0] === x;
  const moveB = async (x: number) => { w.entities.h_b!.pose.p = [x, 0, 50]; w.advance(); };
  return {w, f, dir, child, copy, rowOf, bAt, moveB, seen, log: () => log, refuse: (on: boolean) => { refuse = on; if (on) server.closeAllConnections(); }, cut: (on: boolean) => { cut = on; if (on) server.closeAllConnections(); }};
}

test('serve keeps the copy by the push: each change within 1 s, no poll while it comes, a divergence repaired, a suspend caught up once', {timeout: 120_000}, async (t) => {
  const s = await setup(t);
  assert.ok(await until(() => s.copy()?.pushed && s.copy()?.live?.epoch, 10_000), `the push reaches the copy: ${s.log()}`);

  // A1: a change is in the copy within 1 s of the world making it
  const took: number[] = [];
  for (let i = 0; i < 12; i++) {
    const x = 60 + i, t0 = Date.now(); await s.moveB(x);
    assert.ok(await until(() => s.bAt(x), 3000, 5), `change ${i} arrives`);
    took.push(Date.now() - t0); await sleep(150);
  }
  took.sort((a, b) => a - b);
  t.diagnostic(`change to copy, ms: ${took.join(',')}`);
  assert.ok(took.at(-1)! < 1000, `every change within 1 s: ${took.join(',')} ms`);
  s.w.say('s_a', 'sp_1', 'hello yard');
  assert.ok(await until(() => s.copy()?.speech?.some((l: any) => l.id === 'sp_1'), 2000), 'a line spoken reaches the copy');

  // A6: while the push comes, the 2 s poll asks nothing
  await sleep(500); const from = Date.now(); await sleep(5_000);
  assert.equal(s.seen.filter((r: any) => r.path === '/v1/edge/live' && r.at >= from).length, 0, 'no live poll while the push is healthy');

  // A3: a copy edited on disk disagrees with the world's hash and is repaired within 10 s
  const bad = s.copy(); bad.live.souls = bad.live.souls.map((r: any) => r.id === 's_a' ? {...r, at: [999, 999]} : r); writeFileSync(join(s.dir, 'world-live.json'), JSON.stringify(bad));
  const forced = Date.now();
  assert.ok(await until(() => s.rowOf('s_a')?.at?.[0] !== 999, 10_000, 50), 'the divergence is found and repaired');
  const repairMs = Date.now() - forced;
  t.diagnostic(`divergence repaired in ${repairMs} ms`);
  assert.ok(repairMs < 10_000, `repaired in ${repairMs} ms`);
  assert.equal(s.copy().push.lastWhole, 'hash');

  // A2: a suspended serve, the world moving on meanwhile; on waking the copy is current within 2 s, each line once
  s.child.kill('SIGSTOP');
  for (let i = 0; i < 6; i++) { await s.moveB(80 + i); await sleep(400); }
  s.w.say('s_b', 'sp_2', 'while you slept'); await sleep(400);
  s.child.kill('SIGCONT'); const woke = Date.now();
  assert.ok(await until(() => s.bAt(85) && s.copy()?.speech?.some((l: any) => l.id === 'sp_2'), 2000), `current within 2 s of waking: ${JSON.stringify(s.rowOf('s_b'))}`);
  t.diagnostic(`current ${Date.now() - woke} ms after waking`);
  assert.ok(Date.now() - woke < 2000);
  const ids = s.copy().speech.map((l: any) => l.id);
  assert.deepEqual(ids, [...new Set(ids)], 'no line twice');
});

test('a dropped stream resumes from the copy\'s seq: only what was missed, current within 2 s of reconnecting', {timeout: 60_000}, async (t) => {
  const s = await setup(t);
  assert.ok(await until(() => s.copy()?.pushed && s.copy()?.live?.epoch, 10_000), s.log());
  const before = s.copy().push.wholes;
  s.refuse(true);
  for (let i = 0; i < 4; i++) { await s.moveB(90 + i); await sleep(300); }
  const n = s.seen.length; s.refuse(false);
  const back = await until(() => s.seen.slice(n).find((r: any) => r.path === '/v1/edge/events'), 30_000, 20);
  assert.ok(back, 'the stream is asked for again');
  assert.ok(await until(() => s.bAt(93), 2000), 'current within 2 s of reconnecting');
  assert.equal(s.copy().push.wholes, before, 'resumed from the ring, not the whole picture');
});

test('a world without the push: serve polls the live picture as before, with no error', {timeout: 60_000}, async (t) => {
  const s = await setup(t, {push: false});
  assert.ok(await until(() => s.copy()?.live, 10_000), s.log());
  await s.moveB(77);
  assert.ok(await until(() => s.bAt(77), 5000, 50), 'the poll brings the change');
  assert.equal(s.copy().pushed, undefined);
  assert.doesNotMatch(s.log(), /live|push/i, 'nothing said about a push the world does not have');
});

test('a stream cut off with no answer at all is asked for again as soon as the poll reaches the world, not after its whole backoff', {timeout: 90_000}, async (t) => {
  const s = await setup(t);
  assert.ok(await until(() => s.copy()?.pushed && s.copy()?.live?.epoch, 10_000), s.log());
  s.cut(true);
  await sleep(12_000);   // several failed tries: the stream's backoff has grown past the poll's 2 s
  for (let i = 0; i < 3; i++) { await s.moveB(95 + i); await sleep(200); }
  const n = s.seen.length, restored = Date.now(); s.cut(false);
  const back = await until(() => s.seen.slice(n).find((r: any) => r.path === '/v1/edge/events'), 20_000, 20);
  assert.ok(back, 'the stream is asked for again');
  t.diagnostic(`stream asked for again ${back!.at - restored} ms after the world answered again`);
  assert.ok(back!.at - restored < 5_000, 'within the poll\'s reach, not the backoff');
  assert.ok(await until(() => s.bAt(97) && s.copy()?.pushed, 3000), 'and the copy is kept by the push again');
});

// #3703 served: the town calendar on a real served world. N2's test world with an Eden notice board on the square
// (`eden:notice_board`, as the import names Eden's six) and Eden's entries for it, the calendar item, the doors and the
// body's family. `worldd seed`, `worldd serve`, `gatewayd --entries`, `directoryd`; two Souls paired by `pair.mjs`,
// approved once and joined with `life:join`, as the served e2e gate does it. Everything goes through the thin command.
//
//   A: `calendar add` takes a blank notice from the board, writes it and puts it up; its `wait` says posted.
// With CALENDAR_FACTS set to Eden's facts file, the same journey runs on full Eden and its own notice boards.
//
//   B: `whatson` reads A's event, with A as its poster; `calendar interest` says B will come, and both Souls'
//      `whatson` count one coming (B's says it is B); `calendar not-coming` takes it back.
//
// Run from v2/ after `cargo build -p directoryd -p gatewayd -p worldd -p testworld --locked` and replica's wasm-bindgen
// package in target/wasm-load/pkg. Fake minds; isolated folders under the OS temp dir.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { request } from '../src/daemon/client.mjs';
import { runtimeOf } from '../src/home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../..');
const content = resolve(v2, '../content/kinds');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const CLI = join(v2, 'client/src/cli/souls.mjs');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
for (const f of [join(PKG, 'replica.js'), bin('worldd'), bin('gatewayd'), bin('directoryd'), bin('testworld')]) {
  assert.ok(existsSync(f), `${f}: build it first (see the head of this file)`);
}

const dir = mkdtempSync(join(tmpdir(), 'souls-calendar-'));
const procs = [], daemons = [];
function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake', ...opts.env } });
  procs.push(p);
  let out = '';
  const done = new Promise((ok, fail) => {
    const take = (d) => { out += d; const m = ready?.exec(out); if (m) ok({ p, m, out: () => out }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => (ready ? fail(new Error(`${path} ended (${c}) before it was ready: ${out.slice(-2000)}`)) : ok({ p, out, code: c })));
  });
  done.text = () => out;
  return done;
}
async function waitFor(what, f, ms = 30_000) {
  for (const until = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await pause(100);
  }
}
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
after(async () => {
  for (const d of daemons) await request(d.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill('SIGKILL');
  if (process.env.SERVED_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
});
function souls(home, ...args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => ok(JSON.parse(out.trim().split('\n').at(-1))));
  });
}

/** N2's test world with an Eden notice board on the square. */
async function world() {
  const done = await run(bin('testworld'), ['--seed', '1', '--things', '0', '--out', dir]);
  assert.equal(done.code, 0, done.out);
  const facts = JSON.parse(readFileSync(join(dir, 'testworld-s1-t0.facts.json'), 'utf8'));
  facts.kinds.find((k) => k.ref === 'testworld-door@1').name = 'eden:door';
  facts.kinds.push({ ref: 'cal-board@1', hash: Buffer.from('souls/cal/board').toString('hex').padEnd(64, '0').slice(0, 64), name: 'eden:notice_board', form: 'point' });
  facts.things.push({ id: 'board-1', def: 'cal-board@1', ref: 'cal-board@1', parent: null, pose: [3000, 0, 4000, 0], scale_ppm: 1_000_000, name: 'the square notice board', slots: [] });
  const path = join(dir, 'calendar.facts.json');
  writeFileSync(path, JSON.stringify(facts));
  const entries = join(dir, 'entries');
  mkdirSync(entries);
  for (const f of ['doors/door.json', 'body/humanoid.json', 'calendar/notice_board.json', 'calendar/entry.json']) copyFileSync(join(content, f), join(entries, f.replace('/', '-')));
  return { facts: path, entries };
}

test('#3703: a Soul announces from the notice board; another reads it in whatson, comes, and takes it back', { timeout: 400_000 }, async () => {
  const t0 = Date.now(), stage = (s) => console.log(`calendar: ${s} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // CALENDAR_FACTS=<Eden's facts> serves full Eden with every entry in content/kinds instead (the A5 walk).
  const w = process.env.CALENDAR_FACTS ? { facts: process.env.CALENDAR_FACTS, entries: content } : await world(), folder = join(dir, 'world');
  const seeded = await run(bin('worldd'), ['seed', '--facts', w.facts, '--dir', folder, '--souls', '0', '--at', '0,0', '--entries', w.entries]);
  assert.equal(seeded.code, 0, seeded.out);
  const served = run(bin('worldd'), ['serve', '--dir', folder], /listening /);
  await served;
  const gwPort = await freePort(), gateway = `ws://127.0.0.1:${gwPort}/v2/ws`;
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(folder, 'gateway.sock'), '--tokens', join(folder, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`, '--entries', join(folder, 'entries')], /listening (\S+)\n/);
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', join(folder, 'tokens')], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;
  stage('world served');

  async function pairOne(label) {
    const at = join(dir, label);
    mkdirSync(at);
    const home = join(at, '.souls');
    const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
      '--gateway', gateway, '--device', 'calendar machine', '--label', label], null, { cwd: at, env: { SOULS_HOME: home } });
    const asked = await waitFor(`${label}'s pairing code`, () => asking.text().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve'));
    const approve = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: asked.code, confirm: true, test_person: label }) });
    assert.equal(approve.status, 200, `${label}: the owner's approval`);
    const done = await asking;
    assert.equal(done.code, 0, done.out);
    const said = JSON.parse(done.out.trim().split('\n').at(-1));
    const rt = runtimeOf(home, said.soul);
    daemons.push(rt);
    return { label, home, soul: said.soul, rt, cli: (...a) => souls(home, ...a, '--soul', said.soul) };
  }
  const answered = (s, sequence) => waitFor(`${s.label}'s answer to ${sequence}`, async () => {
    s.seen ??= [];
    s.seen.push(...(await request(s.rt.socket, { op: 'read' })).events);
    return s.seen.find((e) => e.kind === 'answer' && e.sequence === sequence);
  });
  const A = await pairOne('alder'), B = await pairOne('birch');
  for (const s of [A, B]) {
    const r = await s.cli('act', 'life:join');
    assert.equal(r.ok, true, JSON.stringify(r));
    const a = await answered(s, r.sequence);
    assert.ok(a.answer === 1 || a.answer === 3, `${s.label}'s join: ${JSON.stringify(a)}`);
    s.body = (await waitFor(`${s.label}'s body`, async () => (await s.cli('find', 'body', '--limit', '50')).found?.find((x) => x.kind?.startsWith('souls:body') && x.id !== A.body))).id;
  }
  stage(`joined: ${A.body}, ${B.body}`);

  // A announces. The board is in A's copy; the add answers at once and its outcome arrives in wait.
  const board = await waitFor('the board in A\'s copy', async () => (await A.cli('find', 'notice', 'board', '--limit', '20')).found?.find((r) => r.kind?.startsWith('eden:notice_board')));
  console.log('board:', JSON.stringify(board));
  const add = await A.cli('calendar', 'add', 'Bread at the oven', '--place', board.id, '--in', '30', '--for', '60', 'bring a loaf');
  console.log('calendar add:', JSON.stringify(add));
  assert.equal(add.ok, true, JSON.stringify(add));
  const posted = await waitFor('A\'s calendar event', async () => {
    const r = await A.cli('wait', '20');
    console.log('A wait:', JSON.stringify(r.events?.filter((e) => e.kind !== 'synced')));
    return r.events?.find((e) => e.kind === 'calendar');
  }, 300_000);
  if (posted.what !== 'posted') {
    console.log('A receipt:', JSON.stringify(await A.cli('receipt', String(add.sequence))));
    console.log('A calendar:', JSON.stringify(await A.cli('calendar')));
    console.log('A find notice:', JSON.stringify(await A.cli('find', 'notice', '--limit', '20')));
    console.log('A inspect board:', JSON.stringify(await A.cli('inspect', board.id)));
    console.log('A look:', JSON.stringify(await A.cli('look')));
    console.log('A events:', JSON.stringify(await A.cli('events')).slice(0, 3000));
    console.log('B calendar:', JSON.stringify(await B.cli('calendar')));
    console.log('worldd:', served.text().slice(-3000));
  }
  assert.equal(posted.what, 'posted', `A's notice: ${JSON.stringify(posted)}`);
  stage(`posted ${posted.item}`);

  // B reads it.
  const seen = await waitFor('the event in B\'s whatson', async () => (await B.cli('whatson')).on?.find((r) => r.id === posted.item), 30_000);
  console.log('B whatson row:', JSON.stringify(seen));
  assert.equal(seen.title, 'Bread at the oven — bring a loaf');
  assert.equal(seen.phase, 'soon');
  assert.ok(seen.startsInMinutes >= 25 && seen.startsInMinutes <= 30, JSON.stringify(seen));
  assert.equal(seen.forMinutes, 60);
  assert.equal(seen.coming, 0);
  assert.equal(seen.untrusted, true);
  assert.ok((await B.cli('calendar')).items.some((r) => r.id === posted.item), 'B\'s calendar lists it');

  // B says it will come; both count it.
  const yes = await B.cli('calendar', 'interest', posted.item);
  assert.equal(yes.ok, true, JSON.stringify(yes));
  const coming = await waitFor('B coming, in B\'s whatson', async () => (await B.cli('whatson')).on?.find((r) => r.id === posted.item && r.coming === 1));
  assert.equal(coming.youAreComing, true);
  const forA = await waitFor('B coming, in A\'s whatson', async () => (await A.cli('whatson')).on?.find((r) => r.id === posted.item && r.coming === 1));
  assert.equal(forA.youAreComing, undefined);
  stage('B is coming');

  // B takes it back.
  const no = await B.cli('calendar', 'not-coming', posted.item);
  assert.equal(no.ok, true, JSON.stringify(no));
  const gone = await waitFor('B not coming', async () => (await B.cli('whatson')).on?.find((r) => r.id === posted.item && r.coming === 0));
  assert.equal(gone.youAreComing, undefined);
  const notItem = await B.cli('calendar', 'interest', board.id);
  assert.equal(notItem.code, 'calendar.not-an-item');
  stage('B not coming');
});

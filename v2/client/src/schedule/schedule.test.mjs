// The Soul's own schedule (Engine v2 R15, #2757): the file and its rules alone, then through the Soul's daemon against
// the real gateway (`gatewayd`) and the world's end of it (`worldd gateway-link`). Run from v2/ after `cargo build -p
// gatewayd -p worldd --locked`, with replica's wasm-bindgen package in target/wasm-load/pkg. R15_REPORT=1 prints the
// delays, for the PR. World-time entries (R15b, #3517) wait for the copy's world clock and are not run here.

import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { addEntry, due, onEvent, readSchedule, removeEntry } from './schedule.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_r15test';
const WORLD_SCOPE = '2c'.repeat(16);
const LAMP = `${WORLD_SCOPE}-3`; // the Soul's own lamp (daemon.test.mjs says why)
const GRANT = `soul-${WORLD_SCOPE}-2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r15-'));
const home = join(dir, '.souls');
const file = join(home, 'souls', SOUL, 'memory', 'schedule.md');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const procs = [];
const report = {};
let rt;

// Bounds are generous: CI runs this beside cargo builds, and a daemon's start can take seconds there. Each wait polls
// for its condition and returns as soon as it holds; none is a fixed sleep standing in for one.
async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
}

const ask = (req, ms = 5000) => request(rt.socket, req, ms);
const start = () => call(home, SOUL, { op: 'status' }, { pkg: PKG, within: 30_000, ms: 30_000 });
const connected = () => waitFor(async () => (await ask({ op: 'status' }, 30_000)).connected);
const marks = () => JSON.parse(readFileSync(rt.state, 'utf8')).schedule?.marks ?? {};
const arrivals = () => readFileSync(join(dir, 'world', 'arrivals.txt'), 'utf8').trim().split('\n').filter(Boolean).length;
const souls = (...args) => promisify(execFile)(process.execPath, [join(here, '../cli/souls.mjs'), ...args],
  { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } }).then((r) => JSON.parse(r.stdout));

/** Ends the daemon as a crash would: SIGKILL, no clean-up. */
async function kill() {
  const { pid } = JSON.parse(readFileSync(rt.lock, 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
}

/** When the world answered the intent of entry `id` (ms, performance clock): read from `wait`'s answer events. */
async function answeredAt(id) {
  const m = await waitFor(() => Object.entries(marks()).find(([k, v]) => k.startsWith(`${id}@`) && v.sequence)?.[1]);
  for (const until = Date.now() + 8000; Date.now() < until;) {
    const got = await ask({ op: 'wait', seconds: 2 }, 7000);
    if (got.events.some((e) => e.kind === 'answer' && e.sequence === m.sequence)) return { t: performance.now(), mark: m };
  }
  throw new Error(`${id}: no answer`);
}

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `${GRANT} ${createHash('sha256').update(token).digest('hex')}\n`);
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  procs.push(spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4'], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const gw = spawn(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts')], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(gw);
  const gateway = await new Promise((ok) => { let out = ''; gw.stdout.on('data', (d) => { out += d; const m = /listening (\S+)\n/.exec(out); if (m) ok(m[1]); }); });
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await start();
  await connected();
  await ask({ op: 'wait', seconds: 0 }); // what happened at sign-in, taken
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  if (process.env.R15_REPORT) console.log(JSON.stringify(report));
  rmSync(dir, { recursive: true, force: true });
});

test('the file: entries added, listed and removed; a line that does not parse is named and inert', () => {
  const f = join(dir, 'unit', 'schedule.md'), now = Date.parse('2026-11-19T10:00:00Z');
  const a = addEntry(f, { when: 'in 10m', does: `act walk:${LAMP}` }, now);
  assert.equal(a.real, now + 600_000);
  assert.equal(addEntry(f, { when: '{"event":"souls:light-changed"}', does: 'wake the lights changed' }, now).id, 's2');
  assert.equal(addEntry(f, { when: 'at 20', does: 'act walk:x' }, now).world, '20:00');
  assert.throws(() => addEntry(f, { when: '2026-11-19T09:00:00Z', does: 'act x' }, now), { code: 'when-passed' });
  assert.throws(() => addEntry(f, { when: 'in 1m', does: 'dance' }, now), { code: 'do-not-an-act' });
  appendFileSync(f, '- s9 · next tuesday · act x\nA note of the owner.\n');
  const read = readSchedule(f);
  assert.deepEqual(read.entries.map((e) => e.id), ['s1', 's2', 's3']);
  assert.deepEqual(read.bad.map((b) => b.code), ['when-not-a-time']);
  removeEntry(f, 's2');
  assert.deepEqual(readSchedule(f).entries.map((e) => e.id), ['s1', 's3']);
  assert.match(readFileSync(f, 'utf8'), /A note of the owner/);
});

test('the rules: on time fires; passed tells, drops or fires late within its bound; a change fires on its event only', () => {
  const f = join(dir, 'rules.md'), t = Date.parse('2026-11-19T10:00:00Z');
  writeFileSync(f, ['- s1 · 2026-11-19T10:00:00Z · act a', '- s2 · 2026-11-19T08:00:00Z · act b',
    '- s3 · 2026-11-19T08:00:00Z · act c · missed drop', '- s4 · 2026-11-19T08:00:00Z · act d · missed late 3h',
    '- s5 · {"event":"souls:arrived","from":["s_maya"]} · act e', '- s6 · world 20:00 · act f'].join('\n'));
  const { entries } = readSchedule(f);
  const d = due(entries, {}, t + 1000);
  assert.deepEqual(d.fire.map((x) => x.e.id), ['s1', 's4']);
  assert.deepEqual(d.missed.map((x) => [x.e.id, x.told]), [['s2', true], ['s3', false]]);
  assert.deepEqual(due(entries, { [entries[0].key]: { at: t } }, t + 1000).fire.map((x) => x.e.id), ['s4'], 'marked: once');
  assert.deepEqual(onEvent(entries, {}, { name: 'souls:arrived', actor: 's_bo' }, 's_me', t), []);
  assert.deepEqual(onEvent(entries, {}, { name: 'souls:arrived', actor: 's_maya' }, 's_me', t).map((e) => e.id), ['s5']);
});

test('A1: three entries with an intent written in advance are each sent within 5 s of their moment, with no model turn', async () => {
  const cafe = `${WORLD_SCOPE}-9`, seats = [`${WORLD_SCOPE}-5`, `${WORLD_SCOPE}-6`];
  // "In a few seconds, switch the lamp on": a real time.
  const lamp = await souls('schedule', 'add', 'in 3s', `r2:switch_on:${LAMP}`);
  assert.equal(lamp.ok, true, JSON.stringify(lamp));
  // "Sit with Maya when she reaches the cafe": a change of Maya's place, and a sit with ranked fallbacks.
  const maya = await souls('schedule', 'add', JSON.stringify({ event: 'souls:arrived', from: ['s_maya'], fields: { 2: cafe } }), `sit:${seats[0]}`, `sit:${seats[1]}`);
  // "Lights on at dusk": E6's light change, and the lamp switched on.
  const dusk = await souls('schedule', 'add', JSON.stringify({ event: 'souls:light-changed', fields: { 70: 'dusk' } }), `r2:switch_off:${LAMP}`);
  const listed = await souls('schedule', 'list');
  assert.deepEqual(listed.entries.map((e) => e.status), ['waiting', 'waiting', 'waiting']);
  const ms = {};

  const moment = performance.now() + (Date.parse(lamp.added.at) - Date.now());
  ms[lamp.added.id] = Math.round((await answeredAt(lamp.added.id)).t - moment);

  await ask({ op: 'event', event: { name: 'souls:arrived', actor: 's_maya', fields: { 2: `${WORLD_SCOPE}-8` } } });
  await sleep(1500);
  assert.equal(Object.keys(marks()).filter((k) => k.startsWith(`${maya.added.id}@`)).length, 0, 'another place: nothing sent');
  let t0 = performance.now();
  assert.deepEqual((await ask({ op: 'event', event: { name: 'souls:arrived', actor: 's_maya', fields: { 2: cafe } } })).scheduled, [maya.added.id]);
  ms[maya.added.id] = Math.round((await answeredAt(maya.added.id)).t - t0);

  t0 = performance.now();
  assert.deepEqual((await ask({ op: 'event', event: { name: 'souls:light-changed', fields: { 70: 'dusk' } } })).scheduled, [dusk.added.id]);
  ms[dusk.added.id] = Math.round((await answeredAt(dusk.added.id)).t - t0);

  report.a1 = ms;
  for (const [id, t] of Object.entries(ms)) assert.ok(t < 5000, `${id}: ${t} ms`);
  // No model turn: nothing was queued for a reader, and each was sent once.
  assert.deepEqual((await ask({ op: 'wake' })).queued, []);
  assert.deepEqual((await souls('schedule', 'list')).entries.map((e) => e.status), ['sent', 'sent', 'sent']);
  assert.equal((await ask({ op: 'event', event: { name: 'souls:light-changed', fields: { 70: 'dusk' } } })).scheduled, undefined, 'one-off');
});

test('A2: a killed daemon, restarted, fires each occurrence once', async () => {
  const before = arrivals(), seq0 = (await ask({ op: 'status' })).sequence;
  const one = addEntry(file, { when: 'in 2s', does: `act r2:switch_on:${LAMP}` }, Date.now());
  await waitFor(() => marks()[one.key]?.sequence);
  // Killed once the world has its intent: a mark is written before the send, so a kill at the mark could take the
  // intent with it (at most once is the contract), and the world would never count it.
  await waitFor(() => arrivals() - before === 1);
  await kill(); // just after it was sent
  // While it is down: an entry due 4 s from now (late up to a minute, so a slow restart still sends it rather than
  // telling it missed), and one the crashed daemon had marked but not sent.
  const two = addEntry(file, { when: 'in 4s', does: `act r2:switch_off:${LAMP}`, missed: 'late 1m' }, Date.now());
  const three = addEntry(file, { when: 'in 3s', does: `act r2:switch_on:${LAMP}` }, Date.now());
  const st = JSON.parse(readFileSync(rt.state, 'utf8'));
  st.schedule.marks[three.key] = { at: Date.now(), sequence: st.sequence + 1 };
  writeFileSync(rt.state, JSON.stringify(st));
  await start();
  await connected();
  await waitFor(() => marks()[two.key]?.sequence);
  await waitFor(() => arrivals() - before === 2);
  await kill(); // and once more, then up again: nothing fires twice
  await start();
  await connected();
  await sleep(3000); // a quiet spell: anything that would fire twice has had its beats
  const seq = (await ask({ op: 'status' })).sequence;
  report.a2 = { sent: seq - seq0, arrived: arrivals() - before };
  assert.equal(seq - seq0, 2, 'two intents: the first and the one due while down; the marked one never');
  assert.equal(arrivals() - before, 2);
});

test('A3: after two hours off, the next answer lists what was missed', async () => {
  await ask({ op: 'stop' });
  await sleep(300);
  const now = Date.now(), iso = (ms) => new Date(now - ms).toISOString();
  appendFileSync(file, [`- s90 · ${iso(3_600_000)} · act walk:${LAMP}`, `- s91 · ${iso(5_400_000)} · act walk:${LAMP} · missed drop`,
    `- s92 · ${iso(1_800_000)} · act r2:switch_on:${LAMP} · missed late 3h`].join('\n') + '\n');
  const st = JSON.parse(readFileSync(rt.state, 'utf8'));
  st.schedule.beat = now - 7_200_000; // its last beat, two hours ago: the lid closed
  writeFileSync(rt.state, JSON.stringify(st));
  const first = await start();
  report.a3 = first.missed;
  assert.deepEqual(first.missed.entries.map((e) => e.id), ['s90'], 'told: s90; s91 dropped; s92 sent late, as asked');
  assert.equal(first.missed.entries[0].off.length, 2);
  assert.ok(first.missed.entries[0].lateMs >= 3_600_000);
  assert.equal((await ask({ op: 'status' })).missed, undefined, 'listed once');
  const list = await souls('schedule', 'list');
  assert.deepEqual(['s90', 's91', 's92'].map((id) => list.entries.find((e) => e.id === id).status), ['missed', 'missed', 'sent']);
});

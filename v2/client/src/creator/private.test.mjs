// A private thing is its owner's alone (0.131 parity, #3700), walked with real input: the lamps world served by a
// world with a creator (`worldd gateway-link --creator`) through the real gateway, its first body's Soul acting
// through its daemon and the creator through `souls-god.mjs` and its own. The creator makes the Soul's lamp the god's
// and private, and the Soul's press is refused `object.private` by the world; marks pass down from the room it is in;
// made public again, the same press ends with its receipt. Run from v2/ after `cargo build -p gatewayd -p worldd
// --locked`, with replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOULS = join(here, '../cli/souls.mjs');
const GOD = join(here, 'souls-god.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-3700-'));
const procs = [];
const daemons = [];
const creatorScope = randomBytes(16).toString('hex');

function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok({ p, m, out: () => out }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 30_000) {
  for (const until = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

const cli = (path, home, args) => {
  const r = spawnSync(process.execPath, [path, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
  console.log(`$ ${path === GOD ? 'souls-god' : 'souls'} ${args.join(' ')}\n${r.stdout.trim().split('\n').at(-1)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
};

function homeFor(name, id, token, gateway) {
  const home = join(dir, name, '.souls');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [id]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  return home;
}

const got = [];
const answerOf = (rt, sequence) => waitFor(async () => {
  got.push(...(await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer'));
  return got.find((e) => e.sequence === sequence);
}, 60_000);

// `worldd gateway-link`'s world mints from scope 2b: the place, its room, the first body (the Soul) and its lamp.
const SCOPE = '2b'.repeat(16), BODY = `${SCOPE}-2`, LAMP = `${SCOPE}-3`;
let soulHome, godHome, soulRt;
before(async () => {
  const world = join(dir, 'w.sock');
  procs.push(spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '1', '--creator', `${creatorScope}-1`, '--no-measures'], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const soulGrant = `soul-${BODY}`, soulToken = `${soulGrant}.${randomBytes(32).toString('hex')}`;
  const godGrant = `creator-${creatorScope}-1`, godToken = `${godGrant}.${randomBytes(32).toString('hex')}`;
  const tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, [[soulGrant, soulToken], [godGrant, godToken]].map(([g, t]) => `${g} ${createHash('sha256').update(t).digest('hex')}\n`).join(''));
  const { m } = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const gateway = `ws://${m[1]}/v2/ws`;
  soulHome = homeFor('soul', `s_${BODY}`, soulToken, gateway);
  godHome = homeFor('god', `c_${creatorScope}-1`, godToken, gateway);
  soulRt = runtimeOf(soulHome, `s_${BODY}`);
  const godRt = runtimeOf(godHome, `c_${creatorScope}-1`);
  daemons.push(soulRt, godRt);
  cli(SOULS, soulHome, ['status']);
  cli(GOD, godHome, ['status']);
  await waitFor(async () => { const s = await request(soulRt.socket, { op: 'status' }); return s.connected && !s.syncing; });
  await waitFor(async () => (await request(godRt.socket, { op: 'status' })).connected);
});

after(async () => {
  for (const rt of daemons) await request(rt.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** The Soul presses its lamp's switch, either way: the answer of the one that holds (on, else off). */
async function press() {
  const on = await request(soulRt.socket, { op: 'act', verb: 'r2:switch_on', target: LAMP });
  const a = await answerOf(soulRt, on.sequence);
  console.log(`soul: act r2:switch_on ${LAMP} -> ${JSON.stringify({ answer: a.answer, reason: a.reason })}`);
  if (a.answer === 1 || a.reason === 'object.private') return a;
  const off = await request(soulRt.socket, { op: 'act', verb: 'r2:switch_off', target: LAMP });
  const b = await answerOf(soulRt, off.sequence);
  console.log(`soul: act r2:switch_off ${LAMP} -> ${JSON.stringify({ answer: b.answer, reason: b.reason })}`);
  return b;
}

test('#3700: a Soul is refused its lamp by name once the creator makes it the god\'s and private, and uses it once public', async () => {
  assert.ok(cli(GOD, godHome, ['describe']).nodes.some((n) => n.id === LAMP), 'the lamp is in the creator\'s copy');
  assert.equal((await press()).answer, 1, 'unmarked: the Soul may');
  const owned = cli(GOD, godHome, ['own', LAMP, 'god', '--private']);
  assert.equal(owned.ok, true, JSON.stringify(owned));
  const no = await press();
  assert.deepEqual([no.answer > 1, no.reason], [true, 'object.private'], JSON.stringify(no));
  // The room made the Soul's own and private: the lamp in it, public again, follows its own mark; the room's owner may.
  assert.equal(cli(GOD, godHome, ['access', LAMP, 'none']).ok, true);
  assert.equal(cli(GOD, godHome, ['own', LAMP, 'none']).ok, true);
  assert.equal(cli(GOD, godHome, ['own', `${SCOPE}-1`, BODY, '--private']).ok, true);
  assert.equal((await press()).answer, 1, 'the Soul owns the room it is in');
  assert.equal(cli(GOD, godHome, ['own', `${SCOPE}-1`, 'god']).ok, true);
  assert.equal((await press()).reason, 'object.private', 'the god\'s private room: its lamp is private too');
  assert.equal(cli(GOD, godHome, ['access', `${SCOPE}-1`, 'public']).ok, true);
  assert.equal((await press()).answer, 1, 'public again');
});

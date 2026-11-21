// A private thing is its owner's alone (0.131 parity, #3700), walked with real input: N2's test world served by a
// world with a creator (`worldd gateway-link --testworld --creator`) through the real gateway, its one Soul driven by
// the thin command (`souls.mjs`) and the creator by `souls-god.mjs`, each through its own daemon. The creator makes a
// chair the god's and private; the Soul's sit on it is refused `object.private` by the world; made public again, the
// same sit ends with its receipt. Run from v2/ after `cargo build -p gatewayd -p worldd --locked`, with replica's
// wasm-bindgen package in target/wasm-load/pkg.

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

let named, soulHome, godHome, soulRt;
before(async () => {
  const world = join(dir, 'w.sock');
  const w = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '1', '--testworld', '--creator', `${creatorScope}-1`, '--no-measures'], { stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(w);
  let out = '';
  w.stdout.on('data', (d) => { out += d; });
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  await waitFor(() => out.includes('testworld'));
  await sleep(100);
  named = Object.fromEntries(out.trim().split('\n').map((l) => l.split(' ')).filter((p) => p[0] === 'testworld').map(([, id, ...n]) => [n.join(' '), id]));
  const soulGrant = `soul-${named.soul}`, soulToken = `${soulGrant}.${randomBytes(32).toString('hex')}`;
  const godGrant = `creator-${creatorScope}-1`, godToken = `${godGrant}.${randomBytes(32).toString('hex')}`;
  const tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, [[soulGrant, soulToken], [godGrant, godToken]].map(([g, t]) => `${g} ${createHash('sha256').update(t).digest('hex')}\n`).join(''));
  const { m } = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const gateway = `ws://${m[1]}/v2/ws`;
  soulHome = homeFor('soul', `s_${named.soul}`, soulToken, gateway);
  godHome = homeFor('god', `c_${creatorScope}-1`, godToken, gateway);
  soulRt = runtimeOf(soulHome, `s_${named.soul}`);
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

test('#3700: a Soul is refused a private chair by name, and sits once it is public again', async () => {
  // The chairs of N2's test world are the Soul's to sit on, not nodes of the creator's tree; the lamp beside the
  // Soul's body is. Both are tried: the chair when the creator's copy holds it, the lamp's switch always.
  const nodes = cli(GOD, godHome, ['describe']).nodes;
  const chair = named['the west chair'];
  const lamp = nodes.find((n) => n.kind.startsWith('r2:lamp'))?.id;
  assert.ok(lamp, JSON.stringify(nodes));
  const target = nodes.some((n) => n.id === chair) ? { id: chair, acts: [`sit:${chair}`] } : { id: lamp, acts: [`switch_on:${lamp}`, `switch_off:${lamp}`] };
  console.log(`target: ${target.id === chair ? 'the west chair' : 'the lamp'}`);
  if (target.id === chair) assert.equal((await answerOf(soulRt, cli(SOULS, soulHome, ['act', chair]).sequence)).answer, 1, 'the Soul walks to the chair');

  const owned = cli(GOD, godHome, ['own', target.id, 'god', '--private']);
  assert.equal(owned.ok, true, JSON.stringify(owned));
  const refused = cli(SOULS, soulHome, ['act', ...target.acts]);
  assert.equal(refused.ok, true, JSON.stringify(refused));
  const no = await answerOf(soulRt, refused.sequence);
  assert.ok(no.answer > 1, `refused: ${JSON.stringify(no)}`);
  assert.equal(no.reason, 'object.private', JSON.stringify(no));

  assert.equal(cli(GOD, godHome, ['access', target.id, 'public']).ok, true);
  const yes = await answerOf(soulRt, cli(SOULS, soulHome, ['act', ...target.acts]).sequence);
  assert.equal(yes.answer, 1, `used once public: ${JSON.stringify(yes)}`);
});

#!/usr/bin/env node
// Two Souls play chess at full Eden's chess table on a served world (#3713), run by hand: the world from the Eden facts
// file and the kit's entries with the chess table's rules module (content/kinds/games/chess_table.wasm), `worldd
// serve`, `gatewayd`, `directoryd`; two Souls paired through the real pairing path and joined; then, through the thin
// command (`souls.mjs object <id> <offer> name=value`), white and black sit at the table, begin, and play. An illegal
// move is refused by name. The table's fields are read from each Soul's copy and from the public stream as the page's
// worker plays it.
//
//   node v2/tools/board-games/served-chess.mjs --facts <eden facts.json>
//
// From the repository root, after `cargo build --release -p worldd -p gatewayd -p directoryd`, replica's
// wasm-bindgen package in v2/target/wasm-load/pkg and `npm ci --prefix v2/web` (binaries by WORLDD, GATEWAYD,
// DIRECTORYD, or v2/target/release). Fake minds; an isolated folder under the OS temp dir, removed at the end.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from '../../client/src/daemon/client.mjs';
import { runtimeOf } from '../../client/src/home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const FACTS = arg('--facts');
assert.ok(FACTS && existsSync(FACTS), '--facts <eden facts.json>');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/release', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const CLI = join(v2, 'client/src/cli/souls.mjs');
const WORKER = join(v2, 'web/src/source/worker.ts');
const replicaUrl = pathToFileURL(join(PKG, 'replica.js')).href;
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c)) });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (s) => console.log(`chess: ${((Date.now() - t0) / 1000).toFixed(1)} s ${s}`);

const dir = mkdtempSync(join(tmpdir(), 'served-chess-'));
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
async function waitFor(what, f, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await pause(100);
  }
}
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
function souls(home, ...args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => ok(JSON.parse(out.trim().split('\n').at(-1))));
  });
}
async function cleanup() {
  for (const d of daemons) await request(d.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill('SIGKILL');
  if (process.env.KEEP !== '1') rmSync(dir, { recursive: true, force: true });
}

try {
  const world = join(dir, 'world');
  // The Souls come in a few metres from the table (at 14 m, 14 m), so the walk to a seat is a short one.
  const seeded = await run(bin('worldd'), ['seed', '--facts', FACTS, '--dir', world, '--souls', '0', '--at', '10,12',
    '--entries', resolve(v2, '../content/kinds')]);
  assert.equal(seeded.code, 0, seeded.out);
  say(`seeded: ${/hatches: \d+/.exec(seeded.out)?.[0]}`);
  const served = run(bin('worldd'), ['serve', '--dir', world], /listening /);
  await served;
  say(`served: ${/hatches: \d+ modules/.exec(served.text())?.[0]}`);
  const gwPort = await freePort();
  const gateway = `ws://127.0.0.1:${gwPort}/v2/ws`;
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(world, 'gateway.sock'), '--tokens', join(world, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`, '--entries', join(world, 'entries')], /listening (\S+)\n/);
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', join(world, 'tokens')], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;

  async function pairOne(label) {
    const folder = join(dir, label);
    mkdirSync(folder);
    const home = join(folder, '.souls');
    const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
      '--gateway', gateway, '--device', 'chess machine', '--label', label], null, { cwd: folder, env: { SOULS_HOME: home } });
    const asked = await waitFor(`${label}'s pairing code`, () => asking.text().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve'));
    const approve = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: asked.code, confirm: true, test_person: label }) });
    assert.equal(approve.status, 200);
    const done = await asking;
    assert.equal(done.code, 0, done.out);
    const said = JSON.parse(done.out.trim().split('\n').at(-1));
    const rt = runtimeOf(home, said.soul);
    daemons.push(rt);
    return { label, home, soul: said.soul, rt, seen: [], cli: (...a) => souls(home, ...a, '--soul', said.soul) };
  }
  async function answered(s, sequence, ms = 60_000) {
    return waitFor(`${s.label}'s answer to ${sequence}`, async () => {
      s.seen.push(...(await request(s.rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer'));
      return s.seen.find((e) => e.sequence === sequence && e.answer !== 3);
    }, ms);
  }
  /** An offer of the table, sent through the thin command; the world's final answer (receipt or refusal). */
  async function offer(s, id, name, ...args) {
    const r = await s.cli('object', id, name, ...args);
    assert.equal(r.ok, true, `${s.label} ${name}: ${JSON.stringify(r)}`);
    const a = await answered(s, r.sequence);
    say(`${s.label} ${name} ${args.join(' ')}: ${a.answer === 1 ? 'receipt' : `refused ${a.reason} ${JSON.stringify(a)}`}`);
    return a;
  }

  const A = await pairOne('alder');
  const B = await pairOne('birch');
  for (const s of [A, B]) {
    const r = await s.cli('act', 'life:join');
    await answered(s, r.sequence);
  }
  say('two Souls paired and joined');

  const table = await waitFor('the chess table in the copy', async () => (await A.cli('find', 'chess table', '--limit', '20')).found?.find((r) => r.kind === 'eden:chess_table'));
  say(`the table: ${table.id}`);
  const sq = (n) => (n.charCodeAt(1) - 49) * 8 + (n.charCodeAt(0) - 97);
  const move = (s, form, from, to) => offer(s, table.id, form, `from=${sq(from)}`, `to=${sq(to)}`, 'promotion=0');

  assert.equal((await offer(A, table.id, 'play_white')).answer, 1, 'white sits');
  assert.equal((await offer(B, table.id, 'play_black')).answer, 1, 'black sits');
  assert.equal((await offer(A, table.id, 'begin')).answer, 1, 'the game begins');
  await pause(3000);
  say(`after begin, B's inspect: ${JSON.stringify(await B.cli('inspect', table.id)).slice(0, 3000)}`);

  // The public stream, as the page's worker plays it: the world's folder as the origin serves a placed world.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
    if (url.host !== 'local') return realFetch(input, init);
    const file = normalize(join(world, decodeURIComponent(url.pathname).replace(/^\/w\/eden\//, '')));
    if (!file.startsWith(world) || !existsSync(file) || !statSync(file).isFile()) return new Response(null, { status: 404 });
    return new Response(readFileSync(file));
  };
  const named = JSON.parse(readFileSync(join(world, 'views/world.json'), 'utf8'));
  const stream = new URL(named.stream.replace(/\/?$/, '/'), 'http://local/w/eden/').href;
  const nodes = new Map(), errors = [];
  globalThis.self = {
    onmessage: null,
    postMessage: (m) => {
      const p = m.t === 'part' ? m.p : m.t === 'snapshot' ? m.s : null;
      if (p) { for (const id of p.removed) nodes.delete(id); for (const n of p.nodes) nodes.set(n.id, n); }
      else if (m.t === 'error') errors.push(m.message);
    },
  };
  await import(pathToFileURL(WORKER).href);
  globalThis.self.onmessage({ data: { stream } });
  const pageKey = table.id.replace(/-(\d+)$/, '.$1');

  assert.equal((await move(A, 'move_white', 'e2', 'e4')).answer, 1, 'e2e4');
  assert.equal((await move(B, 'move_black', 'e7', 'e5')).answer, 1, 'e7e5');
  const illegal = await move(A, 'move_white', 'e1', 'e3');
  assert.equal(illegal.answer, 2, 'e1e3 is refused');
  assert.equal(illegal.reason, 'hatch-said-no', 'by name');
  assert.equal((await move(A, 'move_white', 'g1', 'f3')).answer, 1, 'Ng1f3');
  // Each copy reads the board the world wrote: the knight on f3 (21, a knight 2), e4 and e5 pawns, black to move.
  for (const s of [A, B]) {
    let last = null;
    const got = await waitFor(`the knight on f3 in ${s.label}'s copy`, async () => {
      const r = await s.cli('look', '--limit', '1');
      last = (await s.cli('inspect', table.id)).state;
      const t = JSON.stringify(last ?? {});
      return /\{"square":21,"piece":2\}/.test(t) && /\{"square":36,"piece":9\}/.test(t) && r && last;
    }, 60_000).catch((e) => { console.log(`${s.label}'s copy: ${JSON.stringify(last)}`); throw e; });
    say(`after e4 e5 Nf3, ${s.label}'s copy: ${JSON.stringify(got)}`);
  }
  const seen = await waitFor('the table in the public stream', () => nodes.get(pageKey), 30_000)
    .catch((e) => { console.log(`stream: ${nodes.size} nodes, errors ${JSON.stringify(errors)}, e.g. ${[...nodes.keys()].slice(0, 5)}, ${[...nodes.keys()].filter((k) => k.includes('5742'))}`); throw e; });
  say(`the table in the public stream (the page's worker): ${JSON.stringify(seen, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 3000)}`);
  assert.deepEqual(errors, [], 'the worker plays the stream');
  say('done');
} finally {
  await cleanup();
}

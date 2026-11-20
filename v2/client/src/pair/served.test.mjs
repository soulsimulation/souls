// Asking what happened works on a served world (Engine v2 R16b, #3480, A2): N2's test world seeded by `worldd seed`
// and run by `worldd serve` with a store, so it archives its history (O3b); its gateway (`gatewayd`, I1); and one
// origin that serves the world's folder under `w/`, the store under `s/` and stands in for the directory's approval
// (W2's own flow is pair.test.mjs's). Pairing writes the `history` the world advertises; after scripted acts,
// `history --at <place>` answers from the world's archive with no hand edit. Run from v2/ after
//   cargo build -p gatewayd -p worldd -p testworld --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { pair } from './pair.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r16b-'));
const procs = [];
let daemon = null;

function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; const m = ready.exec(out); if (m) ok({ p, m }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(100);
  }
}

/** The thin command, as a harness runs it, without blocking: this process serves the origin. */
function souls(home, args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => ok(JSON.parse(out.trim().split('\n').at(-1))));
  });
}

after(async () => {
  if (daemon) await request(daemon.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('A2: pairing to worldd serve writes the history it advertises, and history --at <place> answers after scripted acts', async () => {
  // The world: N2's test world, seeded with one Soul and the doors' entries, served with a store.
  const facts = spawnSync(bin('testworld'), ['--out', dir], { encoding: 'utf8' });
  assert.equal(facts.status, 0, facts.stderr);
  const world = join(dir, 'w'), bucket = join(dir, 'bucket');
  const seeded = spawnSync(bin('worldd'), ['seed', '--facts', join(dir, 'testworld-s1-t0.facts.json'), '--dir', world,
    '--entries', join(v2, '../content/kinds/doors'), '--souls', '1', '--at', '-40,30'], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const meta = JSON.parse(readFileSync(join(world, 'world.json'), 'utf8'));
  const name = meta.name, lineage = name.split('-')[0];
  await run(bin('worldd'), ['serve', '--dir', world, '--socket', join(dir, 'w.sock'), '--store', bucket], /listening /);
  const { m } = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', join(dir, 'w.sock'), '--tokens', join(world, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const gateway = `ws://${m[1]}/v2/ws`;

  // One origin: the world's folder under w/<name>/, the store under s/, and the directory's two pairing calls, which
  // hand over the seeded Soul's token once asked (the owner's approval stands in).
  const token = readFileSync(join(world, 'souls.tokens'), 'utf8').split('\n')[0];
  const file = (root, rest) => {
    const p = normalize(join(root, decodeURIComponent(rest)));
    return p.startsWith(root) ? p : null;
  };
  const origin = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/v1/pair/request') return res.end(JSON.stringify({ code: 'BCDF-GHJK', link: 'x', interval: 0 }));
      if (req.url === '/v1/pair/poll') return res.end(JSON.stringify({ token, grant: token.split('.')[0] }));
      const p = req.url.startsWith('/w/eden/') ? file(world, req.url.slice('/w/eden/'.length))
        : req.url.startsWith('/s/') ? file(bucket, req.url.slice(3)) : null;
      try {
        if (p && statSync(p).isFile()) return res.end(readFileSync(p));
      } catch { /* not there */ }
      res.writeHead(404).end();
    });
  });
  await new Promise((ok) => origin.listen(0, '127.0.0.1', ok));
  procs.push({ kill: () => origin.close() });
  const directory = `http://127.0.0.1:${origin.address().port}`;

  // Pairing writes the history address from the world's advert, with no hand edit.
  const home = join(dir, '.souls');
  const paired = await pair({ home, directory, world: 'eden', gateway, device: 'd', label: 'r16b', unit: 1, sleep: async () => {} });
  const history = `${directory}/s/h/${name}/${lineage}/`;
  assert.equal(paired.history, history);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).worlds.eden.history, history);

  // The world advertises it: views/world.json names the archive's folder, relative to the world's.
  assert.equal(JSON.parse(readFileSync(join(world, 'views/world.json'), 'utf8')).history, `../../s/h/${name}/${lineage}/`);

  // Scripted acts: the Soul walks to the hall and to the building, as a harness sends them.
  daemon = runtimeOf(home, paired.soul);
  await souls(home, ['status']);
  await waitFor(async () => { const s = await request(daemon.socket, { op: 'status' }).catch(() => null); return s?.connected && !s.syncing; });
  const hall = (await souls(home, ['find', 'hall'])).found[0], building = (await souls(home, ['find', 'building'])).found[0];
  const beforeActs = Date.now() * 1000;
  const sent = [];
  for (const to of [hall, building]) {
    const r = await souls(home, ['act', to.id]);
    assert.equal(r.ok, true, JSON.stringify(r));
    sent.push(r.sequence);
  }
  // Each walk has its answer from the world, and ends: a public event the archive's index holds.
  const answers = [];
  await waitFor(async () => {
    answers.push(...(await request(daemon.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer' && sent.includes(e.sequence)));
    return answers.length === sent.length;
  });

  // `history --at <place>`: the world's own place, which holds everything, answers from the archive with both walks'
  // ends, by the Soul, and the world's day, light and weather; the index is written as it stands every 5 s.
  const place = `${lineage}-0`;
  const ask = () => souls(home, ['history', '--at', place]);
  const got = await waitFor(async () => { const a = await ask(); return a.kinds?.['move-ended'] === sent.length ? a : null; });
  console.log(`A2: walks answered ${answers.map((a) => a.reason ?? a.answer).join(', ')}; history --at ${place}: ${JSON.stringify(got)}`);
  assert.equal(got.ok, true);
  assert.ok(got.span, 'the answer states its span');
  assert.equal(got.lines.filter((l) => l.includes('move-ended')).length, sent.length, 'each walk on its own line');
  assert.ok(Buffer.byteLength(JSON.stringify(got)) <= 600);
  // Compact history keeps only four kind counts and five newest lines. Ask for the boot interval separately so
  // later action/deadline events cannot hide a world's event from the compact answer.
  const worldEvents = await souls(home, ['history', '--at', place, '--until', String(beforeActs)]);
  assert.equal(worldEvents.ok, true);
  assert.ok(['light-changed', 'new-day', 'weather-changed'].every((k) => worldEvents.kinds[k] >= 1 || worldEvents.lines.some((l) => l.includes(k))), 'and the world\'s own events');
  assert.ok(Buffer.byteLength(JSON.stringify(worldEvents)) <= 600);
});

// A Soul paired, then joined, acting and retired in a running world (Engine v2 C3, #3367), end to end through the
// gateway: the real directory (`directoryd`, W2's pairing), the gateway (`gatewayd`, I1) started before the pairing
// on the world's tokens file, a world seeded from N2's test world and served (`worldd seed`, `worldd serve`), and the
// daemon (R6). The pairing rewrites the tokens file while the gateway runs; the new token signs in with no restart
// (A3). The Soul's first intent, its join, births its body (A1); it takes a box; its leave retires the body and sets
// the box down (A2). Run from v2/ after
//   cargo build -p directoryd -p gatewayd -p worldd -p testworld --locked, and replica's wasm-bindgen package.
// The world can be another facts file: C3_FACTS, C3_ENTRIES (a folder of `souls-entry/1` files), C3_AT ("x,z" m),
// C3_FIND (the words that find the thing), C3_VERBS (its verbs, comma-separated, each an act in turn).

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-c3-'));
const procs = [];
const outputs = [];

function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; outputs.push(String(d)); const m = ready?.exec(out); if (m) ok({ p, m, out: () => out }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => (ready ? fail(new Error(`${path} ended (${c}): ${out}`)) : ok({ p, out, code: c })));
  });
}

async function waitFor(f, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(25);
  }
}

const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

after(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** The test world's facts (N2, seed 1, three boxes), the box on the open ground, and an entry with its take. */
async function testWorld() {
  await run(bin('testworld'), ['--seed', '1', '--things', '3', '--out', dir]);
  const facts = join(dir, 'testworld-s1-t3.facts.json');
  const box = JSON.parse(readFileSync(facts, 'utf8')).things.find((t) => t.id === 'box-00003' && !t.parent);
  assert.ok(box, 'a box on the open ground');
  const entries = join(dir, 'entries');
  mkdirSync(entries);
  // As Eden's own entries write a take (C12): walk to the box's side, then take it. The side is 800 mm from the box's
  // middle, where a body stands clear of its solid; 500 mm is within a body's radius of it, off the ground a body
  // stands on, and the walk is refused `souls:no-way` (C3's failure).
  writeFileSync(join(entries, 'box.json'), JSON.stringify({
    format: 'souls-entry/1', kind: 'testworld:box', owner: 'thing',
    points: { side: { role: 'stand', at_mm: [-800, 0, 0] } },
    forms: { take: { who: 'anyone', steps: [{ step: 'walk_to', point: 'side' }, { step: 'take' }],
      effects: [{ change: 'reparent', what: 'this', into: 'actor_hand' }] } },
  }));
  // The first birth stands 1 m east of the entry (K10's ring): 3 m west of the box, out of any reach (A3).
  const [x, , z] = box.pose;
  return { facts, entries, at: `${(x - 4000) / 1000},${z / 1000}`, find: 'box', verbs: ['testworld:take'] };
}

const receipts = (d) => readdirSync(d).flatMap((f) => readFileSync(join(d, f), 'utf8').trim().split('\n')).filter(Boolean).map((l) => JSON.parse(l));

test('A1 to A4: paired while the gateway runs, the Soul joins, acts and leaves, each one receipt', async () => {
  const w = process.env.C3_FACTS
    ? { facts: process.env.C3_FACTS, entries: process.env.C3_ENTRIES, at: process.env.C3_AT ?? '0,0', find: process.env.C3_FIND, verbs: process.env.C3_VERBS.split(',') }
    : await testWorld();

  // The world: seeded with no Soul, served.
  const world = join(dir, 'world');
  await run(bin('worldd'), ['seed', '--facts', w.facts, '--dir', world, '--souls', '0', '--at', w.at, ...(w.entries ? ['--entries', w.entries] : [])]);
  assert.equal(readFileSync(join(world, 'tokens'), 'utf8'), '', 'no token before the pairing');
  await run(bin('worldd'), ['serve', '--dir', world], /listening /);

  // The gateway, on the world's tokens file, before any pairing; the directory writes that file.
  const gwPort = await freePort();
  const gateway = `ws://127.0.0.1:${gwPort}/v2/ws`;
  const receiptsDir = join(dir, 'receipts');
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(world, 'gateway.sock'), '--tokens', join(world, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', receiptsDir], /listening (\S+)\n/);
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', join(world, 'tokens')], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;

  // Pair: the daemon asks, the owner approves once, the token comes back; the tokens file now holds its hash.
  const folder = join(dir, 'agent');
  mkdirSync(folder);
  const home = join(folder, '.souls');
  const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
    '--gateway', gateway, '--device', 'test machine', '--label', 'test agent'],
  null, { cwd: folder, env: { PATH: process.env.PATH, SOULS_HOME: home } });
  const asked = await waitFor(() => outputs.map((o) => o.split('\n')).flat().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve'));
  const approve = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
  assert.equal(approve.status, 200);
  const done = await asking;
  assert.equal(done.code, 0, done.out);
  const said = JSON.parse(done.out.trim().split('\n').at(-1));
  assert.ok(readFileSync(join(world, 'tokens'), 'utf8').includes(said.grant), 'the directory rewrote the tokens file');

  const rt = runtimeOf(home, said.soul);
  // The gateway writes an act's record at its end: a form's or a walk's accepted (C20, W11 #4087) answers it, but is
  // not its end, so each act waits for its own record.
  const recorded = () => { try { return receipts(receiptsDir).length; } catch { return 0; } };
  const act = async (req) => {
    const before = recorded();
    const a = await call(home, said.soul, { op: 'act', ...req }, { pkg: PKG });
    outputs.push(JSON.stringify(a));
    assert.equal(a.ok, true, JSON.stringify(a));
    await waitFor(async () => recorded() > before, 30_000);
    return receipts(receiptsDir).at(-1);
  };
  const find = async (words) => (await request(rt.socket, { op: 'find', words, limit: 50 })).found;
  try {
    // A1, A3: the first intent, a join, signs in with the new token (no gateway restart) and births the body.
    const joined = await act({ verb: 'life:join' });
    console.log('join', JSON.stringify(joined));
    assert.equal(joined.outcome, 'receipt', 'the join is answered with its birth');
    assert.equal(joined.soul, said.grant);
    const body = await waitFor(async () => (await find('body')).find((r) => r.kind?.startsWith('souls:body')));
    console.log('body', JSON.stringify(body));

    // An act on the born body: the thing on the open ground nearest the entry.
    const thing = (await find(w.find)).find((r) => /^ground/.test(r.in ?? ''));
    assert.ok(thing, `a ${w.find} on the open ground`);
    for (const verb of w.verbs) {
      const r = await act({ verb, target: thing.id });
      console.log(verb, thing.id, JSON.stringify(r));
      assert.equal(r.outcome, 'receipt', `${verb} lands`);
    }

    // A2: the leave retires the body: its row gone from the copy.
    const left = await act({ verb: 'life:leave' });
    console.log('leave', JSON.stringify(left));
    assert.equal(left.outcome, 'receipt', 'the leave is answered with its entry');
    await waitFor(async () => !(await find('body')).some((r) => r.id === body.id));
    assert.equal(receipts(receiptsDir).length, 2 + w.verbs.length, 'one answer each');
  } finally {
    await request(rt.socket, { op: 'stop' }).catch(() => {});
  }
  // The token is in no output.
  const token = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).souls[said.soul].local.token;
  for (const o of outputs) assert.ok(!String(o).includes(token.split('.')[1]), 'the token is in no output');
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
});

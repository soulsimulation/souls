// Conversations and activities on a served world (Engine v2 C30, #3556), end to end through the gateway: a world
// seeded and served (`worldd seed`, `worldd serve`) with the conversation's kind and its entries' activity kinds, the
// gateway (I1), the directory's pairing (W2) and three daemons (R6). Three Souls pair and join (C3); the first offers
// the second a conversation, the second accepts, each takes a turn (the second's `--private`), and both leave (A2);
// the third, standing by, hears the public turn and not the private one. Then the first offers the second the
// entries' two-role activity and the second joins it (A3). Run from v2/ after
//   cargo build -p directoryd -p gatewayd -p worldd -p testworld --locked, and replica's wasm-bindgen package.
// The world can be another facts file: C30_FACTS, C30_ENTRIES (a folder of `souls-entry/1` files, one with two
// roles), C30_AT ("x,z" m, where bodies are born) and C30_GAME (that entry's kind).

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode } from '../brief/copy.mjs';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scratch = resolve(v2, '../.local/3556');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, 'journey-'));
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

async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(50);
  }
}

const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

after(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** N2's test world (seed 1), born on its open ground, with one entry of two roles. */
async function testWorld() {
  await run(bin('testworld'), ['--seed', '1', '--things', '3', '--out', dir]);
  const facts = join(dir, 'testworld-s1-t3.facts.json');
  const box = JSON.parse(readFileSync(facts, 'utf8')).things.find((t) => t.id === 'box-00003' && !t.parent);
  const entries = join(dir, 'entries');
  mkdirSync(entries);
  writeFileSync(join(entries, 'board.json'), JSON.stringify({
    format: 'souls-entry/1', kind: 'testworld:board', owner: 'thing',
    roles: { first: { need: 'required', places: { in: 'this', slots: ['north'] } }, second: { need: 'required', places: { in: 'this', slots: ['south'] } } },
  }));
  const [x, , z] = box.pose;
  return { facts, entries, at: `${(x - 1580) / 1000},${z / 1000}`, game: 'testworld:board' };
}

const receipts = (d) => (existsSync(d) ? readdirSync(d) : []).flatMap((f) => readFileSync(join(d, f), 'utf8').trim().split('\n')).filter(Boolean).map((l) => JSON.parse(l));

let configuration;
const configuredWorld = () => configuration ??= process.env.C30_FACTS
  ? { facts: process.env.C30_FACTS, entries: process.env.C30_ENTRIES, at: process.env.C30_AT ?? '0,0', game: process.env.C30_GAME }
  : testWorld();

/** Follow the same pointer/header reference as the served stream's reader, not the log's header hash. */
function activityPin(world, plain) {
  const stream = resolve(world, JSON.parse(readFileSync(join(world, 'views/world.json'), 'utf8')).stream);
  const pointer = decode(readFileSync(join(stream, 'pointer')));
  const hash = pointer.get(3);
  assert.ok(hash instanceof Uint8Array && hash.length === 34, 'the stream points to a header hash');
  const header = decode(readFileSync(resolve(stream, '../../../headers', Buffer.from(hash).toString('hex'))));
  const pins = header.get(6).filter((name) => typeof name === 'string'
    && name.startsWith(`${plain}@`) && /^1220[0-9a-f]{64}$/.test(name.slice(plain.length + 1)));
  assert.equal(pins.length, 1, 'the exact activity kind has one pin in the served header');
  return pins[0];
}

test('the actual served header activity pin passes strict wire admission with exact role and recipient', async () => {
  const w = await configuredWorld();
  const world = join(dir, 'preflight-world');
  const seeded = await run(bin('worldd'), ['seed', '--facts', w.facts, '--dir', world, '--souls', '0', '--at', w.at, '--entries', w.entries]);
  assert.equal(seeded.code, 0, seeded.out);
  const served = await run(bin('worldd'), ['serve', '--dir', world], /listening /);
  try {
    const plain = `${w.game}_activity`;
    const pin = activityPin(world, plain);
    const roles = JSON.parse(readFileSync(join(world, 'entries', `${w.game.replace(':', '.')}.json`), 'utf8')).roles;
    const role = `${w.game.split(':')[0]}:${Object.keys(roles).find((k) => k !== 'now')}`;
    const scope = Buffer.from('11'.repeat(16), 'hex');
    const recipient = `${scope.toString('hex')}-3`;
    const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
    wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
    // wireIntent calls the gateway's strict I2 decoder before returning these bytes.
    const frame = wire.wireIntent(scope, 2n, 'activity:offer', 1n, new Uint8Array(), 9n,
      `${scope.toString('hex')}-1`, undefined, undefined, JSON.stringify({ 1: pin, 2: role, 3: [recipient] }));
    const params = decode(frame).get(4);
    assert.deepEqual(params.get(1), [plain, Uint8Array.from(Buffer.from(pin.split('@')[1], 'hex'))]);
    assert.equal(params.get(1)[1].length, 34);
    assert.equal(params.get(2), role);
    assert.deepEqual(params.get(3), [[Uint8Array.from(scope), 3]]);
    console.log('actual served header pin: unique; strict I2 offer: admitted; kind, role and recipient: exact');
  } finally {
    served.p.kill();
  }
});

test('A1 to A3: two joined Souls converse, a bystander hears no private turn, and an entry\'s activity is offered and joined', async () => {
  const w = await configuredWorld();

  // A1: the world, seeded with no Soul and served, loads the conversation's kind and the entry's activity kind.
  const world = join(dir, 'world');
  const seeded = await run(bin('worldd'), ['seed', '--facts', w.facts, '--dir', world, '--souls', '0', '--at', w.at, '--entries', w.entries]);
  assert.equal(seeded.code, 0, seeded.out);
  const served = await run(bin('worldd'), ['serve', '--dir', world], /listening /);
  const loaded = /activities: (.*)\n/.exec(served.out())?.[1].split(', ');
  console.log('activities:', loaded.join(', '));
  assert.ok(loaded.includes('souls:conversation'), 'the conversation kind is loaded');
  const game = `${w.game}_activity`;
  assert.ok(loaded.includes(game), `the entry's activity kind is loaded: ${game}`);

  const gwPort = await freePort();
  const gateway = `ws://127.0.0.1:${gwPort}/v2/ws`;
  const receiptsDir = join(dir, 'receipts');
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(world, 'gateway.sock'), '--tokens', join(world, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', receiptsDir], /listening (\S+)\n/);
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', join(world, 'tokens')], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;

  /** Pairs one Soul in a folder of its own, its daemon's calls, and its body once its join is answered. */
  async function soul(label) {
    const folder = join(dir, label);
    mkdirSync(folder);
    const home = join(folder, '.souls');
    const mark = outputs.length;
    const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
      '--gateway', gateway, '--device', 'test machine', '--label', label],
    null, { cwd: folder, env: { PATH: process.env.PATH, SOULS_HOME: home } });
    const asked = await waitFor(() => outputs.slice(mark).map((o) => o.split('\n')).flat().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve'));
    const approve = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
    assert.equal(approve.status, 200);
    const done = await asking;
    assert.equal(done.code, 0, done.out);
    const said = JSON.parse(done.out.trim().split('\n').at(-1));
    const rt = runtimeOf(home, said.soul);
    const me = said.grant.replace(/^soul-/, '').replace(/-(\d+)$/, '-$1');
    const ask = (req) => call(home, said.soul, req, { pkg: PKG });
    const s = { label, home, rt, me, ask, said };
    /** Sends `req` and waits for every intent it sent to be answered; the receipts written meanwhile. */
    s.act = async (req) => {
      const before = (await request(rt.socket, { op: 'status' }).catch(() => ({ answered: 0 }))).answered ?? 0;
      const n = receipts(receiptsDir).length;
      const a = await ask(req);
      outputs.push(JSON.stringify(a));
      console.log(label, 'sent', JSON.stringify(a));
      assert.equal(a.ok, true, `${label} ${JSON.stringify(req)}: ${JSON.stringify(a)}`);
      const sent = a.sent?.length ?? 1;
      try {
        await waitFor(async () => {
          const events = await ask({ op: 'wait', seconds: 0 });
          for (const e of events.events ?? []) {
            s.events.push(e);
            if (e.kind === 'heard') s.heard.push(e);
            assert.ok(!(e.kind === 'answer' && e.answer === 5 && e.sequence === null),
              `gateway unread refusal: ${e.reason}`);
          }
          const st = await request(rt.socket, { op: 'status' });
          return st.connected && st.unanswered.length === 0 && st.answered >= before + sent && st;
        });
      } catch (e) {
        const st = await request(rt.socket, { op: 'status' });
        console.log(label, 'unanswered', JSON.stringify({ connected: st.connected, sequence: st.sequence, unanswered: st.unanswered, answered: st.answered }), 'receipts', JSON.stringify(receipts(receiptsDir).slice(n).map((r) => ({ outcome: r.outcome, code: r.code ?? r.reason }))));
        throw e;
      }
      const got = receipts(receiptsDir).slice(n);
      console.log(label, JSON.stringify(req), '->', JSON.stringify(got.map((r) => ({ verb: r.verb, outcome: r.outcome, code: r.code ?? r.reason }))));
      return got;
    };
    s.find = async (words) => (await request(rt.socket, { op: 'find', words, limit: 50 })).found;
    s.heard = [];
    s.events = [];
    /** Waits until `pred` holds of an event `wait` hands this Soul; heard words are kept. */
    s.waitEvent = (pred, ms = 30_000) => waitFor(async () => {
      const r = await ask({ op: 'wait', seconds: 2 });
      for (const e of r.events ?? []) { s.events.push(e); if (e.kind === 'heard') s.heard.push(e); }
      return s.events.find(pred);
    }, ms);
    return s;
  }

  const [a, b, c] = [await soul('first'), await soul('second'), await soul('bystander')];
  try {
    // C3: each Soul's join births its body by the entry, within talk's reach of the others.
    for (const s of [a, b, c]) {
      const [joined] = await s.act({ op: 'act', verb: 'life:join' });
      assert.equal(joined.outcome, 'receipt', `${s.label} is born`);
    }
    const bodyOf = async (s) => waitFor(async () => (await a.find('body')).find((r) => r.kind?.startsWith('souls:body') && r.soul === s.said.grant.replace(/^soul-/, '')));
    const [ba, bb, bc] = [await bodyOf(a), await bodyOf(b), await bodyOf(c)];
    console.log('bodies', ba.id, bb.id, bc.id, 'under', ba.parent);
    for (const [s, body] of [[a, ba], [b, bb], [c, bc]]) {
      const st = await waitFor(async () => {
        const st = await request(s.rt.socket, { op: 'status' });
        return st.hearing === body.id && st.viewGrants > 0 && st;
      });
      console.log(s.label, 'subscription', JSON.stringify({ hearing: st.hearing, grants: st.viewGrants, kinds: st.viewKinds }));
    }

    // A2: start (the offer and the opening whisper), accept, a public turn, a private turn, and both leave.
    const started = await a.act({ op: 'converse', do: 'start', with: bb.id, words: 'got a minute?' });
    assert.deepEqual(started.map((r) => r.outcome), ['receipt', 'receipt'], 'the offer and the whisper land');
    const invited = await b.waitEvent((e) => e.kind === 'conversation' && e.what === 'invited');
    const conv = invited.conversation;
    console.log('invited', JSON.stringify(invited));
    const [accepted] = await b.act({ op: 'converse', do: 'accept', conversation: conv });
    assert.equal(accepted.outcome, 'receipt', 'the accept lands');
    const listed = await a.ask({ op: 'converse', do: 'list' });
    assert.ok(listed.conversations.some((x) => x.id === conv), 'the opener finds the conversation in its copy');
    const [pub] = await a.act({ op: 'converse', do: 'say', conversation: conv, words: 'the bandstand at noon' });
    assert.equal(pub.outcome, 'receipt', 'the public turn lands');
    const [priv] = await b.act({ op: 'converse', do: 'say', conversation: conv, words: 'bring the blue key', private: true });
    assert.equal(priv.outcome, 'receipt', 'the private turn lands');
    // The members hear each other's turns; the bystander hears the public one only.
    await b.waitEvent((e) => e.kind === 'heard' && e.words === 'the bandstand at noon');
    await a.waitEvent((e) => e.kind === 'heard' && e.words === 'bring the blue key');
    await c.waitEvent((e) => e.kind === 'heard' && e.words === 'the bandstand at noon');
    await sleep(1500);
    await c.waitEvent(() => true, 3000).catch(() => {});
    console.log('bystander heard', JSON.stringify(c.heard.map((e) => ({ from: e.from, words: e.words, whisper: e.whisper }))));
    assert.ok(!c.heard.some((e) => e.words === 'bring the blue key'), 'the bystander hears no private turn');
    assert.ok(!c.heard.some((e) => e.words === 'got a minute?'), 'nor the opening whisper');
    const [la] = await a.act({ op: 'converse', do: 'leave', conversation: conv });
    const [lb] = await b.act({ op: 'converse', do: 'leave', conversation: conv });
    assert.deepEqual([la.outcome, lb.outcome], ['receipt', 'receipt'], 'both leaves land');
    const log = readFileSync(join(world, 'log'));
    assert.ok(!log.includes('bring the blue key'), 'the private words are not in the log');
    console.log('log', log.length, 'bytes: no private words in it');
    // #3775: spectators see who is in the private conversation, never its words: the words are in no public part, no
    // views/ file and no history/ file (the record itself is read by the page's worker in the served e2e gate).
    // The world is still writing: a file renamed away between the listing and the read is skipped.
    const read = (f) => { try { return statSync(f).isFile() ? readFileSync(f) : null; } catch { return null; } };
    const files = (root) => (existsSync(root) ? readdirSync(root, { recursive: true }).map((f) => join(root, f)).filter((f) => read(f)) : []);
    const publicFiles = [...files(join(world, 'views')), ...files(join(world, 'history'))];
    for (const f of publicFiles) assert.ok(!read(f)?.includes('blue key'), `the private words are in no public file: ${f.slice(world.length)}`);
    console.log('public files', publicFiles.length, ': no private words');

    // A3: the entry's two-role activity, offered by the first to the second, joined by the second.
    const plainGame = game;
    const full = await waitFor(async () => {
      const r = await a.ask({ op: 'status' });
      return r.ok && r;
    });
    assert.ok(full);
    const kindName = activityPin(world, plainGame);
    const ns = w.game.split(':')[0];
    const roles = JSON.parse(readFileSync(join(world, 'entries', `${w.game.replace(':', '.')}.json`), 'utf8')).roles;
    const [r1, r2] = Object.keys(roles).filter((k) => k !== 'now').map((k) => `${ns}:${k}`);
    const [offered] = await a.act({ op: 'act', verb: 'activity:offer', target: ba.parent, params: { 1: kindName, 2: r1, 3: [bb.id] } });
    assert.equal(offered.outcome, 'receipt', `the ${plainGame} offer lands`);
    const asked2 = await b.waitEvent((e) => e.kind === 'conversation' && e.what === 'invited' && e.conversation !== conv);
    console.log('offered', JSON.stringify(asked2), 'roles', r1, r2);
    const [joined] = await b.act({ op: 'act', verb: 'activity:accept', target: asked2.conversation });
    assert.equal(joined.outcome, 'receipt', `the ${plainGame} is joined`);
    const rows = await waitFor(async () => (await a.find(plainGame.split(':')[1])).find((r) => r.id === asked2.conversation));
    console.log('activity', JSON.stringify(rows));
    for (const s of [a, b]) await s.act({ op: 'act', verb: 'activity:leave', target: asked2.conversation });
  } finally {
    for (const s of [a, b, c]) {
      const st = await request(s.rt.socket, { op: 'status' }).catch(() => null);
      console.log(s.label, 'transport', JSON.stringify(st && { hearing: st.hearing, grants: st.viewGrants, kinds: st.viewKinds, drops: st.drops }));
      console.log(s.label, 'recent answers', JSON.stringify(s.events.filter((e) => e.kind === 'answer').slice(-8)
        .map((e) => ({ sequence: e.sequence, answer: e.answer, ...(e.reason ? { reason: e.reason } : {}) }))));
      const log = existsSync(s.rt.log) ? readFileSync(s.rt.log, 'utf8').split('\n').slice(-12) : [];
      console.log(s.label, 'daemon tail', JSON.stringify(log));
      await request(s.rt.socket, { op: 'stop' }).catch(() => {});
    }
    console.log('service diagnostics', JSON.stringify(outputs.filter((x) => /view tier|views:|refused|panicked/.test(x)).slice(-20)));
  }
});

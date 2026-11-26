// The agent connection fault run: the real client daemon (`v2/client/src/daemon`) ↔ gatewayd ↔ worldd, on a served
// world with no minds, one fault an arm, and one row of the table each. It measures what the person's agent sees: does
// every act get its answer exactly once, how long until it can act again, does a `wait` across the fault come back,
// is anything said lost or heard twice, and does anything fail silently (a daemon that says it is connected while no
// byte moves, an act sent and never answered).
//
//   gateway   the gateway SIGKILLed mid-walk, started again on its port 1 s later
//   world     the world SIGKILLed mid-walk, served again from its folder 1 s later
//   net5      the agent's network stalls (nothing moves either way, no close) for 5 s, mid-walk
//   net60     the same for 60 s
//   sleep     a laptop asleep 10 min (FAULTS_SLEEP_S): the daemon SIGSTOPped and its network stalled; at the wake
//             its old connections are gone (reset, as a NAT that forgot them) and the daemon runs again
//   two       a second daemon for the same Soul from a copy of its home (another machine), both acting for 60 s
//   slow      the agent's downstream throttled to 512 bytes a second for 60 s while eight Souls talk beside it
//   herd      30 agents; the world and the gateway SIGKILLed together and started again (a host restart): each
//             agent's time until it can act again
//
// Each Soul's daemon reaches the gateway through its own loopback proxy, so one agent's network can stall alone while
// the listener beside it (B) stays connected and hears what is said. Each arm is its own world, folder and ports, so
// arms can run at once (`FAULTS_PARALLEL=1`). Prints a markdown table and writes `<root>/faults.json`.
//
//   node v2/client/served/e2e/faults.mjs [arm ...]
//   FAULTS_BIN   the folder holding release worldd, gatewayd, testworld (default v2/target/release)
//   SOULS_REPLICA_PKG   replica's wasm-bindgen package (default v2/target/wasm-load/pkg)
//   FAULTS_ROOT  scratch (default <repo>/.local/faults); FAULTS_SLEEP_S the sleep arm's seconds (default 600)
//
// Local only: loopback ports, its own folders, fake minds; never a production world or its data.

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, startReady } from '../../src/daemon/client.mjs';
import { runtimeOf } from '../../src/home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const BIN = process.env.FAULTS_BIN ?? join(v2, 'target/release');
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const ROOT = resolve(process.env.FAULTS_ROOT ?? join(v2, '../.local/faults'));
const SLEEP_S = Number(process.env.FAULTS_SLEEP_S ?? 600);
const content = resolve(v2, '../content/kinds');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();

function run(path, args, { ready, log } = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, BRAIN_MODE: 'fake' } });
  procs.add(p);
  let out = '';
  const done = new Promise((ok, fail) => {
    const take = (d) => { out += d; if (log) writeFileSync(log, d, { flag: 'a' }); const m = ready?.exec(out); if (m) ok({ p, m }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => { procs.delete(p); ready ? fail(new Error(`${path} ended (${c}) before it was ready: ${out.slice(-1500)}`)) : ok({ p, out, code: c }); });
  });
  done.p = p;
  return done;
}

async function waitFor(what, f, ms = 30_000, every = 100) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await pause(every);
  }
}

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

// ---- The world: N2's test world with a bench 20 m west and a chair 20 m east of where the Souls stand --------------
const BENCH = [-20000, 0, 6000], CHAIR = [20000, 0, 6000];
async function base() {
  const dir = join(ROOT, 'base');
  const facts = join(dir, 'faults.facts.json'), entries = join(dir, 'entries');
  if (existsSync(facts)) return { facts, entries };
  mkdirSync(entries, { recursive: true });
  const t = await run(join(BIN, 'testworld'), ['--seed', '1', '--things', '0', '--out', dir]);
  if (t.code !== 0) throw new Error(`testworld: ${t.out}`);
  const f = JSON.parse(readFileSync(join(dir, 'testworld-s1-t0.facts.json'), 'utf8'));
  f.kinds.find((k) => k.ref === 'testworld-door@1').name = 'eden:door';
  const kind = (ref, name) => ({ ref, hash: Buffer.from(`souls/faults/${ref}`).toString('hex').padEnd(64, '0').slice(0, 64), name, form: 'point' });
  f.kinds.push(kind('f-bench@1', 'eden:bench'), kind('f-chair@1', 'eden:chair'));
  const thing = (id, def, pose, name, slots) => ({ id, def, ref: def, parent: null, pose, scale_ppm: 1_000_000, name, slots });
  const slot = (n, id, at) => ({ n, id, kind: 'seat', at, yaw: 0, capacity: 1 });
  f.things.push(thing('bench-1', 'f-bench@1', [...BENCH, 0], 'the west bench', [slot(1, 'left', [-400, 465, 20]), slot(2, 'right', [400, 465, 20])]),
    thing('chair-1', 'f-chair@1', [...CHAIR, 0], 'the east chair', [slot(1, 'seat', [0, 470, 20])]));
  for (const e of ['doors/door.json', 'seating/bench.json', 'seating/chair.json', 'body/humanoid.json']) copyFileSync(join(content, e), join(entries, e.replace('/', '-')));
  writeFileSync(facts, JSON.stringify(f));
  return { facts, entries };
}

/** A loopback proxy in front of the gateway for one Soul: `stall` stops every byte both ways (connections stay open, new
 *  ones are accepted and go nowhere), `cut` resets every connection, `throttle(n)` lets n bytes a second down. */
function proxy(target) {
  const conns = new Set();
  let mode = 'pass', rate = 0;
  const server = createServer((down) => {
    const up = createConnection(target(), '127.0.0.1');
    const c = { down, up, queue: [] };
    conns.add(c);
    const end = () => { conns.delete(c); down.destroy(); up.destroy(); };
    down.on('error', end); up.on('error', end); down.on('close', end); up.on('close', end);
    down.on('data', (d) => { up.write(d); });
    up.on('data', (d) => { if (mode === 'throttle') { c.queue.push(d); up.pause(); drain(c); } else down.write(d); });
    if (mode === 'stall') { down.pause(); up.pause(); }
  });
  // Throttled: the queue goes down at `rate` bytes a second; the upstream is paused while it holds anything.
  function drain(c) {
    if (c.timer) return;
    c.timer = setInterval(() => {
      let budget = Math.max(1, Math.round(rate / 10));
      while (budget > 0 && c.queue.length) {
        const d = c.queue[0];
        const n = Math.min(budget, d.length);
        c.down.write(d.subarray(0, n));
        budget -= n;
        if (n === d.length) c.queue.shift(); else c.queue[0] = d.subarray(n);
      }
      if (!c.queue.length) { clearInterval(c.timer); c.timer = null; if (mode === 'throttle' || mode === 'pass') c.up.resume(); }
      if (mode === 'pass' && c.queue.length) { for (const d of c.queue.splice(0)) c.down.write(d); clearInterval(c.timer); c.timer = null; c.up.resume(); }
    }, 100);
  }
  return {
    listen: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port))),
    stall() { mode = 'stall'; for (const c of conns) { c.down.pause(); c.up.pause(); } },
    pass() { mode = 'pass'; for (const c of conns) { c.down.resume(); if (!c.queue.length) c.up.resume(); } },
    cut() { for (const c of [...conns]) { c.down.resetAndDestroy?.() ?? c.down.destroy(); c.up.destroy(); } },
    throttle(n) { mode = 'throttle'; rate = n; },
    close: () => { server.close(); for (const c of conns) { c.down.destroy(); c.up.destroy(); } },
  };
}

/** One arm's world: seeded with `souls` Souls, served, behind its gateway. */
async function world(arm, souls) {
  const { facts, entries } = await base();
  const dir = join(ROOT, arm);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const w = join(dir, 'w');
  const seeded = await run(join(BIN, 'worldd'), ['seed', '--facts', facts, '--dir', w, '--souls', String(souls), '--at', '0,0', '--entries', entries]);
  if (seeded.code !== 0) throw new Error(`seed: ${seeded.out}`);
  const tokens = readFileSync(join(w, 'souls.tokens'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/).at(-1)).filter((t) => t.startsWith('soul-'));
  const gwPort = await freePort();
  const it = { dir, w, tokens, gwPort, worldP: null, gatewayP: null };
  it.serve = async () => { const r = run(join(BIN, 'worldd'), ['serve', '--dir', w], { ready: /listening /, log: join(dir, 'worldd.log') }); it.worldP = r.p; await r; };
  it.gateway = async () => {
    const r = run(join(BIN, 'gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(w, 'gateway.sock'), '--tokens', join(w, 'tokens'),
      '--build', `1220${'ab'.repeat(32)}`, '--entries', join(w, 'entries')], { ready: /listening (\S+)\n/, log: join(dir, 'gatewayd.log') });
    it.gatewayP = r.p;
    await r;
  };
  it.kill = (p, sig = 'SIGKILL') => new Promise((ok) => { if (!p || p.exitCode !== null) return ok(); p.once('exit', ok); p.kill(sig); });
  await it.serve();
  await it.gateway();
  return it;
}

// ---- A Soul: its home, its proxy, its daemon -------------------------------------------------------------------------
async function soulOf(w, k, name, { home: from } = {}) {
  const token = w.tokens[k];
  const grant = token.split('.')[0];
  const id = `s_${grant.slice('soul-'.length)}`;
  const p = proxy(() => w.gwPort);
  const port = await p.listen();
  const home = join(w.dir, `home-${name}`, '.souls');
  if (from) cpSync(from, home, { recursive: true, filter: (s) => !s.includes('/runtime') });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { gateway: `ws://127.0.0.1:${port}/v2/ws` } }, souls: { [id]: { id, world: 'local', name } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [id]: { local: { token } } } }), { mode: 0o600 });
  const rt = runtimeOf(home, id);
  const s = { name, id, home, rt, proxy: p, n: 0, log: [], pid: null };
  s.req = (r, ms = 15_000) => request(rt.socket, r, ms);
  s.start = async () => {
    const r = await startReady(home, id, PKG);
    if (!r.ready) throw new Error(`${name}'s daemon did not start: ${JSON.stringify(r)}: ${readFileSync(rt.log, 'utf8').slice(-800)}`);
    s.pid = (await s.req({ op: 'status' })).pid;
  };
  // Every event, numbered, without taking any (`wait` still gets them).
  s.pull = async () => {
    const r = await s.req({ op: 'events', since: s.n }, 5000).catch(() => null);
    if (!r?.events) return;
    for (const e of r.events) { s.log.push({ ...e, t: Date.now() }); s.n = Math.max(s.n, e.n); }
  };
  s.answers = (seq) => s.log.filter((e) => e.kind === 'answer' && e.sequence === seq);
  s.final = (seq) => s.answers(seq).filter((e) => e.answer !== 3);
  s.heard = (words) => s.log.filter((e) => e.kind === 'heard' && e.words === words);
  return s;
}

const ANSWER = ['', 'receipt', 'refused', 'accepted', 'resolved', 'unread'];
const sec = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(1));

/** Ready: signed in, its body in the world (its arrival join answered), its copy current. */
async function ready(s) {
  await waitFor(`${s.name} connected and standing`, async () => {
    const st = await s.req({ op: 'status' }, 5000);
    if (!st.connected) return false;
    const look = await s.req({ op: 'look' }, 15_000);
    return look.in_world !== false && !JSON.stringify(look).includes('"in_world":false');
  }, 90_000, 500);
}

// ---- One arm: A acts across the fault, B (beside it) listens --------------------------------------------------------
/**
 * The common measure: A says one line, starts a 40 m walk, and starts a `wait`; the fault comes 2 s into the walk; A
 * says a line during it; at the fault's end A says a probe line every 2 s until one is answered (time to act again).
 * Then everything settles for up to 60 s and each sequence's answers, each line's hearings and A's connection timeline
 * are counted.
 */
async function measure(arm, w, A, B, fault, { note = '' } = {}) {
  const t0 = Date.now();
  const timeline = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const st = await A.req({ op: 'status' }, 3000).catch(() => null);
      timeline.push({ t: Date.now() - t0, connected: st ? st.connected : null });
      await Promise.all([A.pull(), B.pull()]);
      await pause(250);
    }
  })();
  const said = [];
  async function say(words) {
    const at = Date.now();
    const r = await A.req({ op: 'say', words }, 30_000).catch((e) => ({ ok: false, code: e.code ?? e.message }));
    said.push({ words, sequence: r.sequence ?? null, ok: r.ok, sent: r.sent, ms: Date.now() - at, code: r.code, gap: r.gap?.why });
    return r;
  }
  await say(`${arm} before`);
  const walk = await A.req({ op: 'act', acts: ['bench-1'] }, 30_000);
  const walkSeq = walk.sequence;
  // A `wait` begun before the fault: when does it come back, and with what?
  const waitAt = Date.now();
  const waiting = A.req({ op: 'wait', seconds: 120 }, 130_000).then((r) => ({ ms: Date.now() - waitAt, ok: r.ok, events: (r.events ?? []).map((e) => e.kind).join(','), gap: r.gap?.why ?? null, stale: !!r.stale, connected: r.connected }))
    .catch((e) => ({ ms: Date.now() - waitAt, error: e.code ?? e.message }));
  // The walk's first answer (accepted, its route planned) before the fault, so the fault is mid-walk.
  await waitFor('the walk accepted', async () => { await A.pull(); return A.answers(walkSeq).length > 0; }, 20_000).catch(() => null);
  await pause(2000);
  const faultAt = Date.now();
  const during = [];
  const endAt = await fault({ say: async (w2) => { const r = await say(w2); during.push(r); return r; } });
  const faultEnd = endAt ?? Date.now();
  // Time to act again: a probe line every 2 s until one is answered.
  let actAgain = null, probes = 0;
  const probeUntil = Date.now() + 180_000;
  const pending = [];
  while (Date.now() < probeUntil && actAgain === null) {
    const r = await say(`${arm} probe ${++probes}`);
    if (r.sequence) pending.push(r.sequence);
    const until = Date.now() + 2000;
    while (Date.now() < until && actAgain === null) {
      await A.pull();
      const got = pending.map((q) => A.answers(q).find((e) => e.answer !== 3)).filter(Boolean).sort((a, b) => a.t - b.t)[0];
      if (got) actAgain = got.t - faultEnd;
      else await pause(100);
    }
  }
  const waited = await Promise.race([waiting, pause(1000).then(() => ({ pending: true }))]);
  // Settle: every sequence its final answer, or 60 s.
  await waitFor('every act answered', async () => {
    await Promise.all([A.pull(), B.pull()]);
    return said.every((x) => !x.sequence || A.final(x.sequence).length > 0) && A.final(walkSeq).length > 0;
  }, 60_000, 500).catch(() => null);
  await pause(3000);
  polling = false;
  await poller;
  await Promise.all([A.pull(), B.pull()]);
  const st = await A.req({ op: 'status' }, 5000).catch(() => null);
  const seqs = [...said.filter((x) => x.sequence).map((x) => x.sequence), walkSeq];
  const finals = seqs.map((q) => ({ q, n: A.final(q).length, last: A.final(q).map((e) => ANSWER[e.answer] + (e.reason ? `:${e.reason}` : '')).join('|') }));
  const once = finals.filter((f) => f.n === 1).length, dup = finals.filter((f) => f.n > 1), lost = finals.filter((f) => f.n === 0);
  // Speech: each line A said with a receipt should be heard by B once; a line refused should not be heard.
  const speech = said.map((x) => ({ words: x.words, receipt: x.sequence ? A.final(x.sequence).some((e) => e.answer === 1) : false, heard: B.heard(x.words).length }));
  const heardTwice = speech.filter((x) => x.heard > 1), lostSpeech = speech.filter((x) => x.receipt && x.heard === 0), unanswered = speech.filter((x) => !x.receipt && x.heard > 0);
  // Silent: connected said true for more than 10 s while the network was stalled or the gateway was gone.
  const faultWindow = timeline.filter((x) => x.t >= faultAt - t0 + 10_000 && x.t <= faultEnd - t0);
  const claimed = faultWindow.filter((x) => x.connected === true).length * 250;
  const row = {
    arm, note,
    fault_s: (faultEnd - faultAt) / 1000,
    answered_once: `${once}/${seqs.length}`,
    duplicate_answers: dup.map((f) => `#${f.q} ${f.last}`),
    never_answered: lost.map((f) => `#${f.q}`),
    walk: finals.find((f) => f.q === walkSeq)?.last ?? '—',
    act_again_s: actAgain === null ? null : actAgain / 1000,
    probes,
    wait: waited,
    say_during_ms: during.map((r) => r.ok ? 'ok' : r.code),
    say_ms_most: Math.max(...said.map((x) => x.ms)),
    heard_twice: heardTwice.map((x) => x.words),
    lost_speech: lostSpeech.map((x) => x.words),
    heard_without_receipt: unanswered.map((x) => x.words),
    connected_while_down_ms: claimed,
    status_end: st ? { connected: st.connected, unanswered: st.unanswered, connects: st.connects, drops: st.drops, resumed: st.resumed, cannotResume: st.cannotResume } : null,
    answers: finals.map((f) => `#${f.q}:${f.last || 'none'}`).join(' '),
  };
  writeFileSync(join(w.dir, 'row.json'), JSON.stringify({ row, said, timeline, logA: A.log, logB: B.log }, null, 1));
  return row;
}

async function pair(arm, souls = 2) {
  const w = await world(arm, souls);
  const A = await soulOf(w, 0, 'Ann'), B = await soulOf(w, 1, 'Bea');
  await A.start(); await B.start();
  await ready(A); await ready(B);
  return { w, A, B };
}

async function stopAll(w, ss) {
  for (const s of ss) { try { process.kill(s.pid, 'SIGCONT'); } catch { /* gone */ } await s.req({ op: 'stop' }, 5000).catch(() => {}); s.proxy.close(); }
  await w.kill(w.gatewayP, 'SIGTERM'); await w.kill(w.worldP, 'SIGTERM');
}

const ARMS = {
  async gateway() {
    const { w, A, B } = await pair('gateway');
    const row = await measure('gateway', w, A, B, async ({ say }) => {
      await w.kill(w.gatewayP);
      await say('gateway during');
      await pause(1000);
      await w.gateway();
      return Date.now();
    });
    await stopAll(w, [A, B]);
    return row;
  },
  async world() {
    const { w, A, B } = await pair('world');
    const row = await measure('world', w, A, B, async ({ say }) => {
      await w.kill(w.worldP);
      await say('world during');
      await pause(1000);
      await w.serve();
      return Date.now();
    });
    await stopAll(w, [A, B]);
    return row;
  },
  async net5() { return net('net5', 5); },
  async net60() { return net('net60', 60); },
  async sleep() {
    const { w, A, B } = await pair('sleep');
    const row = await measure('sleep', w, A, B, async () => {
      A.proxy.stall();
      process.kill(A.pid, 'SIGSTOP');
      await pause(SLEEP_S * 1000);
      A.proxy.cut();
      A.proxy.pass();
      process.kill(A.pid, 'SIGCONT');
      return Date.now();
    }, { note: `${SLEEP_S} s asleep` });
    await stopAll(w, [A, B]);
    return row;
  },
  async two() {
    const { w, A, B } = await pair('two');
    const A2 = await soulOf(w, 0, 'Ann2', { home: A.home });
    await A2.start();
    const t0 = Date.now(), lines = [];
    while (Date.now() - t0 < 60_000) {
      for (const s of [A, A2]) {
        const words = `two ${s.name} ${lines.length}`;
        const r = await s.req({ op: 'say', words }, 30_000).catch((e) => ({ ok: false, code: e.code }));
        lines.push({ s, words, sequence: r.sequence, ok: r.ok });
      }
      await pause(3000);
    }
    await pause(10_000);
    await Promise.all([A.pull(), A2.pull(), B.pull()]);
    const sA = await A.req({ op: 'status' }), sA2 = await A2.req({ op: 'status' });
    const answeredOnce = lines.filter((l) => l.sequence && l.s.final(l.sequence).length === 1).length;
    const heard = lines.map((l) => B.heard(l.words).length);
    const row = {
      arm: 'two', note: 'two daemons, one Soul, 60 s',
      answered_once: `${answeredOnce}/${lines.length}`,
      never_answered: lines.filter((l) => !l.sequence || l.s.final(l.sequence).length === 0).map((l) => l.words),
      duplicate_answers: lines.filter((l) => l.sequence && l.s.final(l.sequence).length > 1).map((l) => l.words),
      heard_once: heard.filter((n) => n === 1).length, heard_twice: lines.filter((_, k) => heard[k] > 1).map((l) => l.words),
      lost_speech: lines.filter((l, k) => heard[k] === 0).map((l) => l.words),
      status_end: { A: { connected: sA.connected, connects: sA.connects, drops: sA.drops, unanswered: sA.unanswered, sequence: sA.sequence }, A2: { connected: sA2.connected, connects: sA2.connects, drops: sA2.drops, unanswered: sA2.unanswered, sequence: sA2.sequence } },
    };
    writeFileSync(join(w.dir, 'row.json'), JSON.stringify({ row, lines: lines.map(({ s, ...l }) => ({ ...l, who: s.name })), logA: A.log, logA2: A2.log, logB: B.log }, null, 1));
    await stopAll(w, [A, A2, B]);
    return row;
  },
  async slow() {
    const w = await world('slow', 10);
    const A = await soulOf(w, 0, 'Ann'), B = await soulOf(w, 1, 'Bea');
    const talkers = [];
    for (let k = 2; k < 10; k++) talkers.push(await soulOf(w, k, `T${k}`));
    for (const s of [A, B, ...talkers]) await s.start();
    for (const s of [A, B, ...talkers]) await ready(s);
    let talking = true;
    const chatter = (async () => { let k = 0; while (talking) { for (const s of talkers) s.req({ op: 'say', words: `chatter ${s.name} ${k} ${'la '.repeat(30)}` }).catch(() => {}); k++; await pause(1000); } })();
    const row = await measure('slow', w, A, B, async ({ say }) => {
      A.proxy.throttle(512);
      await pause(20_000);
      await say('slow during');
      await pause(40_000);
      A.proxy.pass();
      return Date.now();
    }, { note: '512 B/s down for 60 s, 8 talkers' });
    talking = false;
    await chatter;
    await stopAll(w, [A, B, ...talkers]);
    return row;
  },
  async herd() {
    const N = Number(process.env.FAULTS_HERD ?? 30);
    const w = await world('herd', N);
    const ss = [];
    for (let k = 0; k < N; k++) ss.push(await soulOf(w, k, `H${k}`));
    await Promise.all(ss.map((s) => s.start()));
    await Promise.all(ss.map((s) => ready(s)));
    await Promise.all([w.kill(w.gatewayP), w.kill(w.worldP)]);
    const down = Date.now();
    await pause(2000);
    await w.serve();
    await w.gateway();
    const up = Date.now();
    // Each agent asks to act at once and again every 2 s until one is answered.
    const times = await Promise.all(ss.map(async (s) => {
      const seqs = [];
      const until = Date.now() + 180_000;
      while (Date.now() < until) {
        const r = await s.req({ op: 'say', words: `herd ${s.name} ${seqs.length}` }, 30_000).catch(() => null);
        if (r?.sequence) seqs.push(r.sequence);
        const stop = Date.now() + 2000;
        while (Date.now() < stop) {
          await s.pull();
          const got = seqs.map((q) => s.final(q).find((e) => e.answer === 1)).filter(Boolean).sort((a, b) => a.t - b.t)[0];
          if (got) return { ms: got.t - up, tries: seqs.length };
          await pause(200);
        }
      }
      return { ms: null, tries: seqs.length };
    }));
    await pause(5000);
    await Promise.all(ss.map((s) => s.pull()));
    const st = await Promise.all(ss.map((s) => s.req({ op: 'status' }).catch(() => null)));
    const ms = times.filter((x) => x.ms !== null).map((x) => x.ms).sort((a, b) => a - b);
    const row = {
      arm: 'herd', note: `${N} agents; world and gateway killed together, back after 2 s`,
      back: `${ms.length}/${N}`, act_again_p50_s: ms.length ? ms[Math.floor(ms.length / 2)] / 1000 : null, act_again_max_s: ms.length ? ms.at(-1) / 1000 : null,
      tries_most: Math.max(...times.map((x) => x.tries)),
      unanswered_end: st.reduce((n, x) => n + (x?.unanswered?.length ?? 0), 0),
      cannot_resume: st.reduce((n, x) => n + (x?.cannotResume ?? 0), 0),
      down_s: (up - down) / 1000,
    };
    writeFileSync(join(w.dir, 'row.json'), JSON.stringify({ row, times }, null, 1));
    await stopAll(w, ss);
    return row;
  },
};

async function net(arm, seconds) {
  const { w, A, B } = await pair(arm);
  const row = await measure(arm, w, A, B, async ({ say }) => {
    A.proxy.stall();
    await pause(Math.min(seconds, 3) * 1000 / 2);
    await say(`${arm} during`);
    await pause(Math.max(0, seconds * 1000 - Math.min(seconds, 3) * 500));
    A.proxy.pass();
    return Date.now();
  }, { note: `network stalled ${seconds} s` });
  await stopAll(w, [A, B]);
  return row;
}

const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ARMS);
mkdirSync(ROOT, { recursive: true });
const rows = [];
const one = async (a) => {
  const t = Date.now();
  try { const r = await ARMS[a](); r.took_s = Math.round((Date.now() - t) / 1000); rows.push(r); console.log(`faults: ${a} ${JSON.stringify(r)}`); }
  catch (e) { rows.push({ arm: a, error: String(e.stack ?? e).slice(0, 1500) }); console.log(`faults: ${a} FAILED ${String(e.stack ?? e).slice(0, 1500)}`); }
};
await base();
if (process.env.FAULTS_PARALLEL === '1') await Promise.all(chosen.map(one)); else for (const a of chosen) await one(a);
writeFileSync(join(ROOT, 'faults.json'), JSON.stringify(rows, null, 1));
console.log('\n| arm | answered once | never answered | duplicate | walk | act again (s) | wait across the fault | heard twice | lost speech | connected while down (ms) | end |');
console.log('|---|---|---|---|---|---:|---|---|---|---:|---|');
for (const r of rows) {
  if (r.error) { console.log(`| ${r.arm} | ERROR ${r.error.split('\n')[0]} |||||||||`); continue; }
  console.log(`| ${r.arm} | ${r.answered_once ?? r.back} | ${(r.never_answered ?? []).join(' ')} | ${(r.duplicate_answers ?? []).join(' ')} | ${r.walk ?? ''} | ${r.act_again_s ?? r.act_again_p50_s ?? '—'} | ${r.wait ? JSON.stringify(r.wait) : ''} | ${(r.heard_twice ?? []).join('; ')} | ${(r.lost_speech ?? []).join('; ')} | ${r.connected_while_down_ms ?? ''} | ${JSON.stringify(r.status_end ?? {})} |`);
}
for (const p of procs) p.kill('SIGKILL');
process.exit(0);

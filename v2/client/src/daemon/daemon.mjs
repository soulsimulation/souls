// The resident daemon (Engine v2 R6, #2700): one process per Soul on the owner's machine. It holds the Soul's token
// and its copy's cursor, and keeps the gateway's socket (I1) open between model turns, so a harness may close
// between turns and the Soul stays current.
//
// - **Started by the first command** (`client.mjs`), detached in its own session, so it outlives the chat that
//   started it. Its token comes from credentials.json, never from an argument or an environment variable.
// - **One per Soul.** `runtime/daemon.lock` is created exclusively; a second start while the first lives is refused
//   as `daemon-already-running`, naming the Soul and the pid.
// - **Commands on a Unix socket** (`runtime/daemon.sock`), one JSON line each way. No TCP port.
//     {"op":"status"}            where it is: connected, cursor, intents sent and answered, memory
//     {"op":"act","verb":"...","target":"<scope hex>-<counter>"}  builds the next intent (the target optional) and
//                                sends it once (now, or at the next sign-in)
//     {"op":"read"}              gives and clears what happened since the last read (it never wakes the model)
//     {"op":"stop"}              ends the process
// - **Reconnects** with growing, randomised waits (from 100 ms to 5 s) and **resumes** from its cursor (R5 rule 1; the
//   gateway replays what it kept after it). Every frame is built and read by replica's WASM build (`wire*`).
// - **Each intent is sent at most once**: its sequence is written to disk before it goes out, and nothing resends
//   it. An intent sent and not answered by the next sign-in stays `unanswered` in `status`.
//
//   node v2/client/src/daemon/daemon.mjs --home <.souls> --soul <id> --pkg <replica wasm-bindgen pkg>

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atSocket, readSeat, runtimeOf } from '../home/home.mjs';
import { Table } from '../reflex/reflex.mjs';

const WAIT_FIRST = 100, WAIT_MOST = 5000;
const EVENTS_KEPT = 1000;

const arg = (name) => { const k = process.argv.indexOf(name); return k > 0 ? process.argv[k + 1] : undefined; };
const home = arg('--home'), soul = arg('--soul'), pkg = arg('--pkg');
if (!home || !soul || !pkg) {
  process.stderr.write('usage: daemon.mjs --home <.souls> --soul <id> --pkg <replica pkg>\n');
  process.exit(2);
}

const rt = runtimeOf(home, soul);
const log = (line) => appendFileSync(rt.log, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });

// --- One per Soul ---------------------------------------------------------------------------------------------
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function takeLock() {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(rt.lock, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, soul }) + '\n');
      closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = {};
      try { held = JSON.parse(readFileSync(rt.lock, 'utf8')); } catch { /* a lock being written */ }
      if (Number.isSafeInteger(held.pid) && held.pid !== process.pid && alive(held.pid)) {
        process.stderr.write(`daemon-already-running: ${soul} has a daemon, pid ${held.pid}\n`);
        process.exit(3);
      }
      rmSync(rt.lock, { force: true }); // left by a process that ended
    }
  }
  process.stderr.write(`daemon-already-running: ${soul}'s lock could not be taken\n`);
  process.exit(3);
}
takeLock();
const releaseLock = () => {
  try { if (JSON.parse(readFileSync(rt.lock, 'utf8')).pid === process.pid) rmSync(rt.lock); } catch { /* gone */ }
  rmSync(rt.socket, { force: true });
};

// --- The seat and the library -----------------------------------------------------------------------------------
let seat;
try {
  seat = readSeat(home, soul);
} catch (e) {
  log(`not started: ${e.code ?? e.message}`);
  releaseLock();
  process.exit(4);
}
const wire = await import(pathToFileURL(join(pkg, 'replica.js')).href);
wire.initSync({ module: readFileSync(join(pkg, 'replica_bg.wasm')) });
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const scope = unhex(seat.grant.scope);

// --- State on disk: the cursor and the sequences ------------------------------------------------------------------
const state = { cursor: null, sequence: 0, unanswered: [], ...(existsSync(rt.state) ? JSON.parse(readFileSync(rt.state, 'utf8')) : {}) };
const save = () => { writeFileSync(`${rt.state}.tmp`, JSON.stringify(state) + '\n', { mode: 0o600 }); renameSync(`${rt.state}.tmp`, rt.state); };
const queued = []; // intents made while no socket was signed in, not yet sent
const events = []; // what happened since the last read
const counts = { sent: 0, answered: 0, connects: 0, resumed: 0, cannotResume: 0, drops: 0, build: null };
const reflexes = new Table(soul); // R9: onEvent(event, now) per named event once frames carry them
const note = (e) => { events.push(e); if (events.length > EVENTS_KEPT) events.shift(); };

// --- The socket to the gateway ------------------------------------------------------------------------------------
let ws = null, signedIn = false, attempt = 0, stopping = false, since = Date.now();

function send(bytes, sequence) {
  // Written down before it goes, so neither a drop nor a restart sends it again.
  state.unanswered.push(sequence);
  save();
  counts.sent++;
  ws.send(bytes);
}

function connect() {
  counts.connects++;
  let step = 'hello';
  const sock = new WebSocket(seat.gateway);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => sock.send(wire.wireHello());
  sock.onmessage = (m) => {
    const bytes = new Uint8Array(m.data);
    try {
      if (step === 'hello') {
        counts.build = wire.wireWorldBuild(bytes);
        sock.send(wire.wireSignIn(seat.token, state.cursor ? unhex(state.cursor) : new Uint8Array()));
        step = 'outcome';
        return;
      }
      const [kind, a, b] = wire.wireFrame(bytes).split(' ');
      if (kind === 'outcome') {
        if (a === 'token.refused') { log('token.refused'); note({ kind: 'token-refused' }); attempt = 99; sock.close(); return; }
        if (a === 'stream.resumed') counts.resumed++;
        if (a === 'stream.cannot-resume') counts.cannotResume++;
        log(`signed in: ${a}`);
        step = 'stream';
        signedIn = true;
        attempt = 0;
        while (queued.length > 0 && signedIn) { const q = queued.shift(); send(q.bytes, q.sequence); }
        return;
      }
      if (b !== '-') state.cursor = b;
      if (a !== '-') {
        const s = Number(a);
        const k = state.unanswered.indexOf(s);
        if (k >= 0) { state.unanswered.splice(k, 1); counts.answered++; }
      }
      save();
      note({ kind: 'answer', sequence: a === '-' ? null : Number(a), version: b === '-' ? null : b });
    } catch (e) {
      log(`frame refused: ${String(e.message ?? e).slice(0, 200)}`);
    }
  };
  sock.onclose = (ev) => {
    if (ws === sock) { ws = null; signedIn = false; }
    if (stopping) return;
    counts.drops++;
    const most = Math.min(WAIT_MOST, WAIT_FIRST * 2 ** Math.min(attempt, 10));
    const wait = Math.round(most / 2 + Math.random() * most / 2);
    attempt++;
    log(`socket closed (${ev.code}${step === 'stream' ? '' : `, at ${step}`}); again in ${wait} ms`);
    setTimeout(connect, wait);
  };
  sock.onerror = () => { /* onclose follows */ };
}

// --- Commands on the Unix socket --------------------------------------------------------------------------------
function answer(req) {
  switch (req.op) {
    case 'status': {
      const { rss, heapUsed } = process.memoryUsage();
      return {
        ok: true, soul, pid: process.pid, world: seat.world, connected: signedIn, cursor: state.cursor,
        sequence: state.sequence, unanswered: state.unanswered, queued: queued.length, ...counts,
        rssBytes: rss, heapBytes: heapUsed, upMs: Date.now() - since,
      };
    }
    case 'act': {
      state.sequence++;
      const bytes = wire.wireIntent(scope, seat.grant.counter, String(req.verb ?? ''), BigInt(state.sequence),
        state.cursor ? unhex(state.cursor) : new Uint8Array(), BigInt(req.expiry ?? Number.MAX_SAFE_INTEGER), String(req.target ?? ''));
      save();
      if (signedIn) send(bytes, state.sequence); else queued.push({ bytes, sequence: state.sequence });
      return { ok: true, sequence: state.sequence, sent: signedIn };
    }
    case 'read': return { ok: true, events: events.splice(0) };
    case 'reflex': return reflexes.op(req, Date.now());
    case 'stop': setImmediate(stop); return { ok: true };
    default: return { ok: false, code: 'unknown-op' };
  }
}

const server = createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    for (let k; (k = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      let out;
      try { out = answer(JSON.parse(line)); } catch (e) { out = { ok: false, code: e.code ?? 'refused', detail: String(e.message ?? e).slice(0, 200) }; }
      const changed = reflexes.changed();
      if (changed.length) out.changed = changed;
      c.write(JSON.stringify(out) + '\n');
    }
  });
  c.on('error', () => {});
});

function stop() {
  stopping = true;
  log('stopping');
  ws?.close();
  server.close();
  releaseLock();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', () => {}); // the terminal that started it closing is not a reason to stop

server.on('error', (e) => {
  log(`not started: the command socket: ${e.code ?? e.message}`);
  releaseLock();
  process.exit(5);
});
rmSync(rt.socket, { force: true });
atSocket(rt.socket, (path) => server.listen(path, () => log(`listening for ${soul}, pid ${process.pid}`)));
connect();

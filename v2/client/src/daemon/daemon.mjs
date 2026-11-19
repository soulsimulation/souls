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
//   and R7's (#2701), each answer ending with `at` (the copy's version) and `changed` (what changed since the answer
//   before, by name, capped, the rest counted), the copy brought current first:
//     {"op":"look"}                       the brief (`../brief/brief.mjs`)
//     {"op":"find","words":"..."}         one search over the copy (`../find/find.mjs`)
//     {"op":"act","verbs":["a","b"]}      a ranked list: the first is the act, the rest its fallbacks, each on `target`
//     {"op":"wait","seconds":30}          returns when something addressed to this Soul happened, or at the timeout
//   and R10's (#2702): every answer carries `age`, and `gap` and `stale` while its copy is not known current, or
//   `asleep` when its world has written nothing for a while (`age.mjs`); each command, send and answer goes into the
//   local trace (`../stats/trace.mjs`), which nothing sends anywhere:
//     {"op":"stats"}                      per achieved intent: commands, bytes printed, first-send result by cause
//   and R13's (#2753), wake rules on R9's events within the owner's budget (`../wake/wake.mjs`), and the owner's
//   messages from the mailbox, which reach `wait` as `mail` events whatever the budget:
//     {"op":"wake","do":"add|remove|budget|list",...}   the wake rules; `wait` hands the queued wakes as `wakes`
//     {"op":"act",...,"for":"<message id>"}           this act serves that message: its outcome closes it
//     {"op":"event","event":{...}}                    an event as R9's matcher takes it, until frames carry them
//   and R8's (#2703), checking with R2's form rules on the copy (`../check/`), kind entries from `<home>/kinds/`:
//     {"op":"can","intent":{"verb":"..","this":"<id>","form":".."}}   yes, no with the reason, or unknown, and `current`
//     {"op":"act","verbs":[{"verb":"..","this":"<id>","form":".."}, "..."]}   each candidate with a form is checked
//       again at send time on a copy brought current; a current `no` drops it; none left is `stopped-locally`, with
//       what changed, and nothing is sent. Unknown, a bare verb or a copy not current never stops a send. The
//       intent's basis is the version the model was last shown, not the send-time version.
// - **Reconnects** with growing, randomised waits (from 100 ms to 5 s) and **resumes** from its cursor (R5 rule 1; the
//   gateway replays what it kept after it). A socket not signed in within 5 s is given up and another started. Every frame is built and read by replica's WASM build (`wire*`).
// - **Holds a copy of its scope** (R5's `sync::Copy`, in WASM memory). On a fresh stream, when the gateway answers
//   `stream.cannot-resume`, or when it holds nothing yet, it compares and descends through the gateway (R5b, #3164),
//   one request at a time, then takes the hashes' version as its cursor and carries on with the stream. It counts as
//   connected, and sends intents, only once its copy is current.
// - **Each intent is sent at most once**: its sequence is written to disk before it goes out, and nothing resends
//   it. An intent sent and not answered by the next sign-in stays `unanswered` in `status`.
//
//   node v2/client/src/daemon/daemon.mjs --home <.souls> --soul <id> --pkg <replica wasm-bindgen pkg>

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atSocket, readSeat, runtimeOf } from '../home/home.mjs';
import { brief, changedBlock } from '../brief/brief.mjs';
import { changedBetween, rowsOf, sequenceOf } from '../brief/copy.mjs';
import { find } from '../find/find.mjs';
import { achievedOf, causeOf, openTrace } from '../stats/trace.mjs';
import { stats, transcriptOf } from '../stats/stats.mjs';
import { ageOf } from './age.mjs';
import { CURRENT_MS, candidateOf, canOf, isCurrent, judge, sift } from '../check/check.mjs';
import { kindsIn, stateOf } from '../check/state.mjs';
import { Table } from '../reflex/reflex.mjs';
import { Wakes } from '../wake/wake.mjs';

const WAIT_FIRST = 100, WAIT_MOST = 5000;
// A socket not signed in by then is given up and another started: one whose upgrade answer was lost can otherwise
// stay connecting for good, firing neither open nor close (seen with Node 22's WebSocket).
const SIGN_IN_WITHIN = 5000;
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
const wakes = new Wakes(soul); // R13: its budget's deliveries are kept on disk, so a restart never resets them
if (state.wake) Object.assign(wakes, { budget: state.wake.budget, delivered: state.wake.delivered });
const saveWakes = () => { state.wake = { budget: wakes.budget, delivered: wakes.delivered }; save(); };
const mail = new Map(); // R13: the owner's open messages given to this daemon, by id
const serving = new Map(); // sequence → the message its act serves
const closes = []; // closes not yet sent, for the next sign-in
const copy = new wire.Copy(); // its scope, by hash (R5b)
const SYNC_WITHIN = 10_000, SYNCS_KEPT = 8;
const syncs = []; // the last syncs: kind, time and R5's counts
let syncing = null, asked = 0; // the sync under way: its request's number, step, kind and start
let wakers = []; // `wait`s waiting for something addressed to this Soul
const note = (e) => {
  events.push(e);
  if (events.length > EVENTS_KEPT) events.shift();
  if (e.kind !== 'synced') for (const w of wakers.splice(0)) w();
};
let copyVersion = null, shown = new Map(); // the copy's version, and the rows the last answer saw
let shownVersion = null; // the version the last answer showed the model: an intent's basis (R8)
let stopped = 0; // acts stopped locally, for the trace
// R10: on the steady clock, when the copy was last confirmed current, when its version last changed, and since when
// (and why) it has not been known current; null while it is.
const startedAt = performance.now();
let confirmedAt = null, changedAt = null, cutAt = startedAt, cutWhy = 'not-connected';
const trace = openTrace(rt.dir);
const rankedOf = new Map(); // sequence → how many verbs it ranked, until answered

// --- The socket to the gateway ------------------------------------------------------------------------------------
let ws = null, signedIn = false, attempt = 0, stopping = false, since = Date.now();

function send(bytes, sequence, ranked) {
  // Written down before it goes, so neither a drop nor a restart sends it again.
  state.unanswered.push(sequence);
  save();
  counts.sent++;
  rankedOf.set(sequence, ranked);
  trace.write({ k: 'send', seq: sequence, ranked });
  ws.send(bytes);
}

/** Signed in and current: intents go now. */
function current() {
  signedIn = true;
  attempt = 0;
  while (closes.length > 0 && signedIn) ws.send(closes.shift());
  while (queued.length > 0 && signedIn) { const q = queued.shift(); send(q.bytes, q.sequence, q.ranked); }
}

/** R13: a text frame, the mailbox's: a message for this Soul, noted once. */
function onText(text) {
  let m;
  try { m = JSON.parse(text).mail; } catch { return; }
  if (!m || typeof m.id !== 'string' || mail.has(m.id)) return;
  mail.set(m.id, m);
  log(`message ${m.id}`); // never its words
  note({ kind: 'mail', id: m.id, text: String(m.text), at: m.at });
}

/** R13: the message `id` closed with its act's outcome, now or at the next sign-in. */
function closeMail(id, state, outcome) {
  const line = JSON.stringify({ close: { id, state, outcome } });
  mail.delete(id);
  log(`message ${id} closed ${state} (${outcome})`);
  if (ws && signedIn) ws.send(line); else closes.push(line);
}

/** Compare and descend through the gateway (R5b): the scope's hashes, then the records not held, level by level. */
function startSync(sock, kind) {
  syncing = { n: ++asked, step: 'hashes', kind, t0: performance.now(), version: null, waiters: [] };
  if (cutAt !== null) cutWhy = 'syncing';
  syncing.timer = setTimeout(() => { log('sync: no answer; reconnecting'); sock.close(); }, SYNC_WITHIN);
  sock.send(wire.wireSyncScope(BigInt(syncing.n)));
}

function syncAnswer(sock, n, refused, bytes) {
  if (!syncing || n !== syncing.n) return; // an answer to a request since given up
  if (refused !== '-') throw new Error(`sync refused: ${refused}`);
  if (syncing.step === 'hashes') syncing.version = copy.onHashes(bytes);
  else copy.onRecords(bytes);
  syncing.n = ++asked;
  const next = copy.next(BigInt(syncing.n));
  if (next.length > 0) { syncing.step = 'records'; sock.send(next); return; }
  const done = { kind: syncing.kind, ms: Math.round(performance.now() - syncing.t0), ...JSON.parse(copy.finish()) };
  clearTimeout(syncing.timer);
  const t = performance.now();
  if (syncing.version !== copyVersion) changedAt = t;
  copyVersion = syncing.version;
  confirmedAt = t;
  cutAt = null;
  const { waiters } = syncing;
  syncing = null;
  for (const w of waiters) w(true);
  // A refresh (R7) brings the copy current for an answer; the stream's cursor stays the last frame it was given.
  if (done.kind === 'refresh') return;
  state.cursor = copyVersion; // the stream carries on from the version the hashes are at
  save();
  syncs.push(done);
  if (syncs.length > SYNCS_KEPT) syncs.shift();
  log(`synced (${done.kind}): ${done.fetched} of ${done.held} records in ${done.rounds} rounds, ${done.got} B, ${done.ms} ms`);
  note({ ...done, kind: 'synced', sync: done.kind }); // its own kind would read as news and end a wait at once
  current();
}

function connect() {
  counts.connects++;
  let step = 'hello', ended = false;
  const sock = new WebSocket(seat.gateway);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  const deadline = setTimeout(() => {
    log(`not signed in within ${SIGN_IN_WITHIN} ms (at ${step}, state ${sock.readyState}); giving it up`);
    closed(1006);
    try { sock.close(); } catch { /* a socket still connecting may refuse to close; it is ignored from here */ }
  }, SIGN_IN_WITHIN);
  sock.onopen = () => { if (ended) sock.close(); else sock.send(wire.wireHello()); };
  sock.onmessage = (m) => {
    if (ended) { sock.close(); return; } // given up: it must not sign in and take the grant from its successor
    if (typeof m.data === 'string') { onText(m.data); return; }
    const bytes = new Uint8Array(m.data);
    try {
      if (step === 'hello') {
        counts.build = wire.wireWorldBuild(bytes);
        sock.send(wire.wireSignIn(seat.token, state.cursor ? unhex(state.cursor) : new Uint8Array()));
        step = 'outcome';
        return;
      }
      const [kind, a, b, c, d] = wire.wireFrame(bytes).split(' ');
      if (kind === 'outcome') {
        if (a === 'token.refused') { log('token.refused'); note({ kind: 'token-refused' }); attempt = 99; sock.close(); return; }
        if (a === 'stream.resumed') counts.resumed++;
        if (a === 'stream.cannot-resume') counts.cannotResume++;
        log(`signed in: ${a}`);
        step = 'stream';
        clearTimeout(deadline);
        if (a === 'stream.resumed' && !copy.empty()) current();
        else startSync(sock, a === 'stream.cannot-resume' ? 'resync' : 'snapshot');
        return;
      }
      if (kind === 'sync') { syncAnswer(sock, Number(a), b, bytes); return; }
      if (b !== '-') state.cursor = b;
      if (a !== '-') {
        const s = Number(a);
        const k = state.unanswered.indexOf(s);
        if (k >= 0) { state.unanswered.splice(k, 1); counts.answered++; }
        trace.write({ k: 'answer', seq: s, cause: causeOf(Number(c), d, rankedOf.get(s)), achieved: achievedOf(Number(c), d) });
        if (Number(c) !== 3) rankedOf.delete(s); // an accepted move is resolved later
        if (serving.has(s) && Number(c) !== 3) {
          closeMail(serving.get(s), achievedOf(Number(c), d) ? 'done' : 'failed', d !== '-' ? d : ['', 'receipt', 'refused', '', 'resolved', 'unread'][Number(c)] || 'answered');
          serving.delete(s);
        }
      }
      save();
      note({ kind: 'answer', sequence: a === '-' ? null : Number(a), version: b === '-' ? null : b });
    } catch (e) {
      log(`frame refused: ${String(e.message ?? e).slice(0, 200)}`);
      if (syncing) { note({ kind: 'sync-refused', reason: String(e.message ?? e).slice(0, 200) }); sock.close(); }
    }
  };
  sock.onclose = (ev) => closed(ev.code);
  /** This socket is done with, once: by its close, or given up first. */
  function closed(code) {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    if (ws === sock) {
      ws = null; signedIn = false;
      cutAt ??= performance.now();
      cutWhy = 'not-connected';
      if (syncing) { clearTimeout(syncing.timer); for (const w of syncing.waiters) w(false); syncing = null; }
    }
    if (stopping) return;
    counts.drops++;
    const most = Math.min(WAIT_MOST, WAIT_FIRST * 2 ** Math.min(attempt, 10));
    const wait = Math.round(most / 2 + Math.random() * most / 2);
    attempt++;
    log(`socket closed (${code}${step === 'stream' ? '' : `, at ${step}`}); again in ${wait} ms`);
    setTimeout(connect, wait);
  }
  sock.onerror = () => { /* onclose follows */ };
}

// --- Commands on the Unix socket --------------------------------------------------------------------------------
/** The copy brought current through the gateway (a sync under way is waited for); false if it could not be. */
function refresh() {
  if (syncing) return new Promise((ok) => syncing.waiters.push(ok));
  if (!ws || !signedIn) return Promise.resolve(false);
  startSync(ws, 'refresh');
  return new Promise((ok) => syncing.waiters.push(ok));
}

/**
 * Ends an answer with the copy's version and what changed since the answer before, the copy brought current first
 * unless `now` (an act answers at once, from the copy as it is).
 */
async function closing(out, f, { now = false, age = null } = {}) {
  age ??= await ageAfter({ now });
  const rows = rowsOf(copy), changes = changedBetween(shown, rows);
  shown = rows;
  shownVersion = copyVersion;
  return { ...out, ...(f ? f(rows, changes) : {}), at: sequenceOf(copyVersion), ...age, changed: changedBlock(changes) };
}

/** The copy brought current unless `now`, and its age fields (R10). */
async function ageAfter({ now = false } = {}) {
  // A gateway that does not answer leaves the copy as it is, and the answer says it is stale, since when and why.
  const asking = performance.now();
  const current = now ? signedIn && !syncing : await Promise.race([refresh(), new Promise((ok) => setTimeout(ok, REFRESH_WITHIN, false))]);
  if (!now && !current && cutAt === null) { cutAt = asking; cutWhy = signedIn ? 'no-answer' : 'not-connected'; }
  const age = ageOf({ now: performance.now(), startedAt, confirmedAt, changedAt, cutAt, why: cutWhy, asked: !now });
  return !current && !age.gap ? { ...age, stale: true, gap: { ms: 0, why: signedIn ? 'syncing' : 'not-connected' } } : age;
}

/** R2's verdict on each candidate, on the copy as it is now (R8). */
function verdicts(candidates) {
  const kinds = kindsIn(join(home, 'kinds')), state = stateOf(copy, kinds, ME);
  return candidates.map((c) => judge(wire.rules_decide, c, { kinds, state, asker: { sees: [] } }));
}

/** The age fields of an answer that does not ask the gateway first (status, read, stats, stop, a refusal). */
const ageNow = () => ageOf({ now: performance.now(), startedAt, confirmedAt, changedAt, cutAt, why: cutWhy, asked: false });

const ME = `${seat.grant.scope}-${seat.grant.counter}`;
const ACT_MOST = 5, WAIT_MOST_S = 600, REFRESH_WITHIN = 2000;

const OPS = new Set(['status', 'look', 'find', 'wait', 'can', 'act', 'read', 'stats', 'reflex', 'wake', 'event', 'stop']);
const nothingYet = () => !events.some((e) => e.kind !== 'synced');

async function answer(req) {
  // R13: a command from the model's turn shows that what a reader was handed was taken.
  if (!['wait', 'status'].includes(req.op)) wakes.confirm();
  switch (req.op) {
    case 'status': {
      const { rss, heapUsed } = process.memoryUsage();
      return {
        ok: true, soul, pid: process.pid, world: seat.world, connected: signedIn, cursor: state.cursor,
        sequence: state.sequence, unanswered: state.unanswered, queued: queued.length, ...counts,
        syncing: syncing !== null, syncs, roots: JSON.parse(copy.roots()),
        rssBytes: rss, heapBytes: heapUsed, upMs: Date.now() - since,
      };
    }
    case 'look': return closing({ ok: true }, (rows, changes) => {
      const b = brief(rows, { me: ME, changes, ageMs: performance.now() - (confirmedAt ?? startedAt) });
      delete b.changed; // the answer's own closes it
      return b;
    });
    case 'find': return closing({ ok: true }, (rows) => find(rows.values(), req.words, { limit: Math.min(Number(req.limit ?? 8), 50) }));
    case 'wait': {
      const ms = Math.min(Math.max(Number(req.seconds ?? 30), 0), WAIT_MOST_S) * 1000, until = Date.now() + ms;
      // R13: the queued wakes are handed as one delivery when the budget allows; over it, they wait for it to.
      let handed = wakes.deliver(Date.now());
      while (handed.length === 0 && nothingYet() && Date.now() < until) {
        const free = wakes.nextFree(Date.now());
        const left = Math.min(until, free ?? until) - Date.now();
        await new Promise((ok) => { const t = setTimeout(ok, Math.max(left, 0)); wakers.push(() => { clearTimeout(t); ok(); }); });
        handed = wakes.deliver(Date.now());
      }
      if (handed.length) saveWakes();
      const got = events.splice(0);
      const timedOut = handed.length === 0 && !got.some((e) => e.kind !== 'synced');
      return closing({ ok: true, events: got, ...(handed.length ? { wakes: handed } : {}), ...(timedOut ? { timedOut: true } : {}) });
    }
    case 'can': {
      const c = candidateOf(req.intent);
      const age = await ageAfter();
      const [v] = verdicts([c]);
      return closing({ ok: true, ...canOf(v, isCurrent(age, CURRENT_MS)) }, null, { age });
    }
    case 'act': {
      if (req.for !== undefined && !mail.has(req.for)) return { ok: false, code: 'mail-not-found', detail: 'for names an open message this daemon was given' };
      const candidates = (Array.isArray(req.verbs) ? req.verbs : [req.verb]).map(candidateOf);
      if (candidates.length === 0 || candidates.length > ACT_MOST || candidates.some((c) => !c.verb || /\s/.test(c.verb))) {
        return { ok: false, code: 'act-ranked-list', detail: `one to ${ACT_MOST} verbs, best first` };
      }
      // The basis is what the model was shown (R8), taken before this act's own check brings the copy current.
      const basis = shownVersion ?? state.cursor;
      let age = null, keep = candidates, dropped = [];
      if (candidates.some((c) => c.form)) {
        age = await ageAfter();
        const current = isCurrent(age, CURRENT_MS);
        ({ keep, dropped } = sift(candidates, current ? verdicts(candidates) : [], current));
      }
      if (keep.length === 0) {
        trace.write({ k: 'send', seq: `local-${++stopped}`, ranked: candidates.length, cause: 'stopped-locally' });
        return closing({ ok: false, code: 'stopped-locally', sent: false, dropped, basis: sequenceOf(basis) }, null, { age });
      }
      const ranked = keep.map((c) => c.verb);
      state.sequence++;
      const bytes = wire.wireIntent(scope, seat.grant.counter, ranked.join(' '), BigInt(state.sequence),
        basis ? unhex(basis) : new Uint8Array(), BigInt(req.expiry ?? Number.MAX_SAFE_INTEGER), String(req.target ?? ''));
      save();
      const sequence = state.sequence, sent = signedIn;
      if (req.for !== undefined) serving.set(sequence, req.for);
      if (signedIn) send(bytes, sequence, ranked.length); else queued.push({ bytes, sequence, ranked: ranked.length });
      const out = { ok: true, sequence, sent, basis: sequenceOf(basis), ...(age ? { checked: isCurrent(age, CURRENT_MS) } : {}), ...(dropped.length ? { dropped } : {}) };
      return closing(out, null, age ? { age } : { now: true });
    }
    case 'read': return { ok: true, events: events.splice(0) };
    case 'stats': return stats(trace.read(), { transcript: transcriptOf(home) });
    case 'reflex': return reflexes.op(req, Date.now());
    case 'wake': { const out = wakes.op(req, Date.now()); if (req.do === 'budget') saveWakes(); return out; }
    case 'event': {
      const e = req.event;
      if (!e || typeof e.name !== 'string') return { ok: false, code: 'event-not-an-event', detail: 'an event has a name' };
      const fired = wakes.onEvent(e, Date.now());
      if (fired) for (const w of wakers.splice(0)) w();
      return { ok: true, fired };
    }
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
      let op = 'unread';
      Promise.resolve().then(() => { const req = JSON.parse(line); op = OPS.has(req.op) ? req.op : 'unknown'; return answer(req); })
        .catch((e) => ({ ok: false, code: e.code ?? 'refused', detail: String(e.message ?? e).slice(0, 200) }))
        .then((out) => {
          // R9: the reflexes that fired since the answer before, in this one's `changed`.
          const fired = reflexes.changed();
          if (fired.length) out.changed = { ...(out.changed ?? {}), reflexes: fired };
          // Every answer carries its age (R10); each but stats's is traced with the bytes it prints.
          const said = JSON.stringify('age' in out ? out : { ...out, ...ageNow() }) + '\n';
          if (op !== 'stats') trace.write({ k: 'cmd', op, bytes: Buffer.byteLength(said) });
          if (!c.destroyed) c.write(said);
        });
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

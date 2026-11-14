// #1929: wake rules. One pure function over what serve stores, unit-tested on recorded state; the rules, their last match and
// firing, the engine's cursor and the queue live in serve's state file, through the real CLI and a real serve on a stand-in world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACT_ENDED_GRACE_MS, AWAY_MS, BUDGETS, EVERY_MIN, HELD_MS, SPEAKER_MS, awaySince, awayText, back, budgetView, change, confirm, deliver, enqueue, evaluate, expire, fresh, parseAway, parseBudget, parseRule, saw, speechDue, spokeNow, view, wentAway } from './soul/wake.mjs';
import { FOLLOW_MAX, HEARTBEAT_EVERY_MIN, foldAddressed, foldHeard, followLine, loadServeState, pendingNotes } from './soul/eden.mjs';
import { indexCatalog } from './soul/catalog.mjs';

const T0 = 1_800_000_000_000;
/** serve's state as it stands after a first look: the engine's cursor at the end of everything. */
function serveState(extra = {}) {
  const st = { events: [{ id: 'c_1', kind: 'arrival' }], receipts: {}, plan: null, planEnded: [], messages: [], addressed: [], addressedSeq: 0, live: null, me: 's_me', ...extra };
  return st;
}
/** Run the rules once to take the cursor, then apply `then` to the state and run them again at `at`. */
function step(rules, st, at) { const r = evaluate(rules, st, at); st.wake = { ...st.wake, cursor: r.cursor }; return r; }
const ruleOf = (r, id) => r.rules.find((x) => x.id === id);
const pic = (rows) => ({ souls: rows.map(([id, place, name]) => ({ id, name: name ?? id, place })) });

test('A3: owner-message and speech-to-me are always on and fire once for each new message and line', () => {
  const st = serveState(), rules = fresh().rules;
  assert.deepEqual(step(rules, st, T0).fired, [], 'a first look starts from now: nothing that was already there wakes');
  st.messages.push({ id: 'msg_1', text: 'meet Mira', seenAt: T0 + 1, acked: false });
  st.addressed.push({ seq: 1, id: 'sp_1', from: 'Bo', soulId: 's_bo', text: 'hi', heard: false }); st.addressedSeq = 1;
  const r = step(rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.kind]), [['owner-message', 'owner-message'], ['speech-to-me', 'speech-to-me']]);
  assert.match(r.fired[0].why, /msg_1/); assert.equal(r.fired[1].why, 'Bo spoke to you');
  assert.deepEqual(step(r.rules, st, T0 + 4_000).fired, [], 'the same message and line do not wake twice');
  assert.throws(() => parseRule(['owner-message']), /always on/);
  assert.equal(change(fresh(), { remove: 'speech-to-me' }).error, 'speech-to-me is always on');
});

test('A3: the stopped-plan wake is kept: once per stop', () => {
  const plan = { id: 'p_1', state: 'running', at: 1, steps: [{ id: 'walk:mill', state: 'done', receipt: 'r_1' }, { id: 'sit:bench', state: 'pending' }] };
  const st = serveState({ plan }), rules = fresh().rules;
  step(rules, st, T0);
  Object.assign(plan, { state: 'stopped', stoppedAt: T0 + 1 }); plan.steps[1] = { ...plan.steps[1], state: 'refused', why: { code: 'seat.taken' } };
  const r = step(rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why]), [['plan-stopped', 'plan step 2 refused (seat.taken)']]);
  assert.deepEqual(step(r.rules, st, T0 + 4_000).fired, []);
});

test('A3: act-ended wakes for the agent\'s own body act that ended unwatched, after the grace, and for nothing else', () => {
  const st = serveState(), rules = fresh().rules;
  step(rules, st, T0);
  st.receipts = {
    r_mine: { id: 'r_mine', capability: 'walk:mill', phase: 'completed', mine: true, read: false },
    r_waited: { id: 'r_waited', capability: 'walk:pond', phase: 'completed', mine: true, waited: true, read: false },
    r_plan: { id: 'r_plan', capability: 'sit:bench', phase: 'refused', mine: true, read: false },
    r_reflex: { id: 'r_reflex', capability: 'face:s_bo', phase: 'completed', read: false },
    r_open: { id: 'r_open', capability: 'dance:here', phase: 'started', mine: true, read: false },
  };
  st.plan = { id: 'p_1', state: 'running', at: 0, steps: [{ id: 'sit:bench', state: 'running', receipt: 'r_plan' }] };
  for (const id of ['r_mine', 'r_waited', 'r_plan', 'r_reflex']) st.events.push({ id: `c_${st.events.length + 1}`, kind: 'receipt', receipt: { id, phase: st.receipts[id].phase } });
  st.events.push({ id: 'c_9', kind: 'receipt', receipt: { id: 'r_open', phase: 'started' } });
  let r = step(rules, st, T0 + 100);
  assert.deepEqual(r.fired, [], 'an end waits out the grace: an act --wait that saw it reads the receipt within it');
  assert.deepEqual(ruleOf(r, 'act-ended').held.map((h) => h.id), ['r_mine', 'r_reflex'], 'held whoever sent it: an answer can still mark it mine');
  r = step(r.rules, st, T0 + 100 + ACT_ENDED_GRACE_MS);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why]), [['act-ended', 'walk:mill completed']]);
  st.events.push({ id: 'c_10', kind: 'receipt', receipt: { id: 'r_mine', phase: 'completed' } });
  assert.deepEqual(step(r.rules, st, T0 + 10_000).fired, [], 'one end wakes once');

  // an act --wait read it inside the grace: no wake; a refused act wakes as an ended one does
  st.receipts.r_seen = { id: 'r_seen', capability: 'walk:hall', phase: 'completed', mine: true, read: false };
  st.receipts.r_ref = { id: 'r_ref', capability: 'open:gate', phase: 'refused', reason: 'locked', mine: true, read: false };
  st.events.push({ id: 'c_11', kind: 'receipt', receipt: { id: 'r_seen', phase: 'completed' } }, { id: 'c_12', kind: 'receipt', receipt: { id: 'r_ref', phase: 'refused' } });
  r = step(r.rules, st, T0 + 20_000);
  st.receipts.r_seen.waited = true;
  r = step(r.rules, st, T0 + 20_000 + ACT_ENDED_GRACE_MS);
  assert.deepEqual(r.fired.map((f) => f.why), ['open:gate refused: locked']);
  assert.equal(change(fresh(), { remove: 'act-ended' }).removed, 'act-ended', 'on by default, and the owner can take it off');
});

test('#2054: act-ended wakes once whether the act\'s answer or the stream\'s end comes first', () => {
  for (const order of ['answer first', 'end first']) {
    const st = serveState(), rules = fresh().rules;
    let r = step(rules, st, T0);
    const answer = () => { st.receipts.r_go = { ...st.receipts.r_go, id: 'r_go', capability: 'walk:mill', mine: true, read: false }; };
    const end = () => { st.receipts.r_go = { ...st.receipts.r_go, id: 'r_go', capability: 'walk:mill', phase: 'completed', read: false }; st.events.push({ id: 'c_2', kind: 'receipt', receipt: { id: 'r_go', phase: 'completed' } }); };
    if (order === 'answer first') { answer(); st.receipts.r_go.phase = 'started'; r = step(r.rules, st, T0 + 100); end(); }
    else end();
    r = step(r.rules, st, T0 + 200);
    if (order === 'end first') answer();
    const woke = [];
    for (const at of [T0 + 300, T0 + 200 + ACT_ENDED_GRACE_MS, T0 + 10_000]) { r = step(r.rules, st, at); woke.push(...r.fired); }
    assert.deepEqual(woke.map((f) => [f.id, f.why]), [['act-ended', 'walk:mill completed']], order);
  }
});

test('A3, A4: soul-arrives fires when the Soul arrives, and again only after it has left', () => {
  const st = serveState({ live: pic([['s_me', 'g-yard'], ['s_ivo', 'g-yard']]) });
  const rules = [...fresh().rules, { id: 'w1', ...parseRule(['soul-arrives', '{"who":"s_mira","where":"here"}', '--every', '0']) }, { id: 'w2', ...parseRule(['soul-arrives', '{"where":"g-mill"}', '--every', '0']) }];
  let r = step(rules, st, T0);
  assert.deepEqual(r.fired, [], 'who is already there is a state, not a change');
  st.live = pic([['s_me', 'g-yard'], ['s_ivo', 'g-yard'], ['s_mira', 'g-yard', 'Mira']]);
  r = step(r.rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why]), [['w1', 'Mira arrived at g-yard']]);
  r = step(r.rules, st, T0 + 4_000);
  assert.deepEqual(r.fired, [], 'still there: no second wake');
  st.live = pic([['s_me', 'g-yard'], ['s_mira', 'g-mill', 'Mira']]);
  r = step(r.rules, st, T0 + 6_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why]), [['w2', 'Mira arrived at g-mill']], 'w1 sees Mira leave; any Soul arriving at a named place wakes w2');
  st.live = pic([['s_me', 'g-yard'], ['s_mira', 'g-yard', 'Mira']]);
  r = step(r.rules, st, T0 + 8_000);
  assert.deepEqual(r.fired.map((f) => f.id), ['w1'], 'back after leaving: it fires again');
  st.live = null;
  assert.deepEqual(ruleOf(step(r.rules, st, T0 + 10_000), 'w1').inside, ['s_mira'], 'no live copy: nothing changes, nobody left');
});

test('A3, A4: place-busy fires when the count crosses atLeast, and again only after it drops below', () => {
  const st = serveState({ live: pic([['s_me', 'g-hall'], ['s_a', 'g-hall']]) });
  const rules = [{ id: 'w1', ...parseRule(['place-busy', '{"place":"g-hall","atLeast":2}', '--every', '0']) }];
  let r = step(rules, st, T0);
  st.live = pic([['s_me', 'g-hall'], ['s_a', 'g-hall'], ['s_b', 'g-hall']]);
  r = step(r.rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => f.why), ['2 Souls at g-hall'], 'other Souls are counted, not this one');
  st.live = pic([['s_me', 'g-hall'], ['s_a', 'g-hall'], ['s_b', 'g-hall'], ['s_c', 'g-hall']]);
  assert.deepEqual((r = step(r.rules, st, T0 + 4_000)).fired, [], 'busier still is not a new crossing');
  st.live = pic([['s_me', 'g-hall'], ['s_a', 'g-hall']]);
  r = step(r.rules, st, T0 + 6_000);
  st.live = pic([['s_a', 'g-hall'], ['s_b', 'g-hall']]);
  assert.deepEqual(step(r.rules, st, T0 + 8_000).fired.map((f) => f.id), ['w1'], 'after dropping below: it fires again');
  assert.throws(() => parseRule(['place-busy', '{"place":"g-hall"}']), /atLeast/);
});

test('A5: a rule fires at most once per --every window (default 300 s), queued as {id, kind, why, at}', () => {
  assert.equal(parseRule(['soul-arrives']).every, 300);
  const st = serveState({ live: pic([['s_me', 'g-yard']]) });
  let r = step([{ id: 'w1', ...parseRule(['soul-arrives']) }], st, T0);
  const come = (rows, at) => { st.live = pic([['s_me', 'g-yard'], ...rows]); r = step(r.rules, st, at); return r.fired; };
  const f = come([['s_a', 'g-yard']], T0 + 1_000);
  assert.deepEqual(f, [{ id: 'w1', kind: 'soul-arrives', why: 's_a arrived at g-yard', at: new Date(T0 + 1_000).toISOString() }]);
  come([], T0 + 2_000);
  assert.deepEqual(come([['s_a', 'g-yard']], T0 + 3_000), [], 'a second arrival inside the window does not fire');
  assert.equal(ruleOf(r, 'w1').lastMatch, T0 + 3_000, 'though it matched');
  come([], T0 + 4_000);
  assert.equal(come([['s_a', 'g-yard']], T0 + 301_000).length, 1, 'after the window it fires again');
  assert.equal(ruleOf(r, 'w1').lastFired, T0 + 301_000);
});

/** A stand-in world: an inbox that hands out what the test posts, an event stream with nothing on it. */
async function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'souls-wake-')), w = { dir, inbox: [], env: {}, line: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://w'), p = url.pathname;
    let body = ''; for await (const c of req) body += c;
    const json = (status, v) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); } };
    if (p === '/v1/edge/self/link') return json(200, { link: { state: 'connected' }, now: w.line });   // #1933: the public line
    if (p === '/v1/edge/self/now') { w.line = JSON.parse(body).text; return json(200, { now: w.line }); }
    if (/^\/v1\/edge\/inbox\/[^/]+\/ack$/.test(p)) { const b = JSON.parse(body || '{}'); if ('now' in b) w.line = b.now; return json(200, { acked: true }); }
    if (p === '/v1/edge/inbox/listen') { await new Promise((r) => setTimeout(r, Number(url.searchParams.get('timeoutMs')) > 0 ? 200 : 0)); return json(200, { inbox: { connected: true }, backlog: w.inbox }); }
    if (p === '/v1/edge/wait') { await new Promise((r) => setTimeout(r, 200)); return json(200, { events: [], cursor: url.searchParams.get('after') ?? 'c_0' }); }
    return json(404, { error: { code: 'not-found', message: p } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_me', token: 'synthetic-wake-token' }), { mode: 0o600 });
  w.cli = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), ...args], { cwd: dir, env: { ...process.env, ...w.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* text */ } done({ code, err, json: j, out }); });
  });
  w.state = () => JSON.parse(readFileSync(join(dir, '.eden-serve.json'), 'utf8'));
  t.after(async () => {
    await w.cli('serve', '--stop');   // #2076: it answers once serve has exited, so the folder goes at once
    server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true });
  });
  return w;
}
const until = async (f, ms = 8_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };

test('A1: wake lists, adds and removes rules, in serve\'s state file, with or without a serve, and they survive a restart', async (t) => {
  const w = await world(t);
  let r = await w.cli('wake', 'add', 'place-busy', '{"place":"g-hall","atLeast":3}', '--every', '60');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.added, 'w1'); assert.equal(r.json.serving, false);
  assert.deepEqual(w.state().wake.rules.at(-1), { id: 'w1', kind: 'place-busy', params: { place: 'g-hall', atLeast: 3 }, every: 60 });
  assert.equal((await w.cli('wake', 'remove', 'owner-message')).code, 1, 'an always-on rule cannot be removed');
  assert.equal((await w.cli('wake', 'add', 'sunrise')).code, 1, 'an unknown kind is refused');

  assert.equal((await w.cli('serve')).code, 0);
  r = await w.cli('wake', 'add', 'soul-arrives', '{"who":"s_mira"}');
  assert.equal(r.code, 0, r.err); assert.equal(r.json.added, 'w2'); assert.equal(r.json.serving, undefined, 'the running serve made the change');
  assert.ok(await until(() => w.state().wake?.cursor), 'the 2-second timer takes the engine\'s cursor');
  w.inbox.push({ id: 'msg_1', text: 'come to the hall', sentAt: T0 });
  assert.ok(await until(() => view(w.state().wake).rules.find((x) => x.id === 'owner-message').lastFired), 'its last firing is kept');
  // #1981: an always-on kind reaches the mind by its own path, so its firing queues nothing
  assert.deepEqual(w.state().wake.queue, []);

  assert.equal((await w.cli('serve', '--stop')).code, 0);
  await until(async () => (await w.cli('serve', '--status')).json?.serving === false);
  assert.equal((await w.cli('serve')).code, 0);
  r = await w.cli('wake', 'remove', 'w1');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.rules.map((x) => x.id), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'plan-finished', 'event-starting', 'w2'], 'kept across the restart');
  assert.equal(r.json.queued, 0, 'nothing waits for a reader that never comes (#1981)');
  assert.ok(r.json.rules.find((x) => x.id === 'owner-message').lastFired);
});

// #1968: the owner's wake budget. Ambient wakes (the rules an owner adds, and act-ended) are merged per rule, delivered within the
// budget, and held after delivery until another agent command reaches serve.
const HOUR = 3_600_000;
const soulArrives = (id) => ({ id, ...parseRule(['soul-arrives', '{"where":"g-hall"}', '--every', '0']) });

test('#1968 A1: wake budget <quiet|normal|lively|unlimited|n> and --day <n>; normal until the owner chooses', () => {
  assert.deepEqual(BUDGETS, { quiet: 4, normal: 12, lively: 60, unlimited: null });
  assert.deepEqual(budgetView(fresh(), T0), { budget: 'normal', perHour: 12, perDay: null, chosen: false, deliveredLastHour: 0, deliveredLast24h: 0 });
  let w = fresh();
  for (const [argv, want] of [[['quiet'], { budget: 'quiet', perHour: 4 }], [['lively'], { perHour: 60 }], [['unlimited'], { perHour: null }], [['7'], { budget: 7, perHour: 7 }]]) {
    w = change(w, { budget: parseBudget(argv) }).wake;
    const v = budgetView(w, T0);
    for (const [k, x] of Object.entries(want)) assert.equal(v[k], x, argv[0]);
    assert.equal(v.chosen, true);
  }
  w = change(w, { budget: parseBudget(['--day', '20']) }).wake;
  assert.deepEqual([budgetView(w, T0).perHour, budgetView(w, T0).perDay], [7, 20], 'a daily limit keeps the hourly one');
  assert.equal(budgetView(change(fresh(), { budget: parseBudget(['--day', '5']) }).wake, T0).chosen, false, 'a daily limit alone is not the owner\'s choice of budget');
  for (const bad of [[], ['busy'], ['--day'], ['--day', 'x'], ['4', '5']]) assert.throws(() => parseBudget(bad), /wake budget/);
  const sent = { ...w, delivered: [{ at: T0 - 2 * HOUR }, { at: T0 - 10_000 }, { at: T0 - 25 * HOUR }] };
  assert.deepEqual([budgetView(sent, T0).deliveredLastHour, budgetView(sent, T0).deliveredLast24h], [1, 2]);
  const skill = readFileSync(fileURLToPath(new URL('./soul/skill.md', import.meta.url)), 'utf8');
  assert.ok(Buffer.byteLength(skill) <= 4096, 'skill.md stays within 4,096 bytes');
  const lines = skill.split('\n').filter((l) => /\bwakes?\b/i.test(l) && !l.startsWith('At chat start'));
  assert.ok(lines.length <= 5, `at most five lines for all of wake: ${lines.length}`);
  assert.match(lines.join(' '), /one model turn/); assert.match(lines.join(' '), /ask your owner once/);
});

test('#1968 A2: owner messages and the stopped plan are outside the budget; speech is limited per speaker', () => {
  const spent = { ...fresh(), budget: { hour: 'quiet' }, delivered: [1, 2, 3, 4].map((i) => ({ at: T0 - i })), queue: enqueue([], [{ id: 'w1', kind: 'soul-arrives', why: 'Mira arrived', at: 'x' }, { id: 'owner-message', kind: 'owner-message', why: 'the owner wrote (msg_1)', at: 'x' }]) };
  const over = deliver(spent, T0);
  assert.deepEqual(over.wakes, [], 'four this hour: quiet delivers no fifth');
  assert.deepEqual(over.wake.queue.map((q) => q.id), ['w1'], 'the always-on kinds come by their own paths, not from the budgeted queue');
  const free = deliver(spent, T0, { free: true });
  assert.deepEqual(free.wakes.map((x) => x.id), ['w1'], 'with an owner message, a refused plan step or speech, queued wakes ride along');
  assert.equal(free.wake.delivered.length, 4, 'and cost nothing');

  const bo = { from: 'Bo', soulId: 's_bo' }, ivo = { from: 'Ivo', soulId: 's_ivo' };
  let spoke = spokeNow({}, [bo], T0);
  assert.equal(speechDue([bo], spoke, T0 + 1_000), false, 'Bo woke this Soul a second ago: his next line waits');
  assert.equal(speechDue([bo, ivo], spoke, T0 + 1_000), true, 'Ivo has not: his line wakes (and Bo\'s waiting lines join it)');
  spoke = spokeNow(spoke, [bo, ivo], T0 + 1_000);
  assert.equal(speechDue([bo], spoke, T0 + 1_000 + SPEAKER_MS - 1), false);
  assert.equal(speechDue([bo], spoke, T0 + 1_000 + SPEAKER_MS), true, 'a minute on, Bo\'s lines wake again, together');
});

test('#1968 A3: wakes over the budget merge to one entry per rule with a count and the latest why; a --follow line stays within 2,000 characters', () => {
  let q = enqueue([], [{ id: 'w1', kind: 'soul-arrives', why: 'Mira arrived', at: 'a' }, { id: 'w2', kind: 'place-busy', why: '3 Souls', at: 'a' }]);
  q = enqueue(q, [{ id: 'w1', kind: 'soul-arrives', why: 'Ivo arrived', at: 'b' }]);
  assert.deepEqual(q, [{ id: 'w1', kind: 'soul-arrives', why: 'Ivo arrived', at: 'b', count: 2 }, { id: 'w2', kind: 'place-busy', why: '3 Souls', at: 'a', count: 1 }]);
  const wakes = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, kind: 'soul-arrives', why: `${'Someone with a long name, '.repeat(20)}arrived`, at: new Date(T0).toISOString(), count: 9 }));
  const line = followLine({ messages: [], wakes, next: 'Your wake rules fired.', wake: 1 });
  assert.ok(JSON.stringify(line).length <= FOLLOW_MAX, `${JSON.stringify(line).length}`);
  assert.ok(line.wakes.length >= 1 && line.wakesOmitted === 50 - line.wakes.length);
  assert.equal(line.wakes.at(-1).id, 'w49', 'the newest rules stay');
});

test('#1968 A4: a delivered wake is held until a command from another process; unconfirmed for 10 minutes it returns', () => {
  const d = deliver({ ...fresh(), budget: { hour: 'quiet' }, queue: enqueue([], [{ id: 'w1', kind: 'soul-arrives', why: 'Mira arrived', at: 'a' }]) }, T0, { reader: 'L1' });
  assert.deepEqual(d.wakes.map((x) => [x.id, x.count]), [['w1', 1]]);
  const w = { ...d.wake, queue: enqueue(d.wake.queue, [{ id: 'w1', kind: 'soul-arrives', why: 'Ivo arrived', at: 'b' }]) };
  assert.equal(budgetView(w, T0).deliveredLastHour, 1);
  assert.equal(confirm(w, 'L1'), w, 'the reader\'s own next request (a listen\'s next poll) confirms nothing');
  assert.equal(expire(w, T0 + HELD_MS - 1).held.length, 1, 'held for ten minutes');
  const back = expire(w, T0 + HELD_MS);
  assert.deepEqual(back.held, []);
  assert.deepEqual(back.queue, [{ id: 'w1', kind: 'soul-arrives', why: 'Ivo arrived', at: 'b', count: 2 }], 'back in the queue, merged under what queued since');
  assert.equal(budgetView(back, T0 + HELD_MS).deliveredLastHour, 1, 'the delivery made stays counted (review of #2053: a refund let the budget be exceeded)');
  assert.equal(budgetView(deliver(back, T0 + HELD_MS, { reader: 'L2' }).wake, T0 + HELD_MS).deliveredLastHour, 2, 'delivered again, it is charged again');
  const taken = confirm(w, 'L2');
  assert.deepEqual([taken.held, expire(taken, T0 + HELD_MS).queue[0].count], [[], 1], 'a new listen started: it took what the last one was handed; only what queued since is left');

  // a run reads with pending and dies; the next run's pending, inside the hold, is handed the same wake, at no new charge
  const p = deliver(w, T0 + 1_000, { reader: 'P2', rehand: true });
  assert.deepEqual(p.wakes.map((x) => [x.id, x.why, x.count]), [['w1', 'Ivo arrived', 2]], 'the held one and what queued since, merged');
  assert.equal(budgetView(p.wake, T0 + 1_000).deliveredLastHour, 2, 'the queued one is a new delivery; the held one costs nothing again');
  assert.deepEqual(p.wake.held.map((g) => g.reader), ['P2', 'P2']);
});

test('#1968 review: an hour of a lively place with rule wakes nobody confirms never delivers more than the budget, and status counts every delivery', () => {
  for (const hour of ['quiet', 'normal', 'lively']) {
    const st = serveState({ live: pic([['s_me', 'g-yard']]) });
    let wake = { ...fresh(), rules: [soulArrives('w1')], budget: { hour } }, handed = 0;
    for (let t = 0; t < HOUR; t += 2_000) {   // someone arrives every 4 s; one listen --follow polls every 2 s and nothing else ever runs
      st.live = pic([['s_me', 'g-yard'], ...(t % 4_000 ? [[`s_${t}`, 'g-hall']] : [])]);
      const r = evaluate(wake.rules, { ...st, wake }, T0 + t);
      wake = { ...wake, rules: r.rules, cursor: r.cursor, queue: enqueue(wake.queue, r.fired) };
      const d = deliver(confirm(wake, 'L'), T0 + t, { reader: 'L' });
      if (d.wakes.length) handed++;
      wake = d.wake;
    }
    assert.ok(handed <= BUDGETS[hour], `${hour}: ${handed} deliveries`);
    assert.equal(handed, BUDGETS[hour], `${hour}: the budget is used, not exceeded`);
    assert.equal(budgetView(wake, T0 + HOUR - 1).deliveredLastHour, handed, `${hour}: status counts what was delivered`);
  }
});

test('#1968 A5: five --every 0 rules raise 200 matches in an hour on a busy place: quiet delivers 4, normal 12, unlimited one per rule per evaluation', () => {
  const run = (hour) => {
    const st = serveState({ live: pic([['s_me', 'g-yard']]) });
    let wake = { ...fresh(), rules: [1, 2, 3, 4, 5].map((i) => soulArrives(`w${i}`)), ...(hour ? { budget: { hour } } : {}) };
    let matches = 0, evaluations = 0;
    const deliveries = [];
    for (let t = 0; t < HOUR; t += 2_000) {   // serve evaluates every 2 s; a crowd comes to the hall and leaves every 90 s
      const n = Math.floor(t / 90_000);
      st.live = pic([['s_me', 'g-yard'], ...(t % 90_000 >= 45_000 ? Array.from({ length: 3 }, (_, k) => [`s_${n}_${k}`, 'g-hall', `Guest ${n}.${k}`]) : [])]);
      const r = evaluate(wake.rules, { ...st, wake }, T0 + t);
      wake = { ...wake, rules: r.rules, cursor: r.cursor, queue: enqueue(wake.queue, r.fired) };
      matches += r.fired.length; if (r.fired.length) evaluations++;
      const d = deliver(wake, T0 + t, { reader: 'listen' });   // a reader takes what it is handed at every evaluation, and acts: confirmed
      if (d.wakes.length) deliveries.push(d.wakes);
      wake = confirm(d.wake, 'act');
    }
    return { matches, evaluations, deliveries, wake };
  };
  const quiet = run('quiet'), normal = run(), unlimited = run('unlimited');
  assert.equal(quiet.matches, 200); assert.equal(quiet.evaluations, 40);
  assert.equal(quiet.deliveries.length, 4, 'quiet');
  assert.equal(normal.deliveries.length, 12, 'normal');
  assert.deepEqual(quiet.wake.queue.map((q) => q.id), ['w1', 'w2', 'w3', 'w4', 'w5'], 'the rest wait, one entry per rule');
  assert.equal(quiet.wake.queue.reduce((n, q) => n + q.count, 0) + quiet.deliveries.flat().reduce((n, q) => n + q.count, 0), 200, 'merged, none lost');
  assert.equal(unlimited.deliveries.length, 40, 'unlimited: every evaluation that matched');
  for (const d of unlimited.deliveries) assert.deepEqual(d.map((x) => [x.id, x.count]), [['w1', 1], ['w2', 1], ['w3', 1], ['w4', 1], ['w5', 1]], 'merged to one per rule');
});

test('#1968 A1, A4: wake budget and status through the CLI; a run killed after pending leaves its wake to the next run', async (t) => {
  const w = await world(t);
  w.env = { EDEN_TIME_SCALE: '0.01' };   // serve holds a handed wake HELD_MS × 0.01 = 6 s here
  let r = await w.cli('wake');
  assert.deepEqual([r.json.budget.budget, r.json.budget.chosen], ['normal', false]);
  r = await w.cli('wake', 'budget', 'quiet');
  assert.equal(r.code, 0, r.err); assert.deepEqual([r.json.budget.perHour, r.json.budget.chosen], [4, true]);
  r = await w.cli('wake', 'budget', '--day', '20');
  assert.deepEqual([r.json.budget.budget, r.json.budget.perDay], ['quiet', 20]);
  assert.equal((await w.cli('wake', 'budget', 'busy')).code, 1);
  assert.equal((await w.cli('wake', 'add', 'soul-arrives', '{"where":"g-yard"}')).code, 0);
  const queue = (why, count) => { const st = w.state(); st.wake.queue = [{ id: 'w1', kind: 'soul-arrives', why, at: new Date().toISOString(), count }]; writeFileSync(join(w.dir, '.eden-serve.json'), JSON.stringify(st)); };
  queue('Mira arrived at g-yard', 3);
  assert.equal((await w.cli('serve')).code, 0);

  const killed = await new Promise((done) => {   // a scheduled run reads its wakes and dies
    const child = spawn(process.execPath, [fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), 'pending'], { cwd: w.dir, env: { ...process.env, ...w.env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.on('data', (c) => { out += c; child.kill('SIGKILL'); }); child.on('exit', () => done(out));
  });
  assert.deepEqual(JSON.parse(killed).wakes.map((x) => [x.id, x.count]), [['w1', 3]]);
  assert.deepEqual([w.state().wake.held.length, w.state().wake.queue.length], [1, 0], 'held, not gone');
  r = await w.cli('status');
  assert.deepEqual([r.json.wake.budget, r.json.wake.deliveredLastHour, r.json.wake.deliveredLast24h], ['quiet', 1, 1], 'status shows the budget and what was delivered');
  assert.equal((await w.cli('serve', '--status')).json.serving, true);
  assert.equal(w.state().wake.held.length, 1, 'the next run\'s status, through serve, takes nothing');
  r = await w.cli('pending');
  assert.deepEqual(r.json.wakes.map((x) => [x.id, x.why, x.count]), [['w1', 'Mira arrived at g-yard', 3]], 'the next run\'s pending, inside the hold, is handed it again');
  assert.equal(w.state().wake.delivered.length, 1, 'at no new charge');
  assert.equal((await w.cli('wake')).code, 0, 'another agent command reaches serve');
  assert.deepEqual(w.state().wake.held, [], 'it took what pending handed');

  await w.cli('serve', '--stop'); await until(async () => (await w.cli('serve', '--status')).json?.serving === false);
  queue('Ivo arrived at g-yard', 1); assert.equal((await w.cli('serve')).code, 0);
  assert.deepEqual((await w.cli('pending')).json.wakes.map((x) => x.why), ['Ivo arrived at g-yard']);
  assert.ok(await until(() => w.state().wake.queue.some((q) => q.id === 'w1'), 15_000), 'no command came: after the hold it returns to the queue');
  assert.deepEqual([w.state().wake.held.length, w.state().wake.delivered.length], [0, 2], 'the delivery made stays counted');
  assert.deepEqual((await w.cli('pending')).json.wakes.map((x) => x.why), ['Ivo arrived at g-yard'], 'delivered again');
  assert.equal(w.state().wake.delivered.length, 3, 'and charged again: the count is the deliveries made');
});

// #1930: wake on a time, when a plan finishes, and when the Soul has been idle. A fake clock: the rules run every 2 s, as serve's
// timer runs them, with `since` the time this serve started.
const MIN = 60_000, iso = (ms) => new Date(ms).toISOString();
function clock(rules, st) {
  let r = { rules };
  return { run(from, to) { const out = []; for (let t = from; t <= to; t += 2_000) out.push(...(r = step(r.rules, st, t)).fired); return out; }, rule: (id) => ruleOf(r, id), get rules() { return r.rules; } };
}

test('#1930 A1, A4: at fires once at its time on serve\'s timer; a time that passed while serve was not running is dropped, never fired late', () => {
  const at = iso(T0 + 10 * MIN), st = serveState({ since: T0 }), c = clock([{ id: 'w1', ...parseRule(['at', at]) }], st);
  assert.deepEqual(c.run(T0, T0 + 10 * MIN - 2_000), [], 'not before');
  assert.deepEqual(c.run(T0 + 10 * MIN, T0 + 20 * MIN).map((f) => [f.id, f.kind, f.why, f.at]), [['w1', 'at', `it is ${at}`, at]], 'at the time, once');
  assert.equal(c.rule('w1').ended, 'fired');

  const down = serveState({ since: T0 }), d = clock([{ id: 'w2', ...parseRule(['at', at]) }], down);
  d.run(T0, T0 + MIN);   // serve stops at one minute and starts again at twenty: ten passed while it was not running
  down.since = T0 + 20 * MIN;
  assert.deepEqual(d.run(T0 + 20 * MIN, T0 + 30 * MIN), [], 'dropped, never fired late');
  assert.equal(view({ ...fresh(), rules: d.rules }).rules[0].ended, 'dropped', 'wake shows it was dropped');

  assert.throws(() => parseRule(['at', 'tomorrow']), /ISO time/);
  assert.deepEqual(parseRule(['at', '2026-11-12T09:00:00Z']).params, { at: '2026-11-12T09:00:00.000Z' });
});

test('#1930 A1, A4: every <minutes> (at least 5) fires each period; periods that passed while serve was not running are dropped', () => {
  assert.throws(() => parseRule(['every', String(EVERY_MIN - 1)]), /at least 5/);
  assert.throws(() => parseRule(['every', '{"minutes":5}']), /whole minutes/);
  const st = serveState({ since: T0 }), c = clock([{ id: 'w1', ...parseRule(['every', '5']) }], st);
  assert.deepEqual(c.run(T0, T0 + 31 * MIN).map((f) => f.at), [5, 10, 15, 20, 25, 30].map((m) => iso(T0 + m * MIN)));
  st.since = T0 + 52 * MIN;   // serve is down from 31 to 52 minutes: 35, 40, 45 and 50 pass while it is not running
  assert.deepEqual(c.run(T0 + 52 * MIN, T0 + 60 * MIN).map((f) => f.at), [55, 60].map((m) => iso(T0 + m * MIN)), 'dropped; it carries on at 55');
});

test('#1930 A1: at, every, plan-finished and idle wakes go through the ambient budget, charged once per delivery', () => {
  for (const kind of ['at', 'every', 'plan-finished', 'idle']) {
    const queue = enqueue([], [{ id: 'w1', kind, why: kind, at: iso(T0) }]);
    const spent = deliver({ ...fresh(), budget: { hour: 'quiet' }, delivered: [1, 2, 3, 4].map((i) => ({ at: T0 - i })), queue }, T0);
    assert.deepEqual([spent.wakes, spent.over], [[], true], `${kind}: over the budget it waits`);
    const d = deliver({ ...fresh(), queue }, T0, { reader: 'L' });
    assert.deepEqual([d.wakes.map((x) => x.kind), d.wake.delivered.length], [[kind], 1], `${kind}: one delivery, one charge`);
  }
});

test('#1930 A2, A4: plan-finished wakes when a plan ends done or failed, never when it was replaced; on by default', () => {
  assert.ok(fresh().rules.some((x) => x.id === 'plan-finished' && !x.always), 'on by default, and removable');
  assert.equal(change(fresh(), { remove: 'plan-finished' }).removed, 'plan-finished');
  const st = serveState({ plan: { id: 'p_1', state: 'running', at: 0, steps: [{ id: 'walk:mill', state: 'running' }] } }), c = clock(fresh().rules, st);
  c.run(T0, T0);
  st.plan = null; st.planEnded = [{ id: 'p_1', state: 'done', step: 1, of: 1, steps: [{ n: 1, id: 'walk:mill', state: 'done' }] }];
  assert.deepEqual(c.run(T0 + 2_000, T0 + 6_000).map((f) => [f.id, f.why]), [['plan-finished', 'plan p_1 finished']], 'once per plan');
  st.planEnded.push({ id: 'p_2', state: 'replaced', step: 1, of: 2, steps: [] });   // p_3 replaced p_2, then failed
  st.plan = { id: 'p_3', state: 'failed', at: 0, steps: [{ id: 'sit:bench', state: 'refused' }] };
  assert.deepEqual(c.run(T0 + 8_000, T0 + 10_000).map((f) => f.why), ['plan p_3 ended failed'], 'the replaced plan wakes no one');
});

test('#1930 A3, A4: idle fires once after that long with no agent command and no running plan, again only after a command; a seated Soul is idle', () => {
  assert.ok(!fresh().rules.some((x) => x.kind === 'idle'), 'off by default');
  assert.throws(() => parseRule(['idle']), /minutes/);
  assert.throws(() => parseRule(['idle', '{"minutes":4}']), /at least 5/, 'the same 5-minute floor as every');
  assert.equal(parseRule(['idle', '{"minutes":5}']).params.minutes, 5);
  const sit = { r_sit: { id: 'r_sit', capability: 'sit:bench', phase: 'started', mine: true, read: false } };   // a held sit stays started
  const st = serveState({ since: T0, receipts: sit, lastCommandAt: T0 + MIN }), c = clock([{ id: 'w1', ...parseRule(['idle', '{"minutes":30}']) }], st);
  assert.deepEqual(c.run(T0, T0 + 31 * MIN - 2_000), [], 'thirty minutes from the last command, not before');
  assert.deepEqual(c.run(T0 + 31 * MIN, T0 + 180 * MIN).map((f) => [f.id, f.kind, f.at]), [['w1', 'idle', iso(T0 + 31 * MIN)]], 'seated and idle: once');
  st.lastCommandAt = T0 + 180 * MIN;
  assert.deepEqual(c.run(T0 + 182 * MIN, T0 + 240 * MIN).map((f) => f.at), [iso(T0 + 210 * MIN)], 'again after an agent command');
  st.lastCommandAt = T0 + 300 * MIN; st.plan = { id: 'p_1', state: 'running', at: 0, steps: [] };
  assert.deepEqual(c.run(T0 + 300 * MIN, T0 + 360 * MIN), [], 'a plan running for an hour is not idle');
  st.plan = { ...st.plan, state: 'done' };
  assert.deepEqual(c.run(T0 + 360 * MIN + 2_000, T0 + 420 * MIN).map((f) => f.at), [iso(T0 + 390 * MIN)], 'thirty minutes after it stopped running');
});

// #1932: the heartbeat. A scheduler gates a run on `pending --check`, which answers by exit code alone and starts serve itself.
const sh = (cmd, env) => new Promise((done) => {
  const child = spawn('sh', ['-c', cmd], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', () => {});
  child.on('exit', (code) => done({ code, out }));
});

test('#1932 A1: pending --check starts serve, exits 1 when there is nothing and 0, silent, when there is; it takes nothing', async (t) => {
  const w = await world(t);
  assert.equal((await w.cli('serve', '--status')).json.serving, false);
  let r = await w.cli('pending', '--check');
  assert.deepEqual([r.code, r.out], [1, ''], 'nothing to do: exit 1, nothing printed');
  assert.equal((await w.cli('serve', '--status')).json.serving, true, 'it started serve');
  w.inbox.push({ id: 'msg_1', text: 'come to the hall', sentAt: T0 });
  r = await until(async () => { const x = await w.cli('pending', '--check'); return x.code === 0 && x; });
  assert.deepEqual([r.code, r.out], [0, ''], 'an owner message: exit 0, nothing printed');
  assert.equal((await w.cli('pending', '--check')).code, 0, 'the check read nothing: it still finds it');
  assert.deepEqual((await w.cli('pending')).json.ownerMessages.map((m) => m.id), ['msg_1'], 'pending still hands it over');
});

test('#1932 A2: wake heartbeat prints the prompt and the gated command, keeps the cadence, and the command starts no run when idle', async (t) => {
  const w = await world(t), folder = realpathSync(w.dir);
  let r = await w.cli('wake', 'heartbeat');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.heartbeat.every, HEARTBEAT_EVERY_MIN);
  r = await w.cli('wake', 'heartbeat', '--every', '15');
  const { every, prompt, command } = r.json.heartbeat;
  assert.equal(every, 15);
  assert.equal(JSON.parse(readFileSync(join(w.dir, '.eden-agent.json'), 'utf8')).heartbeat.every, 15, 'the cadence is in the Soul\'s state');
  assert.ok(prompt.split(/\s+/).length <= 120, `${prompt.split(/\s+/).length} words`);
  assert.ok(prompt.includes(folder), 'it names the Soul\'s folder');
  // #2119 A4: one paragraph; with a goal and nothing from the owner it goes to help living, with no goal and nothing new it stops at once.
  assert.ok(!prompt.includes('\n'), 'one paragraph');
  assert.match(prompt, /pending\. If it holds owner messages, act on them as the skill says, then stop\./);
  assert.match(prompt, /If it holds none and its brief lists a goal \(a line with Next:\), run node \S+ help living and do its steps in order, none skipped, then stop\./);
  assert.match(prompt, /If it has no owner message and no goal, and reports nothing new \(no ended acts, events, speech or wakes\), stop now and do nothing else\. Otherwise act on what it reports, as the skill says, then stop\.$/);
  assert.equal((await w.cli('wake', 'heartbeat', '--every', '0')).code, 1);

  // The harness is a stand-in that leaves a mark: idle, the gated command never starts it; with a message waiting, it does.
  const bin = join(w.dir, 'bin'), mark = join(w.dir, 'ran');
  mkdirSync(bin);
  for (const h of ['claude', 'codex']) { writeFileSync(join(bin, h), `#!/bin/sh\necho "$@" >> '${mark}'\n`); chmodSync(join(bin, h), 0o755); }
  const env = { PATH: `${bin}:${process.env.PATH}` };
  for (const h of ['claude', 'codex']) assert.equal((await sh(command[h], env)).code, 1, `${h}: idle, the check stops the line`);
  assert.equal(existsSync(mark), false, 'no harness run started: no tokens');
  w.inbox.push({ id: 'msg_1', text: 'come to the hall', sentAt: T0 });
  assert.ok(await until(async () => (await w.cli('pending', '--check')).code === 0));
  for (const h of ['claude', 'codex']) assert.equal((await sh(command[h], env)).code, 0);
  const runs = readFileSync(mark, 'utf8').trim().split('\n');
  assert.equal(runs.length, 2, 'one run per harness');
  assert.ok(runs.every((x) => x.includes(prompt)), 'each with the heartbeat prompt');
});

// #2076: --stop answers only after serve has written its state and released its lock: a folder removed right after it goes,
// 20 times out of 20, with no retry and no wait for the lock.
test('#2076: serve --stop answers after serve exits; the folder is removed right after, 20 of 20', async (t) => {
  const w = await world(t), agent = readFileSync(join(w.dir, '.eden-agent.json'), 'utf8');
  for (let i = 0; i < 20; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'souls-stop-'));
    writeFileSync(join(dir, '.eden-agent.json'), agent, { mode: 0o600 });
    const cli = (...args) => new Promise((done) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; child.stdout.on('data', (c) => { out += c; }); child.on('exit', (code) => done({ code, out }));
    });
    assert.equal((await cli('serve')).code, 0, `round ${i}: serve started`);
    assert.equal((await cli('wake', 'add', 'soul-arrives')).code, 0, `round ${i}: serve writes its state`);
    const r = await cli('serve', '--stop');
    assert.equal(r.code, 0); assert.equal(JSON.parse(r.out).stopping, true);
    assert.equal(existsSync(join(dir, '.eden-serve.lock')), false, `round ${i}: the lock is released before the answer`);
    assert.equal(existsSync(join(dir, '.eden-serve.json.tmp')), false, `round ${i}: no state write is under way`);
    rmSync(dir, { recursive: true });
    assert.equal(existsSync(dir), false, `round ${i}: removed`);
  }
});

// #1981: small client fixes from the eight-hour living run.
test('#1981 A4: speech-to-me fires (its rule keeps the firing) but queues nothing; pending says speech is under addressed', () => {
  const st = serveState({ wake: {} });
  step(fresh().rules, st, T0);
  const r = step(fresh().rules, { ...st, addressed: [{ seq: 1, from: 'Bo', soulId: 's_bo', text: 'hi' }], addressedSeq: 1 }, T0 + 1_000);
  assert.deepEqual(r.fired.map((f) => f.kind), ['speech-to-me'], 'the rule still fires');
  assert.ok(ruleOf(r, 'speech-to-me').lastFired);
  assert.deepEqual(enqueue([], r.fired), [], 'and leaves no entry for a reader: the speech itself comes as addressed');
  assert.deepEqual(enqueue([], [{ id: 'owner-message', kind: 'owner-message', why: 'x', at: 'a' }, { id: 'plan-stopped', kind: 'plan-stopped', why: 'y', at: 'a' }, { id: 'w1', kind: 'soul-arrives', why: 'Mira arrived', at: 'a' }]).map((q) => q.id), ['w1'], 'nor do the other always-on kinds');
  assert.match(pendingNotes({ ownerMessages: [], addressed: [{ text: 'hi' }] }, '').speechNote, /under addressed: that is the speech-to-me wake\. It is never also under wakes\./);
  assert.equal(pendingNotes({ ownerMessages: [] }, '').speechNote, undefined, 'no speech, no note');
});

test('#1981 A3: pending on a wake with no owner message and a goal ends with help living\'s steps in order', () => {
  const brief = 'Open commitments:\n- [friends] make friends Next: talk to Bo';
  assert.match(pendingNotes({ ownerMessages: [] }, brief).next, /^No owner message: run node eden\.mjs help living and do its steps in order, none skipped \(whatson and look, one plan, remember --next, now\), then stop\.$/);
  assert.equal(pendingNotes({ ownerMessages: [{ id: 'msg_1' }] }, brief).next, undefined, 'an owner message comes first');
  assert.equal(pendingNotes({ ownerMessages: [] }, 'Open commitments:\n- a promise').next, undefined, 'no goal, no reminder');
});

test('#1981 A2: help living names the 1,800 s cap and says to chain or repeat activities; heartbeats over 30 minutes say so too', async (t) => {
  const w = await world(t);
  const living = (await w.cli('help', 'living')).out;
  assert.ok(living.split(/\s+/).filter(Boolean).length <= 600, 'help living stays within 600 words');
  assert.match(living, /One activity lasts at most 1,800 s .* so for a longer gap chain activities, or\s+repeat one, each within its cap/s);
  assert.match(living, /do steps 1 to 6 in order and skip none/);
  const long = (await w.cli('wake', 'heartbeat', '--every', '45')).json;
  assert.equal(long.gap, '45 minutes is longer than one activity (at most 1800 s): help living has the Soul chain activities, or repeat one, to cover the gap.');
  for (const every of ['30', '15']) assert.equal((await w.cli('wake', 'heartbeat', '--every', every)).json.gap, undefined, `${every} minutes fits one activity`);
  assert.match((await w.cli('wake', 'heartbeat')).json.gap, /^60 minutes/, 'the default heartbeat is longer than one activity');
});

// #1933: the mind is away. A fake clock: T0 is 2027-01-15 08:00 UTC.
test('#1933 A1, A2: away after 10 minutes of a wake or owner message no acting command answered, or of no command; the line says since when or the next check', () => {
  let w = saw(fresh(), 'command', T0);
  assert.equal(awaySince(w, T0 + 9 * MIN, T0), null);
  assert.equal(awaySince(w, T0 + 10 * MIN, T0), T0, 'no follower and no command for 10 minutes');
  assert.equal(awaySince(fresh(), T0 + 10 * MIN, T0), T0, 'serve\'s start stands in for a command never seen');
  w = saw(w, 'owed', T0 + MIN);   // an owner message arrived
  for (let t = T0 + MIN; t < T0 + 11 * MIN; t += MIN) w = saw(w, 'command', t);   // listen --follow polls, and pending, but nothing acts
  assert.equal(awaySince(w, T0 + 11 * MIN, T0), T0 + MIN, 'a follower keeps polling: still away, from the message');
  assert.equal(saw(w, 'owed', T0 + 5 * MIN).mind.owed, T0 + MIN, 'the first unanswered one counts');
  w = saw(w, 'acting', T0 + 11 * MIN);
  assert.equal(awaySince(w, T0 + 20 * MIN, T0), null, 'an acting command answered it');
  assert.equal(AWAY_MS, 10 * MIN);

  assert.equal(awayText(T0 + MIN, undefined, T0 + 11 * MIN), 'mind away since 08:01 UTC');
  const hb = { every: 60, at: new Date(T0 - 30 * MIN).toISOString() };   // kept at 07:30, every hour
  assert.equal(awayText(T0 + MIN, hb, T0 + 11 * MIN), 'mind away, next check about 08:30 UTC');
  assert.equal(awayText(T0 + MIN, hb, T0 + 31 * MIN), 'mind away, next check about 09:30 UTC', 'past 08:30: the next one');
});

test('#1933 A2, A3: going away keeps the line; the next acting command restores it, only while it still says away', () => {
  const text = awayText(T0, undefined, T0 + 10 * MIN);
  const away = wentAway(saw(fresh(), 'command', T0), T0, text, 'rowing to the mill');
  assert.deepEqual(away.mind.away, { since: T0, text, stored: 'rowing to the mill' });
  let b = back(away, text);
  assert.equal(b.restore, 'rowing to the mill', 'restored');
  assert.equal(b.wake.mind.away, undefined); assert.equal(b.wake.mind.last, T0, 'the rest of the mind state stays');
  assert.equal(back(wentAway(fresh(), T0, text, null), text).restore, null, 'no line before: the line is cleared');
  b = back(away, 'gone fishing');
  assert.equal(b.restore, undefined, 'someone changed the line since: it stays'); assert.equal(b.wake.mind.away, undefined);
  assert.equal(back(fresh(), text).restore, undefined, 'not away: nothing to restore');
});

test('#1933 review: while away, a next check that has passed is renewed to a future time, and the kept line still comes back', () => {
  const hb = { every: 60, at: new Date(T0 - 30 * MIN).toISOString() };   // kept at 07:30, every hour
  const first = awayText(T0, hb, T0 + 10 * MIN), away = wentAway(fresh(), T0, first, 'rowing to the mill');
  assert.equal(first, 'mind away, next check about 08:30 UTC');
  const later = T0 + 95 * MIN, again = awayText(away.mind.away.since, hb, later);   // 09:35: 08:30 has passed
  assert.equal(again, 'mind away, next check about 10:30 UTC');
  assert.ok(Date.parse(`2027-01-15T${again.match(/\d\d:\d\d/)[0]}:00Z`) > later, 'a future time');
  const renewed = wentAway(away, away.mind.away.since, again, away.mind.away.stored);
  assert.equal(back(renewed, again).restore, 'rowing to the mill');
});

test('#1933 A3: an acting command that sets its own line wins; the kept one is dropped', () => {
  const text = awayText(T0, undefined, T0 + 10 * MIN), b = back(wentAway(fresh(), T0, text, 'rowing to the mill'), text, true);
  assert.equal(b.restore, undefined); assert.equal(b.wake.mind.away, undefined);
});

test('#1933 A4: wake away off turns it off, and on again', () => {
  assert.deepEqual(parseAway(['off']), { away: 'off' });
  assert.throws(() => parseAway(['maybe']), /wake away <on\|off>/);
  const off = change(saw(fresh(), 'command', T0), parseAway(['off'])).wake;
  assert.equal(awaySince(off, T0 + 60 * MIN, T0), null, 'off: never away');
  assert.equal(view(off).away, 'off');
  const on = change(off, parseAway(['on'])).wake;
  assert.equal(awaySince(on, T0 + 60 * MIN, T0), T0); assert.equal(view(on).away, 'on');
});

test('#1933 A2, A3: through serve: the line goes away and an acting command puts it back; one with its own line wins', async (t) => {
  const w = await world(t);
  w.env = { EDEN_TIME_SCALE: '0.01' };   // away after AWAY_MS × 0.01 = 6 s, looked at every 0.3 s
  w.line = 'rowing to the mill';
  assert.equal((await w.cli('serve')).code, 0);
  // the world holds the new line before serve has its answer and writes its state: wait for both
  assert.ok(await until(() => /^mind away since \d\d:\d\d UTC$/.test(w.line ?? '') && w.state().wake.mind?.away, 15_000), `away: ${w.line}`);
  assert.equal(w.state().wake.mind.away.stored, 'rowing to the mill');
  let r = await w.cli('ack', 'msg_1', 'on my way');
  assert.equal(r.code, 0, r.err);
  assert.equal(w.line, 'rowing to the mill', 'restored');
  assert.equal(w.state().wake.mind.away, undefined);

  assert.ok(await until(() => /^mind away/.test(w.line ?? ''), 15_000), 'away again');
  r = await w.cli('ack', 'msg_2', 'coming', '--now', 'walking over');
  assert.equal(r.code, 0, r.err);
  assert.equal(w.line, 'walking over', 'the command\'s own line wins');
  assert.equal(w.state().wake.mind.away, undefined, 'the kept line is dropped');
});

// #1931: three more kinds, on recorded state. Envelopes as the world's classified stream sends them (envelope.ts).
const ambient = (id, soulId, name, text) => ({ id, tick: 9, at: T0, kind: 'speech.ambient', salience: 1, about: { soulId, name }, where: { dist: 6, bearing: 'left' }, text: `${name} (6 m, left): "${text}"`, untrusted: true, raw: 'speech', data: { from: { soulId, name }, text } });
const starting = (id, title) => ({ id, tick: 9, at: T0, kind: 'schedule.starting', salience: 2, text: `"${title}" is starting now at Commons.`, untrusted: true, raw: 'schedule', data: { placeId: 'g-commons', startsAtTick: 9 } });

test('#1931 A1: the stream reader keeps speech.ambient and schedule.starting in serve\'s state; addressed speech is folded as before', () => {
  const st = loadServeState.fresh();
  assert.equal(foldHeard(st, ambient('c_1', 's_bo', 'Bo', 'nice day')), true);
  assert.equal(foldHeard(st, starting('c_2', 'Open mic')), true);
  assert.equal(foldHeard(st, ambient('c_1', 's_bo', 'Bo', 'nice day')), false, 'once each');
  assert.equal(foldHeard(st, { id: 'c_3', kind: 'speech.to-me', about: { soulId: 's_bo', name: 'Bo' }, data: { text: 'Ada?' } }), false, 'addressed speech is not one of them');
  assert.deepEqual(st.heard.map((x) => [x.seq, x.kind, x.from, x.text, x.untrusted]), [[1, 'speech.ambient', 'Bo', 'nice day', true], [2, 'schedule.starting', null, '"Open mic" is starting now at Commons.', true]]);
  assert.equal(foldAddressed(st, ambient('c_4', 's_bo', 'Bo', 'hm')), false, 'ambient speech never reaches the addressed store');
  assert.equal(foldAddressed(st, { id: 'c_3', kind: 'speech.to-me', about: { soulId: 's_bo', name: 'Bo' }, data: { text: 'Ada?' } }), true);
  assert.deepEqual([st.addressed.length, st.heardSeq], [1, 2]);
  for (let i = 0; i < 30; i++) foldHeard(st, ambient(`n_${i}`, 's_bo', 'Bo', `line ${i}`));
  assert.equal(st.heard.length, 20, 'the newest few are kept');
});

test('#1931 A2, A4: speech-near-me fires on speech in earshot not said to this Soul, off by default, untrusted, and within the budget', () => {
  assert.ok(!fresh().rules.some((x) => x.kind === 'speech-near-me'), 'off by default');
  assert.throws(() => parseRule(['speech-near-me', '{"who":"s_bo"}']), /no params/);
  const st = serveState({ heard: [], heardSeq: 0 }), rules = [{ id: 'w1', ...parseRule(['speech-near-me', '--every', '0']) }];
  let r = step(rules, st, T0);
  foldHeard(st, ambient('c_1', 's_bo', 'Bo', 'nice day')); foldHeard(st, ambient('c_2', 's_me', 'Me', 'my own words')); foldHeard(st, starting('c_3', 'Open mic'));
  r = step(r.rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.kind, f.why, f.untrusted]), [['w1', 'speech-near-me', 'Bo said nearby: "nice day"', true]], 'not this Soul\'s own words, not the event');
  assert.deepEqual(step(r.rules, st, T0 + 4_000).fired, [], 'a line wakes once');
  // a noisy place: a line every 2 s for an hour, one listen polling and nobody confirming: the budget holds
  for (const hour of ['quiet', 'normal']) {
    const s2 = serveState({ heard: [], heardSeq: 0 });
    let wake = { ...fresh(), rules: [{ id: 'w1', ...parseRule(['speech-near-me', '--every', '0']) }], budget: { hour } }, handed = 0;
    for (let t = 0; t < HOUR; t += 2_000) {
      foldHeard(s2, ambient(`c_${t}`, 's_bo', 'Bo', `line ${t}`));
      const e = evaluate(wake.rules, { ...s2, wake }, T0 + t);
      wake = { ...wake, rules: e.rules, cursor: e.cursor, queue: enqueue(wake.queue, e.fired) };
      const d = deliver(confirm(wake, 'L'), T0 + t, { reader: 'L' });
      if (d.wakes.length) { handed++; assert.equal(d.wakes[0].untrusted, true, 'another Soul\'s words stay labelled'); }
      wake = d.wake;
    }
    assert.equal(handed, BUDGETS[hour], `${hour}: ${handed} deliveries, never more than the budget`);
  }
});

test('#1931 A2, A4: event-starting fires on schedule.starting, on by default', () => {
  assert.ok(fresh().rules.some((x) => x.id === 'event-starting' && !x.always), 'on by default, and removable');
  assert.equal(change(fresh(), { remove: 'event-starting' }).removed, 'event-starting');
  const st = serveState({ heard: [], heardSeq: 0 });
  foldHeard(st, starting('c_0', 'Before this serve looked'));
  let r = step(fresh().rules, st, T0);
  assert.deepEqual(r.fired, [], 'a first look starts from now');
  foldHeard(st, ambient('c_1', 's_bo', 'Bo', 'nice day')); foldHeard(st, starting('c_2', 'Open mic'));
  r = step(r.rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why, f.untrusted]), [['event-starting', '"Open mic" is starting now at Commons.', true]]);
  assert.deepEqual(step(r.rules, st, T0 + 4_000).fired, []);
});

test('#1931 A3, A4: thing-state fires when that field of that thing changes, read through thingState with the kind\'s defaults', () => {
  const catalog = indexCatalog({ places: [{ id: 'g-v', name: 'Village', kind: 'area', at: [0, 0] }], acts: [], things: [{ id: 'e_ch', name: 'porch-chest', kind: 'core-chest', place: 'g-v', at: [1, 0] }],
    kinds: { 'core-chest': { acts: [{ verb: 'open', label: 'Open' }], state: { open: false, locked: false } } } });
  assert.throws(() => parseRule(['thing-state', '{"thing":"e_ch"}']), /thing-state takes/);
  assert.throws(() => parseRule(['thing-state', '{"thing":"e_ch","field":"open","is":{"x":1}}']), /thing-state takes/);
  const any = { id: 'w1', ...parseRule(['thing-state', '{"thing":"e_ch","field":"open"}', '--every', '0']) }, closed = { id: 'w2', ...parseRule(['thing-state', '{"thing":"e_ch","field":"open","is":false}', '--every', '0']) };
  const st = serveState({ catalog, live: { souls: [], things: {} } });
  let r = step([any, closed], st, T0);
  assert.deepEqual([r.fired, ruleOf(r, 'w1').was], [[], 'false'], 'the first look takes the default in, wakes no one');
  st.live = { souls: [], things: { e_ch: { open: true } } };
  r = step(r.rules, st, T0 + 2_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why]), [['w1', 'e_ch open is now true']], 'is:false waits for false');
  assert.deepEqual((r = step(r.rules, st, T0 + 4_000)).fired, [], 'unchanged: no wake');
  st.live = { souls: [], things: { e_ch: { locked: true } } };   // the live row no longer names open: the kind's default stands
  r = step(r.rules, st, T0 + 6_000);
  assert.deepEqual(r.fired.map((f) => [f.id, f.why]), [['w1', 'e_ch open is now false'], ['w2', 'e_ch open is now false']]);
  assert.deepEqual(step(r.rules, { ...st, catalog: null }, T0 + 8_000).fired, [], 'no catalog copy: nothing is read');
});

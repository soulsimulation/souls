// #1929: wake rules. One pure function over what serve stores, unit-tested on recorded state; the rules, their last match and
// firing, the engine's cursor and the queue live in serve's state file, through the real CLI and a real serve on a stand-in world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACT_ENDED_GRACE_MS, BUDGETS, HELD_MS, SPEAKER_MS, budgetView, change, confirm, deliver, enqueue, evaluate, expire, fresh, parseBudget, parseRule, speechDue, spokeNow, view } from './soul/wake.mjs';
import { FOLLOW_MAX, followLine } from './soul/eden.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'souls-wake-')), w = { dir, inbox: [], env: {} };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://w'), p = url.pathname;
    for await (const _ of req) { /* drain */ }
    const json = (status, v) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); } };
    if (p === '/v1/edge/inbox/listen') { await new Promise((r) => setTimeout(r, Number(url.searchParams.get('timeoutMs')) > 0 ? 200 : 0)); return json(200, { inbox: { connected: true }, backlog: w.inbox }); }
    if (p === '/v1/edge/wait') { await new Promise((r) => setTimeout(r, 200)); return json(200, { events: [], cursor: url.searchParams.get('after') ?? 'c_0' }); }
    return json(404, { error: { code: 'not-found', message: p } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_me', token: 'synthetic-wake-token' }), { mode: 0o600 });
  w.cli = (...args) => new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), ...args], { cwd: dir, env: { ...process.env, ...w.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* text */ } done({ code, err, json: j }); });
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
  const queued = await until(() => w.state().wake.queue.find((q) => q.id === 'owner-message'));
  assert.equal(queued.kind, 'owner-message'); assert.match(queued.why, /msg_1/); assert.ok(Date.parse(queued.at));
  assert.ok(view(w.state().wake).rules.find((x) => x.id === 'owner-message').lastFired, 'its last firing is kept');

  assert.equal((await w.cli('serve', '--stop')).code, 0);
  await until(async () => (await w.cli('serve', '--status')).json?.serving === false);
  assert.equal((await w.cli('serve')).code, 0);
  r = await w.cli('wake', 'remove', 'w1');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.rules.map((x) => x.id), ['owner-message', 'speech-to-me', 'plan-stopped', 'act-ended', 'w2'], 'kept across the restart');
  assert.equal(r.json.queued, 1, 'the queue too');
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

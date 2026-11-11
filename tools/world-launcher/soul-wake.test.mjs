// #1929: wake rules. One pure function over what serve stores, unit-tested on recorded state; the rules, their last match and
// firing, the engine's cursor and the queue live in serve's state file, through the real CLI and a real serve on a stand-in world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACT_ENDED_GRACE_MS, change, evaluate, fresh, parseRule, view } from './soul/wake.mjs';

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
  assert.deepEqual(ruleOf(r, 'act-ended').held.map((h) => h.id), ['r_mine']);
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
  const dir = mkdtempSync(join(tmpdir(), 'souls-wake-')), w = { dir, inbox: [] };
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
    const child = spawn(process.execPath, [fileURLToPath(new URL('./soul/eden.mjs', import.meta.url)), ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* text */ } done({ code, err, json: j }); });
  });
  w.state = () => JSON.parse(readFileSync(join(dir, '.eden-serve.json'), 'utf8'));
  t.after(async () => { await w.cli('serve', '--stop'); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
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

// #1313: the owner's card shows the act under way for its newest message from world records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import type {EdgeReceipt} from './contract.ts';
import {DOING_WINDOW_MS, ownerDoing, type DoingMessage, type DoingSources} from './owner-doing.ts';

const W = 'w1', SOUL = 'soul-a';
function world() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE edge_receipts_v1 (world_id TEXT NOT NULL, receipt_id TEXT NOT NULL, soul_id TEXT NOT NULL, capability TEXT NOT NULL, phase TEXT NOT NULL, accepted_tick INTEGER NOT NULL, started_tick INTEGER, ended_tick INTEGER, code TEXT, reason TEXT, program_id TEXT, client_ref TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (world_id, receipt_id));
    CREATE TABLE edge_refusals_v1 (world_id TEXT NOT NULL, at INTEGER NOT NULL, tick INTEGER NOT NULL, soul_id TEXT NOT NULL, verb TEXT NOT NULL, capability TEXT NOT NULL, code TEXT NOT NULL, reason TEXT, x REAL, z REAL);
    CREATE TABLE edge_plans_v1 (world_id TEXT NOT NULL, plan_id TEXT NOT NULL, soul_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (world_id, plan_id)) WITHOUT ROWID;`);
  const receipts = new Map<string, EdgeReceipt>();
  const receipt = (id: string, capability: string, phase: EdgeReceipt['phase'], at: number, extra: Partial<EdgeReceipt> & {clientRef?: string; soul?: string} = {}) => {
    const r: EdgeReceipt = {id, soulId: extra.soul ?? SOUL, capability, phase, acceptedTick: 1, startedTick: null, endedTick: null, code: extra.code ?? null, reason: extra.reason ?? null, programId: null};
    receipts.set(id, r);
    db.prepare('INSERT INTO edge_receipts_v1 (world_id,receipt_id,soul_id,capability,phase,accepted_tick,client_ref,created_at) VALUES (?,?,?,?,?,?,?,?)').run(W, id, r.soulId, capability, phase, 1, extra.clientRef ?? null, at);
    return r;
  };
  const refusal = (capability: string, code: string, reason: string, at: number) => db.prepare('INSERT INTO edge_refusals_v1 (world_id,at,tick,soul_id,verb,capability,code,reason) VALUES (?,?,?,?,?,?,?,?)').run(W, at, 1, SOUL, capability.split(':')[0]!, capability, code, reason);
  const plan = (id: string, body: Record<string, unknown>, created: number, updated: number) => db.prepare('INSERT INTO edge_plans_v1 VALUES (?,?,?,?,?,?,?) ON CONFLICT (world_id, plan_id) DO UPDATE SET state=excluded.state, body=excluded.body, updated_at=excluded.updated_at').run(W, id, SOUL, String(body.state), JSON.stringify({id, ...body}), created, updated);
  let linked: EdgeReceipt | null = null;
  const src: DoingSources = {db, worldId: W, receipt: (_s, id) => receipts.get(id) ?? null, nameOf: id => id === 'place-cottage' ? 'cottage' : null, linked: () => linked};
  return {src, receipts, receipt, refusal, plan, link: (r: EdgeReceipt | null) => {linked = r;}};
}
const delivered = (at: number, more: Partial<DoingMessage> = {}): DoingMessage => ({id: 'm1', state: 'delivered', deliveredAt: at, ...more});

test('P1: the newest act begun since pickup, with its live receipt phase', () => {
  const w = world();
  const r = w.receipt('r1', 'walk:place-cottage', 'started', 1010);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000, {state: 'acknowledged'}), false), {phase: 'running', text: 'walk to cottage'});
  r.phase = 'completed';
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000, {state: 'acknowledged'}), false), {phase: 'done', text: 'walk to cottage'});
  r.phase = 'failed'; r.code = 'walk.stuck'; r.reason = 'no headway (walk.stuck)';
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'failed', text: 'walk to cottage', reason: 'got stuck on the way'});
  r.phase = 'replaced';
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000), false, 1500)?.phase, 'cut');
  w.receipt('r2', 'sit:here', 'waiting', 1020);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'sit down'}, 'the newer act is the one shown');
});

test('P2: a refusal after pickup reads refused with the plain reason; a newer act replaces it', () => {
  const w = world();
  w.receipt('r1', 'walk:place-cottage', 'completed', 1005);
  w.refusal('sit:here', 'pose.no-room', 'There is no room here (pose.no-room).', 1010);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'refused', text: 'sit down', reason: 'no room there'});
  w.receipt('r2', 'rest:here', 'started', 1020);
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000), false, 1500)?.phase, 'running');
  w.refusal('fly:the-moon', 'capability.unknown', '"fly:the-moon" is not an offer on this Soul right now, so nothing was done. Send an offered id; did_you_mean lists the closest.', 1030);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'refused', text: 'fly to the moon', reason: 'not something it can do here'}, 'a sentence for the agent reads in owner words');
});

test('P3: a plan step shows step n of m and its own phase, refused and paused included', () => {
  const w = world();
  const step = (status: string, more: Record<string, unknown> = {}) => ({do: 'walk:place-cottage', state: {status, ...more}});
  w.plan('p1', {state: 'running', current: 1, createdAt: 1010, updatedAt: 1030, steps: [step('done', {capability: 'walk:place-cottage', receipt: 'r1'}), {label: 'rest a while', do: 'rest:here', state: {status: 'running', capability: 'rest:here', receipt: 'r2'}}, step('pending')]}, 1010, 1030);
  w.receipt('r1', 'walk:place-cottage', 'completed', 1011, {clientRef: 'pl:p1:0:0'});
  w.receipt('r2', 'rest:here', 'started', 1025, {clientRef: 'pl:p1:1:0'});
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'rest a while', step: {n: 2, of: 3}}, 'the plan frame names the step; its own acts don\'t displace it');
  w.refusal('sit:here', 'pose.no-room', 'no room', 1040);
  w.plan('p1', {state: 'paused', current: 1, steps: [step('done'), {do: 'sit:here', state: {status: 'failed', code: 'pose.no-room', reason: 'There is no room here (pose.no-room).'}}, step('pending')]}, 1010, 1041);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'refused', text: 'sit down', step: {n: 2, of: 3}, reason: 'no room there'});
  w.plan('p1', {state: 'paused', current: 2, steps: [step('done'), step('done'), step('running')]}, 1010, 1050);
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000), false, 1500)?.phase, 'paused');
  w.receipt('r3', 'wave', 'started', 1060);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'wave'}, 'the Soul\'s own act begun after the plan is newer');
});

test('P3: an act from a plan made before pickup still names its step', () => {
  const w = world();
  w.plan('p0', {state: 'running', current: 0, steps: [{label: 'walk home', do: 'walk:place-cottage', state: {status: 'running'}}, {do: 'rest:here', state: {status: 'pending'}}]}, 500, 500);
  w.receipt('r1', 'walk:place-cottage', 'started', 1010, {clientRef: 'pl:p0:0:1'});
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'walk home', step: {n: 1, of: 2}});
});

test('P4: thinking from pickup until the first act, ack or result, and only while the agent is here', () => {
  const w = world();
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'thinking', since: 1000});
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000), true, 1500), null, 'an away agent gets no thinking claim');
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000, {state: 'acknowledged'}), false), null, 'acknowledged: the agent answered');
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000, {state: 'acknowledged', result: 'Arrived'}), false), null);
  w.refusal('fly:moon', 'capability.unknown', 'not here', 1001);
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000), false, 1500)?.phase, 'refused', 'a refusal is an act record: thinking ends');
});

test('P5: no record, nothing: not picked up, acts from before pickup, another Soul\'s acts', () => {
  const w = world();
  w.receipt('r0', 'walk:place-cottage', 'started', 900);
  w.refusal('sit:here', 'pose.no-room', 'no room', 950);
  w.receipt('rb', 'wave', 'started', 1010, {soul: 'soul-b'});
  assert.equal(ownerDoing(w.src, SOUL, {id: 'm1', state: 'sent'}, false), null);
  assert.equal(ownerDoing(w.src, SOUL, null, false), null);
  assert.equal(ownerDoing(w.src, SOUL, delivered(1000, {state: 'acknowledged'}), false), null);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'thinking', since: 1000});
});

test('P1: a repeat answered with an act begun before pickup shows through the message link', () => {
  const w = world();
  const r = w.receipt('r0', 'walk:place-cottage', 'started', 900);
  w.link(r);
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000, {state: 'acknowledged'}), false), {phase: 'running', text: 'walk to cottage'});
});

test('review: the act line ends with the message: its last act stays, later acts never read as its answer', () => {
  const w = world();
  w.receipt('r1', 'walk:place-cottage', 'completed', 1010);
  const done = delivered(1000, {state: 'acknowledged', acknowledgedAt: 1005, result: 'Arrived', resultAt: 1020, outcome: 'done'});
  assert.deepEqual(ownerDoing(w.src, SOUL, done, false), {phase: 'done', text: 'walk to cottage'});
  w.receipt('r2', 'dance', 'started', 1_000_000);
  w.refusal('sit:here', 'pose.no-room', 'no room', 2_000_000);
  w.plan('p9', {state: 'running', current: 0, steps: [{do: 'rest:here', state: {status: 'running'}}]}, 3_000_000, 3_000_000);
  assert.deepEqual(ownerDoing(w.src, SOUL, done, false), {phase: 'done', text: 'walk to cottage'}, 'still the act that answered it');
  w.link(w.receipts.get('r2')!);
  assert.deepEqual(ownerDoing(w.src, SOUL, done, false), {phase: 'done', text: 'walk to cottage'}, 'a closed message reads no link');
  const closedNoAct = delivered(1000, {state: 'acknowledged', acknowledgedAt: 1001, outcome: 'done'});
  assert.equal(ownerDoing(world().src, SOUL, closedNoAct, false), null, 'closed by its ack with no act: nothing');
});

test('review: a message with no result reads acts for at most DOING_WINDOW_MS after pickup, and thinking ends there too', () => {
  const w = world();
  w.receipt('late', 'dance', 'started', 1000 + DOING_WINDOW_MS + 1);
  const open = delivered(1000, {state: 'acknowledged', acknowledgedAt: 1002});
  assert.equal(ownerDoing(w.src, SOUL, open, false), null);
  w.receipt('r1', 'wave', 'started', 1000 + DOING_WINDOW_MS);
  assert.deepEqual(ownerDoing(w.src, SOUL, open, false), {phase: 'running', text: 'wave'});
  assert.deepEqual(ownerDoing(world().src, SOUL, delivered(1000), false, 1000 + DOING_WINDOW_MS), {phase: 'thinking', since: 1000});
  assert.equal(ownerDoing(world().src, SOUL, delivered(1000), false, 1000 + DOING_WINDOW_MS + 1), null, 'held unanswered past the window: no thinking claim');
});

test('review: plan frames match their own acts exactly, and a Soul reads only its own plans', () => {
  const w = world();
  w.plan('p_1', {state: 'running', current: 0, steps: [{label: 'walk home', do: 'walk:place-cottage', state: {status: 'running', receipt: 'r1'}}]}, 1010, 1010);
  w.receipt('r1', 'walk:place-cottage', 'started', 1011, {clientRef: 'pl:p_1:0:0'});
  w.receipt('rx', 'wave', 'started', 1012, {clientRef: 'pl:pX1:0:0'});
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'wave'}, '`_` is not a wildcard: another ref is not the plan\'s');
  const v = world();
  v.src.db.prepare('INSERT INTO edge_plans_v1 VALUES (?,?,?,?,?,?,?)').run(W, 'p_other', 'soul-b', 'running', JSON.stringify({id: 'p_other', state: 'running', current: 0, steps: [{label: 'secret step', state: {status: 'running'}}]}), 10, 10);
  v.receipt('r1', 'wave', 'started', 1010, {clientRef: 'pl:p_other:0:0'});
  assert.deepEqual(ownerDoing(v.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'wave'}, 'another Soul\'s plan named in a clientRef shows nothing of it');
});

test('review: an act from an older plan takes its phase from the plan record (a `for` step still running)', () => {
  const w = world();
  w.plan('p0', {state: 'running', current: 0, steps: [{label: 'sit a while', do: 'sit:here', for: 60, state: {status: 'running', receipt: 'r1'}}, {do: 'rest:here', state: {status: 'pending'}}]}, 500, 500);
  w.receipt('r1', 'sit:here', 'completed', 1010, {clientRef: 'pl:p0:0:0'});
  assert.deepEqual(ownerDoing(w.src, SOUL, delivered(1000), false, 1500), {phase: 'running', text: 'sit a while', step: {n: 1, of: 2}});
});

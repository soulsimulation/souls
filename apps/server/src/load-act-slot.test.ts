// #1946: the request dispatcher charges an act for its work, not for its wait. An act's charge (the world credit, its
// Soul's bucket, the route's cost estimate) ends at the handler's first yield in both paths, and a Soul waiting for its
// act's commit is still one in flight (`soul.busy`) but makes nobody else contended.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Admission, classify, frameBudgetMs, type Ticket} from './load/admission.ts';

type Turn = Extract<Ticket, {turn: unknown}>;
const act = classify('POST', '/v1/edge/act')!, here = classify('GET', '/v1/edge/here')!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** A handler's synchronous work: the thread is held for `ms` of real time. */
const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* the handler's work */ } };
/** One act as the edge runs it: its turn, the handler's synchronous work, then its wait for the tick's commit. */
async function oneAct(adm: Admission, key: string, handlerMs: number, commitMs: number) {
  const t = adm.request({key, god: false, route: act});
  assert.ok('turn' in t, 'admitted');
  assert.equal(await t.turn, 'run');
  busy(handlerMs);
  await sleep(commitMs);
  t.done();
  return t.waitedMs();
}

test('A1: the queued path charges the handler\'s synchronous work, up to its first yield, not near zero', async () => {
  const adm = new Admission({quietTickMs: () => 0});
  adm.setLoadLevel('red');   // red always queues: the dispatcher runs the act
  await oneAct(adm, 'soul:A', 20, 60);
  const est = adm.estimate(act.id);
  assert.ok(est >= 20 && est < 60, `charged ${est.toFixed(1)} ms for 20 ms of handler and 60 ms of commit wait`);
  adm.close();
});

test('A1: the fast path charges at its first yield, as the queued path does, not when it answers', async () => {
  const adm = new Admission({quietTickMs: () => 0});
  const t = adm.request({key: 'soul:A', god: false, route: act}) as Turn;
  assert.equal(t.waitedMs(), 0, 'a lone act takes the fast path');
  await t.turn; busy(20); await sleep(60); t.done();
  const est = adm.estimate(act.id);
  assert.ok(est >= 20 && est < 60, `charged ${est.toFixed(1)} ms for 20 ms of handler and 60 ms of commit wait`);
  adm.close();
});

test('A2: a Soul waiting for its commit is still one in flight, and makes no other Soul contended', async () => {
  let now = 1000;
  const adm = new Admission({now: () => now, yieldTurn: () => new Promise(r => setImmediate(r)), quietTickMs: () => 0});
  // B's own read cost more than a bucket holds: under contention its next read would be refused `soul.slow-down`
  const b = adm.request({key: 'soul:B', god: false, route: here}) as Turn;
  await b.turn; now += 2500; b.done();
  now += 10_000;   // the world credit is paid back; B's bucket (200 ms/s) still holds less than the read's estimate
  // A's act: its handler's turn, then a commit that has not come yet
  const a = adm.request({key: 'soul:A', god: false, route: act}) as Turn;
  await a.turn; now += 30;
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));   // past its first yield
  assert.ok(adm.committing.has('soul:A') && !adm.outstanding.has('soul:A'), 'A is held in the commit set');
  const again = adm.request({key: 'soul:A', god: false, route: here});
  assert.ok('refusal' in again && again.refusal.code === 'soul.busy', 'A\'s second heavy request is refused soul.busy');
  const b2 = adm.request({key: 'soul:B', god: false, route: here});
  assert.ok('turn' in b2, `B is not contended by A's wait: ${'refusal' in b2 ? b2.refusal.code : ''}`);
  assert.equal(await b2.turn, 'run'); b2.done();
  a.done();
  assert.ok(!adm.committing.has('soul:A') && !adm.outstanding.has('soul:A'), 'A is out once it answers');
  assert.ok('turn' in adm.request({key: 'soul:A', god: false, route: act}), 'and may act again');
  adm.close();
});

test('A3: #1971\'s act (52 ms handler, 47 ms commit wait) at the amber budget: charged its handler, queued under a frame', async () => {
  // #1971's table, n24 spread, mean of the repeats' p50: handler 52 ms; wait 0.5 + commit 47 ms. The amber budget of
  // #2128's 24-Soul arm on the runner: quiet tick 17 ms → 13.2 ms per frame. Three Souls a third of a cycle apart, each
  // acting every 600 ms after its last answer, ask for 2.9 times the budget if an act were charged its handler alone
  const HANDLER = 52, COMMIT = 47, THINK = 600, SOULS = 3, ACTS = 6;
  const adm = new Admission({quietTickMs: () => 17});
  adm.setLoadLevel('amber');
  assert.ok(Math.abs(adm.frameBudget() - frameBudgetMs('amber', 17)) < 1e-9 && Math.abs(adm.frameBudget() - 13.2) < 1e-9);
  const queued: number[] = [];
  await Promise.all(Array.from({length: SOULS}, async (_, i) => {
    await sleep(i * (HANDLER + COMMIT + THINK) / SOULS);
    for (let n = 0; n < ACTS; n++) { queued.push(await oneAct(adm, 'soul:' + i, HANDLER, COMMIT)); await sleep(THINK); }
  }));
  queued.sort((x, y) => x - y);
  const median = queued[queued.length >> 1], est = adm.estimate(act.id);
  console.log(`# A3: ${queued.length} acts, queue median ${median.toFixed(1)} ms, max ${queued[queued.length - 1].toFixed(1)} ms; edge:act estimate ${est.toFixed(1)} ms for a ${HANDLER} ms handler`);
  assert.ok(Math.abs(est - HANDLER) <= 10, `the route's cost estimate ${est.toFixed(1)} ms is within 10 ms of the handler's ${HANDLER} ms`);
  assert.ok(median < 50, `the median queue ${median.toFixed(1)} ms is under one 50 ms frame`);
  adm.close();
});

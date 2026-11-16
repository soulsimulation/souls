// #2556: the load shapes. A1 pure and seeded; A2 the event shape is skewed, spiky and arrives over two minutes; A3 the
// uniform shape is today's --act-sec pace; A4 every number in shapes.json has a source or says "estimate".
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES, schedule, describe } from './shapes.mjs';

test('A1: the same inputs give the same schedule; different seeds differ', () => {
  for (const shape of ['uniform', 'everyday', 'event']) {
    const a = schedule(shape, 100, 600, 7), b = schedule(shape, 100, 600, 7), c = schedule(shape, 100, 600, 8);
    assert.deepEqual(a, b, shape);
    assert.notDeepEqual(a.agents, c.agents, shape);
    assert.equal(JSON.stringify(schedule(shape, 100, 600, 'base')), JSON.stringify(schedule(shape, 100, 600, 'base')), `${shape}, a string seed`);
  }
  // every act is due inside one of its agent's stays, in order
  for (const a of schedule('event', 100, 600, 7).agents) {
    for (let k = 1; k < a.acts.length; k++) assert.ok(a.acts[k].at >= a.acts[k - 1].at);
    for (const x of a.acts) assert.ok(a.stays.some(([s, e]) => s <= x.at && x.at < e), `agent ${a.i} act at ${x.at}`);
  }
});

test('A2: event at 100 agents over 10 minutes: the busiest tenth make 40 to 60 % of acts, a one-second burst at least 4x the mean, arrivals over the first 2 minutes', () => {
  // seeds 1 to 40, none chosen: the bars on the shape's summary over the seeds; every seed's arrivals
  const seeds = Array.from({ length: 40 }, (_, k) => k + 1), sums = seeds.map((k) => schedule('event', 100, 600, k).summary);
  const mean = (f) => sums.reduce((s, x) => s + f(x), 0) / sums.length;
  const share = mean((s) => s.topTenthShare), burst = mean((s) => s.burstToMean);
  const inBand = sums.filter((s) => s.topTenthShare >= 0.4 && s.topTenthShare <= 0.6 && s.burstToMean >= 4).length;
  console.log(`event x40 seeds: busiest tenth ${share.toFixed(3)}, burst ${burst.toFixed(2)}x mean, ${mean((s) => s.meanPerS).toFixed(2)} acts/s; both bars on ${inBand} of 40 seeds alone`);
  console.log(describe(sums[0], 'event, seed 1'));
  assert.ok(share >= 0.4 && share <= 0.6, `busiest tenth ${share}`);
  assert.ok(burst >= 4, `burst ${burst}x`);
  for (const s of sums) {
    const ramp = s.arrivals.perMinute[0] + s.arrivals.perMinute[1];
    assert.equal(s.present.atStart, 40, 'half of the 80 present from the start');
    assert.equal(ramp, 40, 'the other half arrive in the first 2 minutes');
    assert.ok(s.arrivals.perMinute[0] >= 12 && s.arrivals.perMinute[1] >= 12, `spread over both minutes: ${s.arrivals.perMinute}`);
    assert.deepEqual(s.arrivals.perMinute.slice(2, 5), [0, 0, 0], 'none between the ramp and the first wave');
    assert.ok(s.arrivals.maxPerS <= 2, `at most 2 a second: ${s.arrivals.maxPerS}`);
  }
});

// today's schedule is the paced loop itself (tools/playtest/eval/load.mjs, --act-sec), run here on a mocked clock with a
// world that answers at once, so its act times are the schedule's alone
async function pacedActsPerSecond(n, seconds, actSec) {
  const { pacedLoop } = await import('../../../playtest/eval/load.mjs');
  const { rng } = await import('../../../playtest/lib/hash.mjs');
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const counts = { cmds: 0, acts: 0, refused: 0, closed: 0 }, acts = [];
    const cli = async (_f, args) => ({ code: 0, data: args[0] === 'find' ? { found: [{ act: 'walk:x', verb: 'walk' }] } : {} });
    let done = false;
    const all = Promise.all(Array.from({ length: n }, (_, k) => pacedLoop({ folder: `s${k}`, until: seconds * 1000, r: rng(1000 + k), counts, acts, actSec, cli }))).then(() => { done = true; });
    while (!done) { mock.timers.tick(100); await new Promise((r) => setImmediate(r)); }
    await all;
    return acts.length / seconds;
  } finally { mock.timers.reset(); }
}

test('A3: uniform is today\'s --act-sec schedule within 5 % on acts a second', async () => {
  for (const [n, seconds, actSec] of [[100, 600, 10], [24, 300, 5]]) {
    const today = await pacedActsPerSecond(n, seconds, actSec), shape = schedule('uniform', n, seconds, 1, { actSec }).summary.meanPerS;
    console.log(`${n} Souls, ${seconds} s, --act-sec ${actSec}: paced loop ${today.toFixed(3)}/s, uniform ${shape}/s`);
    assert.ok(Math.abs(shape - today) / today <= 0.05, `${shape} against ${today}`);
  }
  const s = schedule('uniform', 100, 600, 1).summary;
  assert.equal(s.present.ever, 100); assert.equal(s.arrivals.n, 0);
  assert.ok(Math.abs(s.meanPerS - 100 / 10) / 10 <= 0.05, 'the default pace is one act per 10 s per Soul');
});

test('A4: every number in shapes.json names a source or says "estimate"', () => {
  const bare = [], sourced = [];
  const walk = (x, path, src) => {
    if (typeof x === 'number') (src ? sourced : bare).push(path);
    else if (Array.isArray(x)) x.forEach((y, k) => walk(y, `${path}[${k}]`, src));
    else if (x && typeof x === 'object') {
      const own = typeof x.source === 'string' && 'value' in x ? x.source : null;
      if (own != null) assert.ok(/estimate|\.json|\.mjs|\.md|#\d+|bench/.test(own), `${path}: the source "${own}" names nothing`);
      for (const [k, y] of Object.entries(x)) walk(y, `${path}.${k}`, src || (own != null && k === 'value'));
    }
  };
  walk(SHAPES, 'shapes', false);
  assert.deepEqual(bare, [], 'numbers without a source');
  assert.ok(sourced.length > 40, `${sourced.length} sourced numbers`);
});

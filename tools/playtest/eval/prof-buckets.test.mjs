// #2508: the act meter's classifier puts each clock-thread sample in one named group (#2470's names, the tick's route
// searches split by kind), divides the act groups by the acts answered, and names long holds by their main source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketProfile, perAct } from './prof-buckets.mjs';
import { renderMeter } from './load.mjs';

/** A profile from stacks (outermost first), each sampled `n` times 1 ms apart; `idle` breaks a busy run. */
function profileOf(runs) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, children: [] }], samples = [], timeDeltas = [];
  const child = (parent, name) => {
    let n = nodes.find((x) => x.parentId === parent && x.callFrame.functionName === name);
    if (!n) { n = { id: nodes.length + 1, parentId: parent, callFrame: { functionName: name, url: 'file:///repo/x.ts', lineNumber: 0 }, children: [] }; nodes.push(n); nodes.find((x) => x.id === parent).children.push(n.id); }
    return n.id;
  };
  for (const [stack, k] of runs) { let at = 1; for (const f of stack) at = child(at, f); for (let i = 0; i < k; i++) { samples.push(at); timeDeltas.push(1000); } }
  return { nodes: nodes.map(({ parentId, ...n }) => n), samples, timeDeltas };
}

test('#2508: every sample goes to one group; the tick\'s route searches by kind; per act and long holds', () => {
  const p = profileOf([
    [['actWork', 'bindOne'], 30], [['actWork', 'routeProblem', 'canPerform'], 10], [['actWork', 'launch'], 8],
    [['tickOnce', 'drainInputs', 'plan', 'planWalk'], 40], [['tickOnce', 'stepWalk', 'retryPeople', 'routeAround'], 20],
    [['tickOnce', 'stepWalk', 'planWalk'], 12], [['tickOnce', 'stepWalk', 'nextChunk', 'planWalk'], 6], [['tickOnce', 'drainInputs', 'perform'], 4],
    [['tickOnce', 'advance'], 50], [['(idle)'], 5], [['tickOnce', 'syncPaged'], 9], [['tickOnce', 'navWarmV1'], 3], [['(garbage collector)'], 2],
  ]);
  const b = bucketProfile(p, '/repo');
  assert.deepEqual(b.groups, { 'act.bind': 30, 'act.check': 10, 'act.handler-other': 8, 'route.first': 40, 'route.people': 20, 'route.detour': 12, 'route.chunk': 6, 'act.commit(tick)': 4, tick: 50, 'nav.sync': 9, 'nav.audit': 3, gc: 2 });
  assert.equal(b.busyMs, 194); assert.equal(b.totalMs, 199);
  // one hold before the idle (180 ms, mostly the tick) and none after (14 ms)
  assert.deepEqual(b.holds, { overMs: 100, n: 1, ms: 180, bySource: { tick: { n: 1, ms: 180, maxMs: 180 } } });
  const q = perAct(b, 2);
  assert.equal(q['act.bind'], 15); assert.equal(q['route.first'], 20); assert.equal(q['act.route(tick)'], 39); assert.equal(q.handlerSide, 24); assert.equal(q['route.other'], 0);
  const lines = renderMeter({ acts: 2, parts: { handler: 25, bind: 15, check: 5, route: 2, wait: 3, commit: 2 }, charged: { acts: 2, msPerAct: 24 }, profile: { ...b, perAct: q } }).join('\n');
  assert.match(lines, /\| route\.people \| 10 \|/);
  assert.match(lines, /sum to 24 ms per act; admission charged 24 ms per act \(0 %\)/);
});

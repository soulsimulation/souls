// #2508: the act meter's classifier puts each clock-thread sample in one named group (#2470's names, the tick's route
// searches split by kind), divides the act groups by the acts answered, and names long holds by their main source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketProfile, perAct } from './prof-buckets.mjs';
import { renderMeter, scanSitesOf } from './load.mjs';

/** A profile from stacks (outermost first), each sampled `n` times 1 ms apart; `idle` breaks a busy run. */
function profileOf(runs) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, children: [] }], samples = [], timeDeltas = [];
  const child = (parent, name) => {
    // a frame is `name` or `name@repo/path` (then its url is that file)
    let n = nodes.find((x) => x.parentId === parent && x.key === name);
    if (!n) { const [fn, path = 'x.ts'] = name.split('@'); n = { id: nodes.length + 1, parentId: parent, key: name, callFrame: { functionName: fn, url: `file:///repo/${path}`, lineNumber: 0 }, children: [] }; nodes.push(n); nodes.find((x) => x.id === parent).children.push(n.id); }
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
  assert.deepEqual(b.groups, { 'act.bind': 30, 'act.check': 10, 'act.handler-other': 8, 'route.first': 40, 'route.people': 20, 'route.detour': 12, 'route.chunk': 6, 'act.commit(tick)': 4, tick: 50, 'nav.sync': 9, 'nav.warm': 3, gc: 2 });
  assert.equal(b.busyMs, 194); assert.equal(b.totalMs, 199);
  // one hold before the idle (180 ms, mostly the tick) and none after (14 ms)
  assert.deepEqual(b.holds, { overMs: 100, n: 1, ms: 180, bySource: { tick: { n: 1, ms: 180, maxMs: 180 } } });
  const q = perAct(b, 2);
  assert.equal(q['act.bind'], 15); assert.equal(q['route.first'], 20); assert.equal(q['act.route(tick)'], 39); assert.equal(q.handlerSide, 24); assert.equal(q['route.other'], 0);
  const lines = renderMeter({ acts: 2, parts: { handler: 25, bind: 15, check: 5, route: 2, wait: 3, commit: 2 }, charged: { acts: 2, msPerAct: 24 }, profile: { ...b, perAct: q } }).join('\n');
  assert.match(lines, /\| route\.people \| 10 \|/);
  assert.match(lines, /sum to 24 ms per act; admission charged 24 ms per act \(0 %\)/);
});

test('#2533: nav.sync by who asked: the action step a tick ran it in, or the server frame outside a tick', () => {
  const S = 'navChanged@mars/viewer/engine/spatial/service.ts', R = 'mars/viewer/engine/runtime/runtime.ts';
  const p = profileOf([
    [['tickOnce@apps/server/src/world.ts', `stepInner@${R}`, 'step@mars/viewer/engine/locomotion/walk.ts', 'planWalk@mars/viewer/engine/locomotion/walk.ts', S], 6],
    [['actWork@apps/server/src/edge/ledger/ledger.ts', 'routeProblem@mars/viewer/engine/x/check.ts', S], 4],
  ]);
  assert.deepEqual(bucketProfile(p, '/repo').navSyncBy, [
    { where: 'tick: stepInner > step walk.ts:1', caller: 'planWalk walk.ts:1', ms: 6 },
    { where: 'outside a tick: actWork ledger.ts:1', caller: 'routeProblem check.ts:1', ms: 4 },
  ]);
});

test('#2533: an [l4] line\'s scan sites, a caller with a space and an anonymous frame\'s URL reduced to its file', () => {
  assert.deepEqual(scanSitesOf('planWalk walk.ts:261=100 async actWork ledger.ts:88=5 file:///a/b/z.ts:12:3=7'), [['planWalk walk.ts:261', 100], ['async actWork ledger.ts:88', 5], ['z.ts:12:3', 7]]);
});

test('#2592: step0 splits a hold into tasks, counts long tasks by group and names the longest task\'s frames', () => {
  // a timer task (GC inside it stays in it), then an immediate task right after it with no idle between, then idle
  const p = profileOf([
    [['processTimers', 'tickOnce@apps/server/src/world.ts', 'navWarmV1@mars/a.ts'], 700], [['(garbage collector)'], 20],
    [['processTimers', 'tickOnce@apps/server/src/world.ts', 'navWarmV1@mars/a.ts'], 100],
    [['processImmediate', 'actWork@apps/server/src/edge/ledger/ledger.ts', 'bindOne'], 400], [['(idle)'], 5],
  ]);
  const s = bucketProfile(p, '/repo').step0;
  assert.deepEqual(s.tasksOver, { 50: 2, 100: 2, 250: 2, 1000: 0 });
  assert.deepEqual(s.taskHist['nav.warm'], { n: 1, ms: 820, maxMs: 820, over50: 1, over100: 1, over250: 1, over1000: 0 });
  assert.deepEqual(s.taskHist['act.bind'], { n: 1, ms: 400, maxMs: 400, over50: 1, over100: 1, over250: 1, over1000: 0 });
  assert.deepEqual(s.holdsOver1s, [{ atS: 0, ms: 1220, tasks: 2, longestTaskMs: 820, groups: [['nav.warm', 800], ['act.bind', 400], ['gc', 20]] }]);
  assert.deepEqual(s.longestTasks[0].frames, [['tickOnce src/world.ts:1', 800], ['navWarmV1 mars/a.ts:1', 800]]);
});

test('#2592: nav.audit split into nav.warm, nav.tile and nav.label; each task of 100 ms or more attributed to its cause', () => {
  const W = 'apps/server/src/world.ts', SP = 'mars/viewer/engine/spatial', T = `tickOnceInner@${W}`, R = 'stepInner@mars/viewer/engine/runtime/runtime.ts';
  const P = 'mars/viewer/engine/people.ts', idle = [['(idle)'], 5];
  const p = profileOf([
    // the budgeted audit: a tile built inside connectivity's compile, under navWarmV1 (asked by the bridge's navStep)
    [['processTimers', T, 'navStep@apps/server/src/god/engine-bridge.ts', 'navWarmV1@packages/engine-mars/src/engine.ts', `update@${SP}/connectivity.ts`, `compile@${SP}/connectivity.ts`, `fineTileSteps@${SP}/tiled.ts`], 120], idle,
    // a fine tile built on demand by a walker's page sync (inside syncPaged, still a tile)
    [['processTimers', T, 'stepWalk@mars/viewer/engine/locomotion/walk.ts', 'enterLeg@mars/viewer/engine/locomotion/walk.ts', `syncPaged@${SP}/service.ts`, `fineTile@${SP}/tiled.ts`, `drain@${SP}/tiled.ts`, `fineTileSteps@${SP}/tiled.ts`], 150], idle,
    // a tile's labels on demand: a label-cache miss in an act's connectivity read (the engine's wrapper is skipped)
    [['processImmediate', 'actWork@apps/server/src/edge/ledger/ledger.ts', 'goal@apps/server/src/god/nav.ts', 'navCheckV1@packages/engine-mars/src/engine.ts', `check@${SP}/connectivity.ts`, `labelComponents@${SP}/connectivity.ts`], 110], idle,
    // the rest of the tick, one dominant path: tickOnceInner > stepInner > stepPeople (130 of 170) > crowd (100 of 170)
    [['processTimers', T, R, `stepPeople@${P}`, `crowd@${P}`], 100], [['processTimers', T, R, `stepPeople@${P}`, `other@${P}`], 30],
    [['processTimers', T, R, 'stepDoors@mars/viewer/engine/doors.ts'], 40], idle,
    // the rest of the tick, no dominant child: the frame just under the tick
    [['processTimers', T, R, `a@${P}`], 40], [['processTimers', T, R, `b@${P}`], 30], [['processTimers', T, R, `c@${P}`], 30], idle,
    // under 100 ms: not attributed
    [['processTimers', T, 'navStep@apps/server/src/god/engine-bridge.ts', 'navWarmV1@packages/engine-mars/src/engine.ts'], 60],
  ]);
  const b = bucketProfile(p, '/repo');
  assert.deepEqual([b.groups['nav.warm'], b.groups['nav.tile'], b.groups['nav.label'], b.groups['nav.sync']], [180, 150, 110, undefined]);
  assert.equal(b.groups['nav.audit'], undefined);
  assert.equal(perAct(b, 1).navAuditMsPerSec, Math.round(10 * 440 / (b.totalMs / 1000)) / 10);   // the old group: the three summed
  const s = b.step0;
  assert.deepEqual(s.longTasks.map((t) => [t.group, t.cause, t.ms]), [
    ['nav.warm', 'navStep god/engine-bridge.ts:1', 120],
    ['nav.tile', 'enterLeg locomotion/walk.ts:1', 150],
    ['nav.label', 'goal god/nav.ts:1', 110],
    ['tick', 'crowd engine/people.ts:1', 170],
    ['tick', 'stepInner runtime/runtime.ts:1', 100],
  ]);
  assert.deepEqual(s.causes.tick, [['crowd engine/people.ts:1', 1, 170], ['stepInner runtime/runtime.ts:1', 1, 100]]);
  assert.deepEqual(s.causes['nav.tile'], [['enterLeg locomotion/walk.ts:1', 1, 150]]);
  // the compact record keeps the task's heaviest path (app frames), so a later read needs no .cpuprofile
  assert.deepEqual(s.longTasks[3].path, [['tickOnceInner src/world.ts:1', 170], ['stepInner runtime/runtime.ts:1', 170], ['stepPeople engine/people.ts:1', 130], ['crowd engine/people.ts:1', 100]]);
});

// #2508 (the #2414 bucket classifier, kept with #2470's group names): every main-thread sample of the world's V8
// .cpuprofile is put in one named group, so an act's clock cost reads by part:
//   act.bind, act.check, act.handler-other   the act request (POST /v1/edge/act) by what is on the stack
//   route.first, route.people, route.detour, route.chunk, route.other
//                                            the route searches a tick makes (#2470's act.route(tick), split): a walk's
//                                            first plan, a re-plan around people (retryPeople), a re-plan from inside a
//                                            walk's step (a detour, stepping aside, a wait's re-plan), a paged walk's next
//                                            chunk, and any other
//   act.commit(tick), tick                   the tick applying inputs (drainInputs), and the rest of the tick
//   nav.sync, nav.audit                      the planner's page sync and scans (syncPaged, navScan, navChanged), and the
//                                            connectivity audit (navWarmV1, fineTileSteps, labelComponents)
//   gc, snapshot, req <route>, req (middleware/unknown), other <frame>
// #2533: nav.sync's samples also by who asked (`navSyncBy`): the action step or pass a tick ran the sync in, or the server
// frame outside a tick, and the first frame outside the spatial service.
// Long holds: runs of busy samples (no idle between) of at least `holdMs`, each named by the group that took most of it.
import { readFileSync } from 'node:fs';

const ROUTE_RE = /app\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)/i;
const SNAP = new Set(['captureCheckpoint', 'captureSnapshot', 'schedulePeriodicSnapshot', 'snapshotView', 'writeSnapshot', 'persistSnapshot']);
const AUDIT = new Set(['navWarmV1', 'fineTileSteps', 'labelComponents']);
const SYNC = new Set(['navScan', 'syncPaged', 'navChanged']);
const BIND = new Set(['bindOne', 'bindsCore', 'bindsTail', 'binds']);
const CHECK = new Set(['canPerform', 'routeProblem', 'previewAdmission', 'offerGate']);
const ROUTE = new Set(['planWalk', 'routeAround', 'retryPeople', 'goalNear', 'gridsWithObstacles', 'focusPage', 'planRoute', 'pagedRoute']);
/** Innermost first: the walk frame that decides which kind of tick-side route search a sample is. */
const ROUTE_KIND = { retryPeople: 'route.people', nextChunk: 'route.chunk', stepWalk: 'route.detour', plan: 'route.first' };
const TICK = new Set(['tickOnceInner', 'tickOnce', 'advanceStep']);
/** The act path's async functions in the ledger: a sample resumed inside one of them (after an await, so the route's frame
 *  is no longer on the stack) and under no other route is still the act's handler. */
const ACT_FN = new Set(['actWork', 'actOnce', 'launch', 'acceptInvite', 'openShared', 'performBodies', 'offerGate']);
const BREAK = new Set(['(idle)', '(program)', '(root)']);
/** The groups a report lists for an act, in order (the clock cost of one act, by part). */
export const ACT_GROUPS = ['act.bind', 'act.check', 'act.handler-other', 'route.first', 'route.people', 'route.detour', 'route.chunk', 'route.other', 'act.commit(tick)'];

/** The profile `p` (parsed), its samples in groups. `repo`: the server's checkout, to name request routes and frames. */
export function bucketProfile(p, repo, { holdMs = 100 } = {}) {
  const byId = new Map(p.nodes.map((n) => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const relOf = (u) => String(u || '').replace(/^file:\/\//, '').split(repo + '/').pop();
  const lines = new Map();
  const routeAt = (url, line) => {
    const rel = relOf(url); if (!/^apps\/server\/src\//.test(rel)) return null;
    let ls = lines.get(rel); if (ls === undefined) { try { ls = readFileSync(repo + '/' + rel, 'utf8').split('\n'); } catch { ls = null; } lines.set(rel, ls); }
    if (!ls) return null;
    for (const k of [line, line - 1]) { const m = ROUTE_RE.exec(ls[k] ?? ''); if (m) return `${m[1].toUpperCase()} ${m[2]}`; }
    return null;
  };
  const memo = new Map();
  const classify = (leafId) => {
    if (memo.has(leafId)) return memo.get(leafId);
    const ids = []; for (let x = leafId; x != null; x = parent.get(x)) ids.push(x);
    const frames = ids.map((id) => byId.get(id).callFrame), names = new Set(frames.map((f) => f.functionName));
    let route = null, req = false, tick = false, drain = false, outer = null;
    for (let j = frames.length - 1; j >= 0; j--) {
      const f = frames[j], rel = relOf(f.url);
      const r = routeAt(f.url, f.lineNumber); if (r) route = r;
      if (/hono/.test(rel) || /^apps\/server\/src\/(http|load\/admission)\.ts$/.test(rel)) req = true;
      if (TICK.has(f.functionName)) tick = true;
      if (f.functionName === 'drainInputs') drain = true;
      if (!outer && /^(apps|packages|mars)\//.test(rel)) outer = `${f.functionName || '(anon)'} ${rel}:${f.lineNumber + 1}`;
    }
    const any = (s) => { for (const n of s) if (names.has(n)) return true; return false; };
    const routeKind = () => { for (const f of frames) { const k = ROUTE_KIND[f.functionName]; if (k) return k; } return 'route.other'; };
    let g;
    if (frames[0].functionName === '(garbage collector)') g = 'gc';
    else if (any(SNAP)) g = 'snapshot';
    else if (any(AUDIT)) g = 'nav.audit';
    else if (any(SYNC)) g = 'nav.sync';
    else if (route === 'POST /v1/edge/act' || (!tick && !route && any(ACT_FN))) g = any(BIND) ? 'act.bind' : any(CHECK) ? 'act.check' : 'act.handler-other';
    else if (tick) g = any(ROUTE) ? routeKind() : drain ? 'act.commit(tick)' : 'tick';
    else if (route) g = 'req ' + route;
    else if (req) g = 'req (middleware/unknown)';
    else g = 'other ' + (outer ?? frames[0].functionName);
    memo.set(leafId, g); return g;
  };
  // #2533: a nav.sync sample by who asked: the first frame outside the spatial service (the caller), and either the action
  // step or the pass a tick ran it in (the frame runtime.ts called), or, outside a tick, the innermost server frame
  const syncMemo = new Map();
  const at = (f) => `${f.functionName || '(anon)'} ${relOf(f.url).split('/').pop()}:${f.lineNumber + 1}`;
  const syncWhere = (leafId) => {
    if (syncMemo.has(leafId)) return syncMemo.get(leafId);
    const frames = []; for (let x = leafId; x != null; x = parent.get(x)) frames.push(byId.get(x).callFrame);
    const rels = frames.map((f) => relOf(f.url));
    const caller = frames.find((f, j) => /^(apps|packages|mars)\//.test(rels[j]) && !rels[j].endsWith('/spatial/service.ts'));
    const rt = rels.findIndex((r) => r.endsWith('/engine/runtime/runtime.ts')), srv = rels.findIndex((r) => r.startsWith('apps/server/src/'));
    const where = rt >= 0 ? `tick: ${frames[rt].functionName || '(anon)'} > ${rt > 0 ? at(frames[rt - 1]) : '-'}` : srv >= 0 ? `outside a tick: ${at(frames[srv])}` : 'outside a tick: -';
    const k = `${where} | ${caller ? at(caller) : '-'}`; syncMemo.set(leafId, k); return k;
  };
  const syncBy = new Map();
  const tot = new Map(), holds = [];
  // #2592 Step 0 (measurement only): JS tasks, a run of busy samples under one child of (root) (GC samples stay in the
  // task they interrupt). A loop turn is at least as long as its longest task, so these are a lower bound on loop delay.
  const rootChild = (id) => { let x = id; while (parent.get(x) != null && parent.get(parent.get(x)) != null) x = parent.get(x); return x; };
  const appChain = (id) => { const out = []; for (let x = id; x != null; x = parent.get(x)) { const f = byId.get(x).callFrame, rel = relOf(f.url); if (/^(apps|packages|mars)\//.test(rel)) out.push(`${f.functionName || '(anon)'} ${rel.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`); } return out.reverse(); };
  const tasks = []; let task = null, t = 0;
  const closeTask = () => { if (task) { tasks.push(task); if (cur) { cur.tasks++; cur.longestTask = Math.max(cur.longestTask, task.ms); } } task = null; };
  let cur = null, busy = 0, total = 0;
  const close = () => { closeTask(); if (cur && cur.ms >= holdMs) holds.push(cur); cur = null; };
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000; total += dt; t += dt;
    const node = byId.get(p.samples[i]); if (BREAK.has(node.callFrame.functionName)) { close(); continue; }
    busy += dt; const g = classify(node.id);
    tot.set(g, (tot.get(g) ?? 0) + dt);
    if (g === 'nav.sync') { const k = syncWhere(node.id); syncBy.set(k, (syncBy.get(k) ?? 0) + dt); }
    if (!cur) cur = { at: t - dt, ms: 0, by: new Map(), tasks: 0, longestTask: 0 }; cur.ms += dt; cur.by.set(g, (cur.by.get(g) ?? 0) + dt);
    const rc = g === 'gc' && task ? task.root : rootChild(node.id);
    if (task && task.root !== rc) closeTask();
    if (!task) task = { at: t - dt, root: rc, ms: 0, by: new Map(), leaf: new Map() };
    task.ms += dt; task.by.set(g, (task.by.get(g) ?? 0) + dt); if (g !== 'gc') task.leaf.set(node.id, (task.leaf.get(node.id) ?? 0) + dt);
  }
  close();
  const r1 = (x) => Math.round(10 * x) / 10;
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([g, ms]) => [g, r1(ms)]);
  const mainOf = (m) => top(m, 1)[0]?.[0] ?? '-';
  // the frames a task spent most in: inclusive ms per app frame on its stacks
  const framesOf = (tk, k) => { const inc = new Map(); for (const [leaf, ms] of tk.leaf) for (const f of new Set(appChain(leaf))) inc.set(f, (inc.get(f) ?? 0) + ms); return top(inc, k); };
  const BANDS = [50, 100, 250, 1000];
  const taskHist = {}; for (const tk of tasks) { if (tk.ms < BANDS[0]) continue; const g = mainOf(tk.by), e = taskHist[g] ??= { n: 0, ms: 0, maxMs: 0, ...Object.fromEntries(BANDS.map((b) => [`over${b}`, 0])) }; e.n++; e.ms += tk.ms; e.maxMs = Math.max(e.maxMs, tk.ms); for (const b of BANDS) if (tk.ms >= b) e[`over${b}`]++; }
  for (const e of Object.values(taskHist)) { e.ms = r1(e.ms); e.maxMs = r1(e.maxMs); }
  const step0 = {
    tasksOver: Object.fromEntries(BANDS.map((b) => [b, tasks.filter((tk) => tk.ms >= b).length])),
    taskHist: Object.fromEntries(Object.entries(taskHist).sort((a, b) => b[1].ms - a[1].ms)),
    holdsOver1s: holds.filter((h) => h.ms >= 1000).map((h) => ({ atS: r1(h.at / 1000), ms: r1(h.ms), tasks: h.tasks, longestTaskMs: r1(h.longestTask), groups: top(h.by, 5) })),
    longestTasks: [...tasks].sort((a, b) => b.ms - a.ms).slice(0, 25).map((tk) => ({ atS: r1(tk.at / 1000), ms: r1(tk.ms), groups: top(tk.by, 4), frames: framesOf(tk, 12) })),
  };
  // #2597 Step 0 (measurement only): act.bind tasks of 100 ms or more, their frames summed (inclusive, per task), and each
  // one's heaviest path (from its root, the heaviest child at every step: app frames only, with their inclusive ms)
  const bindTasks = tasks.filter((tk) => tk.ms >= 100 && mainOf(tk.by) === 'act.bind');
  const heavy = (tk) => {
    const inc = new Map(); for (const [leaf, ms] of tk.leaf) for (let x = leaf; x != null; x = parent.get(x)) inc.set(x, (inc.get(x) ?? 0) + ms);
    const out = []; let x = tk.root;
    while (x != null) { const f = byId.get(x).callFrame, rel = relOf(f.url); if (/^(apps|packages|mars)\//.test(rel)) out.push([`${f.functionName || '(anon)'} ${rel.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`, r1(inc.get(x) ?? 0)]);
      let best = null, bm = 0; for (const c of byId.get(x).children ?? []) { const m = inc.get(c) ?? 0; if (m > bm) { bm = m; best = c; } } x = best; }
    return out.slice(0, 70);
  };
  const aggInc = new Map(), aggN = new Map(); for (const tk of bindTasks) { const inc = new Map(); for (const [leaf, ms] of tk.leaf) for (const f of new Set(appChain(leaf))) inc.set(f, (inc.get(f) ?? 0) + ms); for (const [f, ms] of inc) { aggInc.set(f, (aggInc.get(f) ?? 0) + ms); aggN.set(f, (aggN.get(f) ?? 0) + 1); } }
  step0.bindTasks = { n: bindTasks.length, ms: r1(bindTasks.reduce((s, tk) => s + tk.ms, 0)), frames: top(aggInc, 90).map(([f, ms]) => [f, ms, aggN.get(f)]),
    each: [...bindTasks].sort((a, b) => b.ms - a.ms).slice(0, 30).map((tk) => ({ atS: r1(tk.at / 1000), ms: r1(tk.ms), groups: top(tk.by, 4), path: heavy(tk) })) };
  const bySource = new Map();
  for (const h of holds) { const [src] = [...h.by].sort((a, b) => b[1] - a[1])[0]; const e = bySource.get(src) ?? { n: 0, ms: 0, maxMs: 0 }; e.n++; e.ms += h.ms; e.maxMs = Math.max(e.maxMs, h.ms); bySource.set(src, e); }
  return {
    totalMs: r1(total), busyMs: r1(busy),
    groups: Object.fromEntries([...tot.entries()].sort((a, b) => b[1] - a[1]).map(([g, ms]) => [g, r1(ms)])),
    navSyncBy: [...syncBy].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, ms]) => { const [where, caller] = k.split(' | '); return { where, caller, ms: r1(ms) }; }),
    holds: { overMs: holdMs, n: holds.length, ms: r1(holds.reduce((s, h) => s + h.ms, 0)), bySource: Object.fromEntries([...bySource].sort((a, b) => b[1].ms - a[1].ms).map(([g, e]) => [g, { n: e.n, ms: r1(e.ms), maxMs: r1(e.maxMs) }])) },
    step0,
  };
}

/** Per act: each act group's clock ms divided by the acts the world answered in the profiled window (`acts`), the
 *  tick-side route total (#2470's act.route(tick)), and the planner's sync and audit per second of the window. */
export function perAct(b, acts) {
  const r1 = (x) => Math.round(10 * x) / 10, g = (k) => b.groups[k] ?? 0;
  const per = Object.fromEntries(ACT_GROUPS.map((k) => [k, acts ? r1(g(k) / acts) : null]));
  const route = ['route.first', 'route.people', 'route.detour', 'route.chunk', 'route.other'].reduce((s, k) => s + g(k), 0);
  const sec = b.totalMs / 1000;
  return { acts, ...per, 'act.route(tick)': acts ? r1(route / acts) : null, handlerSide: acts ? r1((g('act.bind') + g('act.check') + g('act.handler-other')) / acts) : null,
    navSyncMsPerSec: sec ? r1(g('nav.sync') / sec) : null, navAuditMsPerSec: sec ? r1(g('nav.audit') / sec) : null, busyShare: b.totalMs ? Math.round(1000 * b.busyMs / b.totalMs) / 1000 : null };
}

export const readProfile = (file) => JSON.parse(readFileSync(file, 'utf8'));

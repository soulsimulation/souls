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
/** #2528: functions whose inclusive clock ms an act's samples (act.*) spend under them, whichever group a sample is in. */
export const UNDER = ['explicitPlaceCapability', 'offeredWalkObject', 'knownBootPlaces', 'strictCheck', 'resolvePlaceForVerb', 'resolveBootPlace'];
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
  const tot = new Map(), under = new Map(), holds = [];
  let cur = null, busy = 0, total = 0;
  const close = () => { if (cur && cur.ms >= holdMs) holds.push(cur); cur = null; };
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000; total += dt;
    const node = byId.get(p.samples[i]); if (BREAK.has(node.callFrame.functionName)) { close(); continue; }
    busy += dt; const g = classify(node.id);
    tot.set(g, (tot.get(g) ?? 0) + dt);
    if (g.startsWith('act.')) { const on = new Set(); for (let x = node.id; x != null; x = parent.get(x)) on.add(byId.get(x).callFrame.functionName); for (const f of UNDER) if (on.has(f)) under.set(f, (under.get(f) ?? 0) + dt); }
    if (!cur) cur = { ms: 0, by: new Map() }; cur.ms += dt; cur.by.set(g, (cur.by.get(g) ?? 0) + dt);
  }
  close();
  const r1 = (x) => Math.round(10 * x) / 10;
  const bySource = new Map();
  for (const h of holds) { const [src] = [...h.by].sort((a, b) => b[1] - a[1])[0]; const e = bySource.get(src) ?? { n: 0, ms: 0, maxMs: 0 }; e.n++; e.ms += h.ms; e.maxMs = Math.max(e.maxMs, h.ms); bySource.set(src, e); }
  return {
    totalMs: r1(total), busyMs: r1(busy),
    groups: Object.fromEntries([...tot.entries()].sort((a, b) => b[1] - a[1]).map(([g, ms]) => [g, r1(ms)])),
    under: Object.fromEntries(UNDER.map((f) => [f, r1(under.get(f) ?? 0)])),
    holds: { overMs: holdMs, n: holds.length, ms: r1(holds.reduce((s, h) => s + h.ms, 0)), bySource: Object.fromEntries([...bySource].sort((a, b) => b[1].ms - a[1].ms).map(([g, e]) => [g, { n: e.n, ms: r1(e.ms), maxMs: r1(e.maxMs) }])) },
  };
}

/** Per act: each act group's clock ms divided by the acts the world answered in the profiled window (`acts`), the
 *  tick-side route total (#2470's act.route(tick)), and the planner's sync and audit per second of the window. */
export function perAct(b, acts) {
  const r1 = (x) => Math.round(10 * x) / 10, g = (k) => b.groups[k] ?? 0;
  const per = Object.fromEntries(ACT_GROUPS.map((k) => [k, acts ? r1(g(k) / acts) : null]));
  const route = ['route.first', 'route.people', 'route.detour', 'route.chunk', 'route.other'].reduce((s, k) => s + g(k), 0);
  const sec = b.totalMs / 1000;
  return { acts, ...per, under: Object.fromEntries(Object.entries(b.under ?? {}).map(([f, ms]) => [f, acts ? r1(ms / acts) : null])), 'act.route(tick)': acts ? r1(route / acts) : null, handlerSide: acts ? r1((g('act.bind') + g('act.check') + g('act.handler-other')) / acts) : null,
    navSyncMsPerSec: sec ? r1(g('nav.sync') / sec) : null, navAuditMsPerSec: sec ? r1(g('nav.audit') / sec) : null, busyShare: b.totalMs ? Math.round(1000 * b.busyMs / b.totalMs) / 1000 : null };
}

export const readProfile = (file) => JSON.parse(readFileSync(file, 'utf8'));

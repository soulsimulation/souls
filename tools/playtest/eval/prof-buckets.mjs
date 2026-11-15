// #2414 MEASUREMENT BRANCH ONLY (never merged): every main-thread sample of a V8 .cpuprofile put in one group (#1953
// stage 1's first task): acts (bind, check, the route planning a tick does, the commit), non-act requests by route, the
// connectivity audit and the planner's scans, ticks, snapshots and GC. Per group: total ms and the most of it that one
// synchronous turn held (and that turn's length).
import { readFileSync } from 'node:fs';

const ROUTE_RE = /app\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)/i;
const SNAP = new Set(['captureCheckpoint', 'captureSnapshot', 'schedulePeriodicSnapshot', 'snapshotView', 'writeSnapshot', 'persistSnapshot']);
const AUDIT = new Set(['navWarmV1', 'fineTileSteps', 'labelComponents']);
const SCAN = new Set(['navScan', 'syncPaged', 'navChanged']);
const BIND = new Set(['bindOne', 'bindsCore', 'bindsTail', 'binds']);
const CHECK = new Set(['canPerform', 'routeProblem', 'previewAdmission', 'offerGate']);
const ROUTE = new Set(['planWalk', 'routeAround', 'retryPeople', 'goalNear', 'gridsWithObstacles', 'focusPage', 'planRoute']);
const TICK = new Set(['tickOnceInner', 'tickOnce', 'advanceStep']);
const BREAK = new Set(['(idle)', '(program)', '(root)']);

// #2437 A1: `marks` (holds.json from prof-hook) are the start and end of every timer and immediate callback, in the
// profile's µs clock. A busy run is split at each one, so a "hold" is one macrotask's synchronous part (or, between
// marked callbacks, an I/O callback with the microtasks after it). Reported beside the old busy-run "turns".
export function bucketProfile(file, repo, marks = null) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const bounds = marks ? Float64Array.from(marks).sort() : new Float64Array(0);
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
    const leaf = frames[0].functionName, routeSearch = any(ROUTE);
    let g;
    if (leaf === '(garbage collector)') g = 'gc';
    else if (any(SNAP)) g = 'snapshot';
    else if (any(AUDIT)) g = 'audit';
    else if (any(SCAN)) g = 'scan';
    else if (route === 'POST /v1/edge/act') g = any(BIND) ? 'act.bind' : any(CHECK) ? 'act.check' : 'act.handler-other';
    else if (tick) g = routeSearch ? 'act.route(tick)' : drain ? 'act.commit(tick)' : 'tick';
    else if (route) g = 'req ' + route;
    else if (req) g = 'req (middleware/unknown)';
    else g = 'other ' + (outer ?? leaf);
    const ctx = route ? 'req ' + route : tick ? (drain ? 'tick:drain' : 'tick') : req ? 'req' : 'other ' + (outer ?? leaf);
    const out = { g, ctx, routeSearch }; memo.set(leafId, out); return out;
  };
  const tot = new Map(), longest = new Map(), ctxOf = new Map(), routeSearchBy = new Map();
  let cur = null, busy = 0, total = 0, turns = 0;
  // holds: the same runs split at macrotask marks
  let hcur = null, bi = 0, t = p.startTime; const holds = [], hlong = new Map();
  const hclose = () => { if (!hcur) return; holds.push(hcur); for (const [g, ms] of hcur.by) { const L = hlong.get(g); if (!L || ms > L.ms) hlong.set(g, { ms, holdMs: hcur.ms }); } hcur = null; };
  const close = () => { if (!cur) return; turns++; for (const [g, ms] of cur.by) { const L = longest.get(g); if (!L || ms > L.ms) longest.set(g, { ms, turnMs: cur.ms }); } cur = null; };
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000; total += dt;
    t += p.timeDeltas[i] ?? 0;
    const node = byId.get(p.samples[i]); if (BREAK.has(node.callFrame.functionName)) { close(); hclose(); continue; }
    busy += dt; const c = classify(node.id);
    tot.set(c.g, (tot.get(c.g) ?? 0) + dt);
    if (['audit', 'scan', 'gc', 'snapshot'].includes(c.g)) { const m = ctxOf.get(c.g) ?? new Map(); m.set(c.ctx, (m.get(c.ctx) ?? 0) + dt); ctxOf.set(c.g, m); }
    if (c.routeSearch) routeSearchBy.set(c.ctx, (routeSearchBy.get(c.ctx) ?? 0) + dt);
    if (!cur) cur = { ms: 0, by: new Map() }; cur.ms += dt; cur.by.set(c.g, (cur.by.get(c.g) ?? 0) + dt);
    // a sample spans [t, t + dt): a mark inside it splits its time between the two holds (sparse samples stay exact)
    let s0 = t; const s1 = t + dt * 1000;
    const addH = (us) => { if (!hcur) hcur = { ms: 0, at: s0, by: new Map() }; hcur.ms += us / 1000; hcur.by.set(c.g, (hcur.by.get(c.g) ?? 0) + us / 1000); };
    while (bi < bounds.length && bounds[bi] < s1) { if (bounds[bi] > s0) { addH(bounds[bi] - s0); s0 = bounds[bi]; } hclose(); bi++; }
    addH(s1 - s0);
  }
  close(); hclose();
  holds.sort((a, b) => b.ms - a.ms);
  const hist = {}; for (const b of [50, 100, 200, 300, 500, 1000]) hist[`>=${b}`] = holds.filter((h) => h.ms >= b).length;
  const lead = (h) => [...h.by].sort((a, b) => b[1] - a[1]);
  const r1 = (x) => Math.round(10 * x) / 10;
  const top = (m, k) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([a, v]) => [a, r1(v)]));
  return {
    totalMs: r1(total), busyMs: r1(busy), turns,
    groups: [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([g, ms]) => ({ g, ms: r1(ms), longestMs: r1(longest.get(g)?.ms ?? 0), inTurnMs: r1(longest.get(g)?.turnMs ?? 0) })),
    ctxOf: Object.fromEntries([...ctxOf].map(([g, m]) => [g, top(m, 12)])),
    routeSearchByCtx: top(routeSearchBy, 20),
    holds: marks ? {
      n: holds.length, hist, marks: bounds.length,
      longest: holds.slice(0, 40).map((h) => ({ ms: r1(h.ms), atS: r1((h.at - p.startTime) / 1e6), by: Object.fromEntries(lead(h).slice(0, 5).map(([g, ms]) => [g, r1(ms)])) })),
      // per group: the most of it in one hold, and the share of all >= 100 ms holds that group led
      groups: [...hlong.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 40).map(([g, v]) => ({ g, longestMs: r1(v.ms), inHoldMs: r1(v.holdMs), ledOver100: holds.filter((h) => h.ms >= 100 && lead(h)[0][0] === g).length })),
    } : null,
  };
}

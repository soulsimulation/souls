// #1750 A2: per-route server time of the Soul and god API, readable from /healthz and from live.json. The histograms live in
// a SharedArrayBuffer, so the watchdog thread writes them into live.json while the main thread is stuck too. Route ids
// are a closed list (no Soul id, token or query value can become a label); anything else counts as its prefix's `other`.
// Per route: the time waiting for admission (`queue`) and the time from the turn to the answer (`handler`), in fixed
// geometric buckets (x1.25 from 0.1 ms to ~100 s, then open; a quantile is its bucket's upper bound, capped at the max), over the last 5 to 10 minutes (two
// rotating 5-minute windows) and since the process started. A long-poll (`listen`, `wait`) records how late it answered
// past its own timeout, not the time it was held open, so a due return that left late shows as late.
// #1944: `edge:act` also keeps its time after admission in three parts (handler, wait, commit: actTiming below), and the
// monitor publishes its last 10-second tick window here (publishTickWindow), so both reach live.json from the watchdog.
import {AsyncLocalStorage} from 'node:async_hooks';

export const API_ROUTES = [
  'edge:act', 'edge:say', 'edge:converse', 'edge:objects/:id/act', 'edge:plan', 'edge:around',
  'edge:here', 'edge:observe', 'edge:capabilities', 'edge:view', 'edge:objects', 'edge:resolve',
  'edge:listen', 'edge:wait', 'edge:inbox/:id', 'edge:inbox/:id/ack', 'edge:inbox/:id/result', 'edge:receipts/:id',
  'edge:catalog', 'edge:live', 'edge:public', 'edge:other', 'god:read', 'god:write', 'god:other', 'world:other',
] as const;
export type ApiRoute = typeof API_ROUTES[number];
const IDX = new Map<string, number>(API_ROUTES.map((r, i) => [r, i]));

/** The route id of a world-relative path; null for paths outside the API (pages, assets, /healthz). */
export function apiRoute(method: string, path: string): ApiRoute | null {
  if (path.startsWith('/v1/edge/')) {
    const r = path.slice(9);
    if (r === 'inbox/listen') return 'edge:listen';
    if (r === 'wait') return 'edge:wait';
    let m: RegExpExecArray | null;
    if ((m = /^inbox\/[^/]+(\/(ack|result))?$/.exec(r))) return m[2] === 'ack' ? 'edge:inbox/:id/ack' : m[2] === 'result' ? 'edge:inbox/:id/result' : 'edge:inbox/:id';
    if (/^receipts\/[^/]+$/.test(r)) return 'edge:receipts/:id';
    if (/^objects\/[^/]+\/act$/.test(r)) return 'edge:objects/:id/act';
    if (/^objects(\/[^/]+)?$/.test(r)) return 'edge:objects';
    if (/^plan(\/[^/]+)?$/.test(r)) return 'edge:plan';
    if (/^(map|rides|items|platforms)$/.test(r)) return 'edge:public';
    const id = 'edge:' + r;
    return IDX.has(id) ? id as ApiRoute : 'edge:other';
  }
  if (path.startsWith('/v1/god/')) return method === 'GET' || path === '/v1/god/query' ? 'god:read' : method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? 'god:write' : 'god:other';
  if (path.startsWith('/v1/world/')) return 'world:other';
  return null;
}

/** Bucket upper bounds (ms): 0.1 × 1.25^i, the last one open (+Inf). */
export const API_BUCKETS = 64;
export const BOUNDS_MS: number[] = Array.from({length: API_BUCKETS - 1}, (_, i) => 0.1 * 1.25 ** i);
export const API_WINDOW_MS = 300_000;
const KINDS = 2, WINDOWS = 3, ALL = 2;           // windows 0 and 1 rotate; 2 is since start
const SERIES = API_BUCKETS + 1;                  // the buckets, then the max
const HEAD = 4;                                  // [0] current window (0|1), [1] its start, [2] the other's start (0 = none), [3] process start
const at = (route: number, kind: number, win: number) => HEAD + ((route * KINDS + kind) * WINDOWS + win) * SERIES;
// #1944 A2: edge:act's parts (handler, wait, commit) in the same windows, then per window the acts whose wait passed
// three ticks, then the last tick window (TICK_FIELDS)
const PARTS = ['handler', 'wait', 'commit'] as const;
const PART0 = HEAD + API_ROUTES.length * KINDS * WINDOWS * SERIES;
const partAt = (k: number, win: number) => PART0 + (k * WINDOWS + win) * SERIES;
const OVER0 = PART0 + PARTS.length * WINDOWS * SERIES;
const TICK_FIELDS = ['at', 'windowMs', 'ticks', 'p50', 'p99', 'late', 'longestGapMs', 'green', 'amber', 'red', 'black'] as const;
const TICK0 = OVER0 + WINDOWS;
export const API_SLOTS = TICK0 + TICK_FIELDS.length;
export const newSharedApi = () => new Float64Array(new SharedArrayBuffer(API_SLOTS * Float64Array.BYTES_PER_ELEMENT));
/** The process's own histograms, read by the watchdog thread (watchdog.ts passes the buffer). */
export const sharedApi = newSharedApi();

function bucketOf(ms: number): number {
  if (!(ms > 0.1)) return 0;
  const i = Math.ceil(Math.log(ms / 0.1) / Math.log(1.25) - 1e-9);
  return i >= API_BUCKETS - 1 ? API_BUCKETS - 1 : i;
}
function add(a: Float64Array, base: number, ms: number) { a[base + bucketOf(ms)]++; if (ms > a[base + API_BUCKETS]) a[base + API_BUCKETS] = ms; }

/** #1944: an act's time after admission: `handler` up to the point the ledger's settle starts waiting, `wait` from there
 *  until the tick takes the decision, `commit` from there to the answer (applying it inside drainInputs, perform included). */
export type ActParts = {handler: number; wait: number; commit: number};
/** An act's wait counts as long past three ticks (at 50 ms). */
export const WAIT_OVER_MS = 150;

/** Record one answer (`parts`: edge:act's own, when its handler ran). Never throws (a bad value is dropped):
 *  instrumentation never fails a request. */
export function recordApi(route: ApiRoute, queueMs: number, handlerMs: number, now = Date.now(), a: Float64Array = sharedApi, parts?: ActParts) {
  try {
    const r = IDX.get(route); if (r === undefined || !Number.isFinite(queueMs) || !Number.isFinite(handlerMs)) return;
    if (!a[3]) a[3] = now;
    let cur = a[0];
    if (!a[1]) a[1] = now;
    else if (now - a[1] >= API_WINDOW_MS) {        // rotate: the other window is cleared and becomes current
      const next = cur ? 0 : 1;
      for (let i = 0; i < API_ROUTES.length; i++) for (let k = 0; k < KINDS; k++) a.fill(0, at(i, k, next), at(i, k, next) + SERIES);
      for (let k = 0; k < PARTS.length; k++) a.fill(0, partAt(k, next), partAt(k, next) + SERIES);
      a[OVER0 + next] = 0;
      a[2] = a[1]; a[1] = now; a[0] = cur = next;
    }
    const p = parts && route === 'edge:act' && PARTS.every(k => Number.isFinite(parts[k])) ? parts : null;
    for (const w of [cur, ALL]) {
      add(a, at(r, 0, w), Math.max(0, queueMs)); add(a, at(r, 1, w), Math.max(0, handlerMs));
      if (p) { PARTS.forEach((k, i) => add(a, partAt(i, w), Math.max(0, p[k]))); if (p.wait > WAIT_OVER_MS) a[OVER0 + w]++; }
    }
  } catch { /* never fails a request */ }
}

export type Quantiles = {p50: number; p99: number; p999: number; max: number};
/** edge:act only (#1944): its parts over the same windows, and how many acts waited past three ticks (window, since start). */
export type ActPartStats = {handler: Quantiles; wait: Quantiles; commit: Quantiles; waitOver3Ticks: number; waitOver3TicksAll: number};
export type ApiRouteStats = {n: number; queue: Quantiles; handler: Quantiles; nAll: number; handlerAll: Quantiles; parts?: ActPartStats};
/** #1944 A3: the monitor's last completed tick window: the tick's own ms, ticks that started over 25 ms after they were
 *  due, the longest start-to-start gap, and the share of the window at each load level. `at` = its end (epoch ms). */
export type TickWindow = {at: number; windowS: number; ticks: number; tickMs: {p50: number; p99: number}; lateTicks: number; longestGapMs: number;
  levels: {green: number; amber: number; red: number; black: number}};
export type ApiBlock = {windowS: number; sinceS: number; bucketX: 1.25; routes: Partial<Record<ApiRoute, ApiRouteStats>>; ticks?: TickWindow};

const r1 = (x: number) => Math.round(10 * x) / 10;
function quantiles(a: Float64Array, bases: number[]): {n: number; q: Quantiles} {
  const counts = new Array<number>(API_BUCKETS).fill(0); let n = 0, max = 0;
  for (const b of bases) { for (let i = 0; i < API_BUCKETS; i++) { counts[i] += a[b + i]; n += a[b + i]; } max = Math.max(max, a[b + API_BUCKETS]); }
  const q = (p: number) => {
    if (!n) return 0;
    const want = Math.ceil(p * n); let c = 0;
    for (let i = 0; i < API_BUCKETS; i++) { c += counts[i]; if (c >= want) return r1(Math.min(max, i < API_BUCKETS - 1 ? BOUNDS_MS[i] : max)); }
    return r1(max);
  };
  return {n, q: {p50: q(0.5), p99: q(0.99), p999: q(0.999), max: r1(max)}};
}

/** The `api` block of /healthz and live.json (pure: the watchdog thread calls it too). Routes with no answers are left out. */
export function apiOf(a: Float64Array = sharedApi, now = Date.now()): ApiBlock {
  const cur = a[0], wins = a[2] ? [0, 1] : [cur];
  const routes: ApiBlock['routes'] = {};
  for (let r = 0; r < API_ROUTES.length; r++) {
    const all = quantiles(a, [at(r, 1, ALL)]);
    if (!all.n) continue;
    const queue = quantiles(a, wins.map(w => at(r, 0, w))), handler = quantiles(a, wins.map(w => at(r, 1, w)));
    routes[API_ROUTES[r]] = {n: handler.n, queue: queue.q, handler: handler.q, nAll: all.n, handlerAll: all.q};
  }
  const act = routes['edge:act'];
  if (act && quantiles(a, [partAt(0, ALL)]).n) {
    const [handler, wait, commit] = PARTS.map((_, k) => quantiles(a, wins.map(w => partAt(k, w))).q);
    act.parts = {handler, wait, commit, waitOver3Ticks: wins.reduce((n, w) => n + a[OVER0 + w], 0), waitOver3TicksAll: a[OVER0 + ALL]};
  }
  const from = a[2] || a[1], ticks = tickWindowOf(a);
  return {windowS: from ? Math.round((now - from) / 1000) : 0, sinceS: a[3] ? Math.round((now - a[3]) / 1000) : 0, bucketX: 1.25, routes, ...(ticks ? {ticks} : {})};
}

/** #1944 A3: the monitor publishes each completed tick window (monitor.ts). */
export function publishTickWindow(w: TickWindow, a: Float64Array = sharedApi) {
  const v = {at: w.at, windowMs: 1000 * w.windowS, ticks: w.ticks, p50: w.tickMs.p50, p99: w.tickMs.p99, late: w.lateTicks, longestGapMs: w.longestGapMs, ...w.levels};
  TICK_FIELDS.forEach((k, i) => { a[TICK0 + i] = v[k]; });
}
function tickWindowOf(a: Float64Array): TickWindow | undefined {
  const f = (k: typeof TICK_FIELDS[number]) => a[TICK0 + TICK_FIELDS.indexOf(k)];
  if (!f('at')) return undefined;
  const sh = (k: 'green' | 'amber' | 'red' | 'black') => Math.round(100 * f(k)) / 100;
  return {at: f('at'), windowS: r1(f('windowMs') / 1000), ticks: f('ticks'), tickMs: {p50: r1(f('p50')), p99: r1(f('p99'))}, lateTicks: f('late'), longestGapMs: r1(f('longestGapMs')),
    levels: {green: sh('green'), amber: sh('amber'), red: sh('red'), black: sh('black')}};
}

/** #1944 A1: marks an act request leaves as it runs (admission.ts starts one per POST /v1/edge/act; the ledger fills it).
 *  Outside an act request getStore() is undefined, so a mark elsewhere costs one lookup. performance.now() ms; 0 = unset. */
export type ActTiming = {bindMs: number; checkAt: number; routeMisses: number; waitAt: number; takenAt: number; cap?: string};
export const actTiming = new AsyncLocalStorage<ActTiming>();
export const newActTiming = (): ActTiming => ({bindMs: 0, checkAt: 0, routeMisses: 0, waitAt: 0, takenAt: 0});
/** The parts of an act answered at `end`, its turn having started at `start`: they sum to end − start. `check` runs from
 *  the feasibility check to the wait (or the answer); `bind` is the time spent binding the offer. */
export function actPartsOf(t: ActTiming, start: number, end: number): ActParts & {bind: number; check: number; routeMisses: number} {
  const waitAt = t.waitAt ? Math.min(end, Math.max(start, t.waitAt)) : end, takenAt = t.takenAt ? Math.min(end, Math.max(waitAt, t.takenAt)) : end;
  return {handler: waitAt - start, wait: takenAt - waitAt, commit: end - takenAt, bind: t.bindMs, check: t.checkAt ? Math.max(0, waitAt - t.checkAt) : 0, routeMisses: t.routeMisses};
}

/** The handler time to record for an answer: a long-poll's lateness past its own timeout, otherwise the time itself. */
export function handlerMsOf(route: ApiRoute, ms: number, query: (k: string) => string | undefined): number {
  if (route === 'edge:listen') { const t = Number(query('timeoutMs')); return Number.isFinite(t) && t > 0 ? Math.max(0, ms - t) : ms; }
  if (route === 'edge:wait') { const t = Number(query('timeout')); return Number.isFinite(t) && t > 0 ? Math.max(0, ms - 1000 * t) : ms; }
  return ms;
}

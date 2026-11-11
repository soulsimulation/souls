// #1750 A2: per-route server time of the Soul and god API, readable from /healthz and from live.json. The histograms live in
// a SharedArrayBuffer, so the watchdog thread writes them into live.json while the main thread is stuck too. Route ids
// are a closed list (no Soul id, token or query value can become a label); anything else counts as its prefix's `other`.
// Per route: the time waiting for admission (`queue`) and the time from the turn to the answer (`handler`), in fixed
// geometric buckets (x1.25 from 0.1 ms to ~100 s, then open; a quantile is its bucket's upper bound, capped at the max), over the last 5 to 10 minutes (two
// rotating 5-minute windows) and since the process started. A long-poll (`listen`, `wait`) records how late it answered
// past its own timeout, not the time it was held open, so a due return that left late shows as late.

export const API_ROUTES = [
  'edge:act', 'edge:say', 'edge:converse', 'edge:objects/:id/act', 'edge:plan', 'edge:around',
  'edge:here', 'edge:observe', 'edge:capabilities', 'edge:view', 'edge:objects',
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
export const API_SLOTS = HEAD + API_ROUTES.length * KINDS * WINDOWS * SERIES;
export const newSharedApi = () => new Float64Array(new SharedArrayBuffer(API_SLOTS * Float64Array.BYTES_PER_ELEMENT));
/** The process's own histograms, read by the watchdog thread (watchdog.ts passes the buffer). */
export const sharedApi = newSharedApi();

function bucketOf(ms: number): number {
  if (!(ms > 0.1)) return 0;
  const i = Math.ceil(Math.log(ms / 0.1) / Math.log(1.25) - 1e-9);
  return i >= API_BUCKETS - 1 ? API_BUCKETS - 1 : i;
}
function add(a: Float64Array, base: number, ms: number) { a[base + bucketOf(ms)]++; if (ms > a[base + API_BUCKETS]) a[base + API_BUCKETS] = ms; }

/** Record one answer. Never throws (a bad value is dropped): instrumentation never fails a request. */
export function recordApi(route: ApiRoute, queueMs: number, handlerMs: number, now = Date.now(), a: Float64Array = sharedApi) {
  try {
    const r = IDX.get(route); if (r === undefined || !Number.isFinite(queueMs) || !Number.isFinite(handlerMs)) return;
    if (!a[3]) a[3] = now;
    let cur = a[0];
    if (!a[1]) a[1] = now;
    else if (now - a[1] >= API_WINDOW_MS) {        // rotate: the other window is cleared and becomes current
      const next = cur ? 0 : 1;
      for (let i = 0; i < API_ROUTES.length; i++) for (let k = 0; k < KINDS; k++) a.fill(0, at(i, k, next), at(i, k, next) + SERIES);
      a[2] = a[1]; a[1] = now; a[0] = cur = next;
    }
    for (const w of [cur, ALL]) { add(a, at(r, 0, w), Math.max(0, queueMs)); add(a, at(r, 1, w), Math.max(0, handlerMs)); }
  } catch { /* never fails a request */ }
}

export type Quantiles = {p50: number; p99: number; p999: number; max: number};
export type ApiRouteStats = {n: number; queue: Quantiles; handler: Quantiles; nAll: number; handlerAll: Quantiles};
export type ApiBlock = {windowS: number; sinceS: number; bucketX: 1.25; routes: Partial<Record<ApiRoute, ApiRouteStats>>};

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
  const from = a[2] || a[1];
  return {windowS: from ? Math.round((now - from) / 1000) : 0, sinceS: a[3] ? Math.round((now - a[3]) / 1000) : 0, bucketX: 1.25, routes};
}

/** The handler time to record for an answer: a long-poll's lateness past its own timeout, otherwise the time itself. */
export function handlerMsOf(route: ApiRoute, ms: number, query: (k: string) => string | undefined): number {
  if (route === 'edge:listen') { const t = Number(query('timeoutMs')); return Number.isFinite(t) && t > 0 ? Math.max(0, ms - t) : ms; }
  if (route === 'edge:wait') { const t = Number(query('timeout')); return Number.isFinite(t) && t > 0 ? Math.max(0, ms - 1000 * t) : ms; }
  return ms;
}

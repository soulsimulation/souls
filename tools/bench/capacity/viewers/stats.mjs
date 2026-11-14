// #2308: pure helpers for the viewers bench (viewers.mjs): Server-Timing parts, quantiles and one measuring window's
// figures from the world's live.json samples, the Souls' acts and the viewers' counters.

/** `world;dur=3.0, queue;dur=0.5` → {world: 3, queue: 0.5}; parts without a duration are left out. */
export function serverTiming(h) {
  const out = {};
  for (const part of String(h ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';'), dur = params.map((p) => /^\s*dur=([\d.]+)/.exec(p)?.[1]).find(Boolean);
    if (name && dur != null) out[name.trim()] = Number(dur);
  }
  return out;
}
/** Nearest-rank quantile of finite numbers; null when there are none. */
export function quantile(xs, p) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : null;
}
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(10 * x) / 10);
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(1000 * x) / 1000);

/** The world's 10-second tick windows (live.json `api.ticks`) that ended inside [from, to], each once (by its `at`). */
export function tickWindows(samples, from, to) {
  const seen = new Map();
  for (const s of samples) { const t = s.live?.api?.ticks; if (t?.at && t.at > from && t.at <= to && !seen.has(t.at)) seen.set(t.at, t); }
  return [...seen.values()];
}

/** One measuring window. `samples`: [{at, live, cpuS, rssMb}], `acts`: [{at, status, accepted, code, queueMs, worldMs, clientMs}],
 *  `v0`/`v1`: the viewers' counters at the window's start and end, `viewers`: how many were held, `calls`: the viewers'
 *  HTTP answers since the arm's viewers started opening ([{status, cache}]). */
export function windowFigures({ samples, acts, v0, v1, viewers, calls, from, to }) {
  const inW = samples.filter((s) => s.at >= from && s.at <= to), secs = (to - from) / 1000;
  const wins = tickWindows(samples, from, to), first = inW[0], last = inW.at(-1);
  const sum = (k) => wins.reduce((n, w) => n + (w.amberS?.[k] ?? 0), 0), level = (k) => (wins.length ? wins.reduce((n, w) => n + (w.levels?.[k] ?? 0), 0) / wins.length : null);
  const service = inW.map((s) => s.live?.tick?.service5s).filter(Number.isFinite);
  const a = acts.filter((x) => x.at >= from && x.at <= to), ok = a.filter((x) => x.status === 200 && x.accepted !== false);
  // the act's own handler part (#1944 Server-Timing `handler`); without it, world − queue (handler + wait + commit)
  const handler = ok.map((x) => (Number.isFinite(x.handlerMs) ? x.handlerMs : Number.isFinite(x.worldMs) && Number.isFinite(x.queueMs) ? x.worldMs - x.queueMs : NaN));
  const refusedActs = {}; for (const x of a) if (!(x.status === 200 && x.accepted !== false)) { const k = `${x.status} ${x.code ?? ''}`.trim(); refusedActs[k] = (refusedActs[k] ?? 0) + 1; }
  const viewerRefusals = {}; for (const c of calls) if (c.status !== 200) viewerRefusals[c.status] = (viewerRefusals[c.status] ?? 0) + 1;
  const worldCalls = calls.filter((c) => c.status !== 0 && c.cache !== 'hit' && c.cache !== 'shared').length;
  const bytes = v1.bytes - v0.bytes;
  return {
    seconds: r1(secs), viewers, tickWindows: wins.length,
    tickMs: { p50: r1(quantile(wins.map((w) => w.tickMs?.p50), 0.5)), p99: r1(wins.length ? Math.max(...wins.map((w) => w.tickMs?.p99 ?? 0)) : null) },
    tickService: { mean: r3(service.length ? service.reduce((x, y) => x + y, 0) / service.length : null), min: r3(service.length ? Math.min(...service) : null) },
    levels: { amber: r3(level('amber')), red: r3(level('red')), black: r3(level('black')) },
    amberS: { service: r1(sum('service')), loop: r1(sum('loop')), heap: r1(sum('heap')), dwell: r1(sum('dwell')) },
    acts: { n: a.length, ok: ok.length, queueMs: { p50: r1(quantile(ok.map((x) => x.queueMs), 0.5)), p95: r1(quantile(ok.map((x) => x.queueMs), 0.95)) },
      handlerMs: { p50: r1(quantile(handler, 0.5)), p99: r1(quantile(handler, 0.99)) }, waitMs: { p50: r1(quantile(ok.map((x) => x.waitMs), 0.5)), p99: r1(quantile(ok.map((x) => x.waitMs), 0.99)) }, clientMs: { p50: r1(quantile(ok.map((x) => x.clientMs), 0.5)), p99: r1(quantile(ok.map((x) => x.clientMs), 0.99)) }, refused: refusedActs },
    world: { cpuShare: first && last && Number.isFinite(first.cpuS) && Number.isFinite(last.cpuS) && last.at > first.at ? r3((last.cpuS - first.cpuS) / ((last.at - first.at) / 1000)) : null,
      rssMb: r1(last?.rssMb ?? null), heapUsedMb: last?.live?.heap?.usedMb ?? null },
    viewersOut: { bytesPerViewerPerS: viewers ? Math.round(bytes / viewers / secs) : null, messagesPerViewerPerS: viewers ? r1((v1.messages - v0.messages) / viewers / secs) : null,
      wsOpens: v1.opens - v0.opens, wsCloses: v1.closes - v0.closes, wsRefused: v1.refused - v0.refused },
    viewerCalls: { http: calls.length, worldCalls, refusals: viewerRefusals },
  };
}

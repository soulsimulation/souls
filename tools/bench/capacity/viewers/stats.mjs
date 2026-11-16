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

/** One measuring window. `samples`: [{at, live, cpuS, rssMb, viewersLive?, launcherCpuS?, launcherRssMb?, driverCpuS?}], `acts`: [{at, status, accepted, code, queueMs, worldMs, clientMs}],
 *  `v0`/`v1`: the viewers' counters at the window's start and end, `viewers`: how many were held (the target), `calls`: the viewers'
 *  HTTP answers since the arm's viewers started opening ([{status, cache}]). #2511: `motion`/`waiting`/`motionFrom` (first
 *  motion of the newcomers whose first socket started from `motionFrom`, see firstMotion), `souls` and `actSec` (the acts
 *  intended: one per Soul every `actSec`; none without it). */
export function windowFigures({ samples, acts, v0, v1, viewers, calls, from, to, motion = [], waiting = [], motionFrom = from, souls = null, actSec = null }) {
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
  // cores used over the window by one sampled process clock (`cpuS`, `launcherCpuS`, `driverCpuS`); null without two readings
  const share = (k) => (first && last && Number.isFinite(first[k]) && Number.isFinite(last[k]) && last.at > first.at ? r3((last[k] - first[k]) / ((last.at - first.at) / 1000)) : null);
  // #2511: viewers actually held over the window (sampled), and per-viewer rates over that mean, not over the target
  const live = inW.map((s) => s.viewersLive).filter(Number.isFinite), held = live.length ? live.reduce((x, y) => x + y, 0) / live.length : viewers;
  const heaps = inW.map((s) => s.live?.heap?.usedMb).filter(Number.isFinite), intended = actSec && souls ? (souls * secs) / actSec : null;
  const d = (k) => (v1[k] ?? 0) - (v0[k] ?? 0);
  return {
    seconds: r1(secs), viewers, tickWindows: wins.length,
    held: { min: live.length ? Math.min(...live) : viewers, mean: r1(held), max: live.length ? Math.max(...live) : viewers },
    churn: { joinsPerS: r1(d('joins') / secs), leavesPerS: r1(d('leaves') / secs), reconnects: d('reconnects') },
    firstMotion: firstMotion(motion, waiting, motionFrom, to),
    actsAchieved: { ok: ok.length, intended: intended == null ? null : r1(intended), share: intended ? r3(ok.length / intended) : null },
    heapMaxMb: heaps.length ? r1(Math.max(...heaps)) : null,
    tickMs: { p50: r1(quantile(wins.map((w) => w.tickMs?.p50), 0.5)), p99: r1(wins.length ? Math.max(...wins.map((w) => w.tickMs?.p99 ?? 0)) : null) },
    tickService: { mean: r3(service.length ? service.reduce((x, y) => x + y, 0) / service.length : null), min: r3(service.length ? Math.min(...service) : null) },
    levels: { amber: r3(level('amber')), red: r3(level('red')), black: r3(level('black')) },
    amberS: { service: r1(sum('service')), loop: r1(sum('loop')), heap: r1(sum('heap')), dwell: r1(sum('dwell')) },
    acts: { n: a.length, ok: ok.length, queueMs: { p50: r1(quantile(ok.map((x) => x.queueMs), 0.5)), p95: r1(quantile(ok.map((x) => x.queueMs), 0.95)) },
      handlerMs: { p50: r1(quantile(handler, 0.5)), p99: r1(quantile(handler, 0.99)) }, waitMs: { p50: r1(quantile(ok.map((x) => x.waitMs), 0.5)), p99: r1(quantile(ok.map((x) => x.waitMs), 0.99)) }, clientMs: { p50: r1(quantile(ok.map((x) => x.clientMs), 0.5)), p99: r1(quantile(ok.map((x) => x.clientMs), 0.99)) }, refused: refusedActs },
    world: { cpuShare: share('cpuS'), rssMb: r1(last?.rssMb ?? null), heapUsedMb: last?.live?.heap?.usedMb ?? null },
    launcher: { cpuShare: share('launcherCpuS'), rssMb: r1(last?.launcherRssMb ?? null) },
    driver: { cpuShare: share('driverCpuS') },
    viewersOut: { bytesPerViewerPerS: held ? Math.round(bytes / held / secs) : null, messagesPerViewerPerS: held ? r1((v1.messages - v0.messages) / held / secs) : null,
      wsOpens: v1.opens - v0.opens, wsCloses: v1.closes - v0.closes, wsRefused: v1.refused - v0.refused },
    viewerCalls: { http: calls.length, worldCalls, refusals: viewerRefusals },
  };
}

// ------------------------------------------------------------------ #2511: arrivals, stays, reconnects, first motion
/** The product client's reconnect delay (packages/client/src/index.ts, Connection `ws.onclose`, LOAD-CONTRACT v1 §3):
 *  a window that doubles from 500 ms to a 30 s cap, jittered over its upper half; a 1013 close ("try later": the hub is
 *  full or the world is unavailable) waits at least 5 s; a welcomed socket closed for a restart (1001, first try) comes
 *  back after 50–150 ms. `retry` counts tries since the last welcome. The client keeps this inline in its class, so it
 *  is mirrored here, and stats.test.mjs checks that the client's source still says the same. */
export function reconnectDelayMs(retry, code, rand = Math.random) {
  if (code === 1001 && retry === 0) return 50 + 100 * rand();
  const window = Math.min(30_000, 500 * 2 ** retry);
  return Math.max(code === 1013 ? 5_000 : 0, window * (0.5 + 0.5 * rand()));
}
/** A seeded generator in [0, 1) (mulberry32), so a repeat draws the same stays every run. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A heavy-tailed stay: log-normal with the given median and sigma 1 (half leave before the median, about one in six
 *  stays over 2.7 times it, one in forty over 7 times it). */
export function stayMs(medianS, rand) {
  const u = Math.max(rand(), 1e-12), z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  return medianS * 1000 * Math.exp(z);
}
/** `--arrive-burst 300@40` → {n: 300, atS: 40}; null for none. */
export function parseBurst(v) {
  if (v == null) return null;
  const m = /^(\d{1,4})@(\d{1,4})$/.exec(String(v));
  if (!m) throw new Error(`--arrive-burst ${v}: expected <n>@<seconds>`);
  return { n: Number(m[1]), atS: Number(m[2]) };
}
/** The number of chunks in a take-stream message, read from its head only (never parsing the whole message): `takes`
 *  (its `chunks`) or the per-connection envelopes `take-chunks` / `take-entities` (their `ids`, one per chunk); null for
 *  any other message. A newcomer's first motion is the first message where this is above 0. */
export function takesChunks(s) {
  if (typeof s !== 'string' || !s.startsWith('{"t":"take')) return null;
  const head = s.slice(0, 4096);
  const ids = /^\{"t":"take-(?:chunks|entities)","contract":"[^"]*","ids":\[([^\]]*)\]/.exec(head);
  if (ids) return ids[1].trim() ? ids[1].split(',').length : 0;
  const ch = /"chunks":\[\s*(.)/.exec(head);
  return ch ? (ch[1] === ']' ? 0 : 1) : null;
}
/** First motion of the newcomers whose first socket started in [from, to]. `motion`: [{at, ms}] (ms null: that socket
 *  closed before any chunk); `waiting`: [{at}] still waiting at `to`, a miss once it has waited 5 s. Seconds at p50 and
 *  p95, a miss counted slower than any ('none' when the quantile falls on one). */
export function firstMotion(motion, waiting, from, to) {
  const inW = motion.filter((m) => m.at >= from && m.at <= to), seen = inW.filter((m) => m.ms != null).map((m) => m.ms).sort((x, y) => x - y);
  const missed = inW.length - seen.length + waiting.filter((w) => w.at >= from && w.at <= to - 5000).length, all = seen.length + missed;
  const q = (p) => { if (!all) return null; const i = Math.min(all - 1, Math.max(0, Math.ceil(p * all) - 1)); return i < seen.length ? r1(seen[i] / 100) / 10 : 'none'; };
  return { n: seen.length, missed, p50S: q(0.5), p95S: q(0.95) };
}

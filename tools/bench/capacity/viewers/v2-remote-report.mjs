#!/usr/bin/env node
// #4985: one arm's figures from v2-remote-modal.py's JSON lines, and (with --host) the origin host's samples over the
// arm's span: JSON lines of {t (unix ms), busy, idle (/proc/stat jiffies), origin, caddy (process jiffies), tx (bytes),
// seg (requests in from the proxy to the origin, as TCP data segments on its open sockets; a socket that closes
// loses its count, so a drop is skipped), ticks, healthAt (the world's tick count and
// its health file's time)}. Steady windows are those after the arrivals (40 s in). Prints one JSON object.
//
//   node tools/bench/capacity/viewers/v2-remote-report.mjs <arm.jsonl> [--host <host.jsonl>]
import { readFileSync } from 'node:fs';
import { hq, hcount, merge } from './v2-stats.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const lines = readFileSync(argv[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const head = lines[0], rows = lines.slice(1).filter((r) => r.t != null), errs = lines.slice(1).filter((r) => r.stderr);
const byT = new Map();
for (const r of rows) {
  const w = byT.get(r.t) ?? { t: r.t, shares: 0, viewers: 0, waiting: 0, slow: 0, requests: {}, bytes: {}, cache: {}, rtt: {}, latency: {}, firstPicture: {}, installed: {}, errors: {}, behind: 0, reinstalls: 0, crossed: 0, recovered: 0, cpuSeconds: 0, loopP99Ms: 0 };
  w.shares++;
  for (const k of ['viewers', 'waiting', 'slow', 'behind', 'reinstalls', 'crossed', 'recovered', 'cpuSeconds']) w[k] += r[k] ?? 0;
  for (const k of ['requests', 'bytes', 'errors', 'colo']) merge((w[k] ??= {}), r[k] ?? {});
  for (const k of ['latency', 'firstPicture', 'installed']) merge(w[k], r[k] ?? {});
  for (const k of ['cache', 'rtt', 'enc']) for (const [type, h] of Object.entries(r[k] ?? {})) merge(((w[k] ??= {})[type] ??= {}), h);
  w.loopP99Ms = Math.max(w.loopP99Ms, r.loopP99Ms ?? 0);
  byT.set(r.t, w);
}
// steady: 10 s after the arrivals (30 s, or the arm's --arrive-secs)
const ARRIVED = (head.arriveSecs ?? 30) + 10;
const windows = [...byT.values()].sort((a, b) => a.t - b.t), steady = windows.filter((w) => w.t > ARRIVED);
const sum = (ws, f) => ws.reduce((s, w) => s + f(w), 0), secs = 10 * steady.length;
const all = (k, type) => { const h = {}; for (const w of steady) merge(h, type ? w[k][type] ?? {} : w[k]); return h; };
const anyW = (k) => { const h = {}; for (const w of windows) merge(h, w[k]); return h; };
const q = (h) => ({ p50: hq(h, 0.5), p95: hq(h, 0.95), n: hcount(h) });
const cache = {}; for (const w of steady) for (const [type, h] of Object.entries(w.cache)) merge((cache[type] ??= {}), h);
const cacheAll = Object.values(cache).reduce((a, h) => merge(a, h), {}), cached = hcount(cacheAll);
const viewerSeconds = sum(steady, (w) => w.viewers * 10);
const out = {
  arm: head.arm, viewers: head.viewers, shares: head.shares, secs: head.secs, startAt: new Date(head.start_at).toISOString(), shareErrors: errs.length,
  sustainedMin: Math.min(...steady.map((w) => w.viewers)), sustainedMax: Math.max(...steady.map((w) => w.viewers)), waitingAtEnd: windows.at(-1)?.waiting ?? null,
  partsPerViewerS: +(sum(steady, (w) => w.requests.part ?? 0) / viewerSeconds).toFixed(3),
  pointerPerViewerS: +(sum(steady, (w) => w.requests.pointer ?? 0) / viewerSeconds).toFixed(2),
  requestsPerS: Math.round(sum(steady, (w) => Object.values(w.requests).reduce((a, b) => a + b, 0)) / secs),
  mbPerS: +(sum(steady, (w) => Object.values(w.bytes).reduce((a, b) => a + b, 0)) / secs / 1e6).toFixed(2),
  pointerRtt: q(all('rtt', 'pointer')), partRtt: q(all('rtt', 'part')), baselineRtt: q(windows.reduce((h, w) => merge(h, w.rtt.baseline ?? {}), {})),
  streamLatency: q(all('latency')), firstPicture: q(anyW('firstPicture')),
  // the first arrivals (the first minute) and, on uneven, the churn wave's joiners (after it) apart
  firstPictureArrivals: q(windows.filter((w) => w.t <= ARRIVED + 20).reduce((h, w) => merge(h, w.firstPicture), {})),
  firstPictureLater: q(windows.filter((w) => w.t > ARRIVED + 20).reduce((h, w) => merge(h, w.firstPicture), {})), baselineDrawn: q(anyW('installed')),
  hitRatio: cached ? +((cacheAll.HIT ?? 0) / cached).toFixed(4) : null,
  cacheByType: Object.fromEntries(Object.entries(cache).map(([t, h]) => [t, { ...h, hit: +((h.HIT ?? 0) / hcount(h)).toFixed(4) }])),
  hitRatioWithJoins: (() => { const h = {}; for (const w of windows) for (const x of Object.values(w.cache)) merge(h, x); const n = hcount(h); return n ? +((h.HIT ?? 0) / n).toFixed(4) : null; })(),
  notHitPerS: +((cached - (cacheAll.HIT ?? 0)) / secs).toFixed(2),
  errors: windows.reduce((s, w) => merge(s, w.errors), {}), behind: sum(windows, (w) => w.behind), reinstalls: sum(windows, (w) => w.reinstalls),
  refusal: rows.find((r) => r.refusal)?.refusal ?? null,
  edgeLocations: windows.reduce((s, w) => merge(s, w.colo ?? {}), {}), headers: head.headers ?? 'bare',
  encodings: (() => { const e = {}; for (const w of windows) for (const [t, h] of Object.entries(w.enc ?? {})) merge((e[t] ??= {}), h); return e; })(),
  readerCores: +(sum(windows, (w) => w.cpuSeconds) / (10 * windows.length)).toFixed(2), readerLoopP99Ms: Math.max(...windows.map((w) => w.loopP99Ms)),
};
// per source address (rows carry a hash of the machine's address when the launcher ran --by-address): the reads a second
// each address sent while steady, and the readers it carried
if (rows.some((x) => x.addr)) {
  const per = new Map();
  for (const x of rows) {
    if (!x.addr) continue;
    if (x.t > ARRIVED) per.set(x.addr, (per.get(x.addr) ?? 0) + Object.values(x.requests ?? {}).reduce((a, b) => a + b, 0));
  }
  const byShare = new Map(); for (const x of rows) if (x.addr && x.viewers != null && x.t > ARRIVED) byShare.set(x.share, [x.addr, Math.max(byShare.get(x.share)?.[1] ?? 0, x.viewers)]);
  const held = new Map(); for (const [a, v] of byShare.values()) held.set(a, (held.get(a) ?? 0) + v);
  const rates = [...per.values()].map((n) => n / secs).sort((a, b) => a - b);
  const qq = (s, f) => +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(1);
  const hv = [...held.values()].sort((a, b) => a - b);
  out.sourceAddresses = per.size;
  out.machinesReading = new Set(rows.filter((x) => x.addr && x.t != null).map((x) => x.share)).size;
  out.readsPerSPerAddress = rates.length ? { p50: qq(rates, 0.5), p95: qq(rates, 0.95), max: qq(rates, 1) } : null;
  out.readersPerAddress = hv.length ? { p50: hv[Math.floor(hv.length / 2)], max: hv.at(-1) } : null;
}
out.stopped = head.stopped ?? lines.slice(1).find((x) => x.stopped)?.stopped ?? null;
// baseline joins: bytes per baseline as sent (br when the reader asks for it)
const jb = windows.reduce((s, w) => s + (w.bytes.baseline ?? 0), 0), jn = windows.reduce((s, w) => s + (w.requests.baseline ?? 0), 0);
out.baselineBytesEach = jn ? Math.round(jb / jn) : null;
const hostFile = opt('host');
if (hostFile) {
  // the steady span; an arm stopped at a refusal is read from its start to its last window
  const cut = out.stopped ? windows.at(-1)?.t ?? 0 : null;
  const from = head.start_at + (cut != null ? 0 : ARRIVED * 1000), to = head.start_at + (cut != null ? cut * 1000 + 5_000 : head.secs * 1000);
  const hs = readFileSync(hostFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((a, b) => a.t - b.t);
  const span = (a, b) => { const s = hs.filter((x) => x.t >= a && x.t <= b); return s.length >= 2 ? [s[0], s.at(-1)] : null; };
  const inSpan = (a, b) => hs.filter((x) => x.t >= a.t && x.t <= b.t);
  const fig = (pair) => {
    if (!pair) return null;
    const [a, b] = pair, dt = (b.t - a.t) / 1000, ht = (b.healthAt - a.healthAt) / 1000;
    return {
      hostBusy: +((b.busy - a.busy) / (b.busy - a.busy + b.idle - a.idle)).toFixed(3),
      originCores: +((b.origin - a.origin) / 100 / dt).toFixed(3), caddyCores: +((b.caddy - a.caddy) / 100 / dt).toFixed(3),
      originReqPerS: +(inSpan(a, b).reduce((n, x, i, s) => n + (i ? Math.max(0, x.seg - s[i - 1].seg) : 0), 0) / dt).toFixed(1), egressMBps: +((b.tx - a.tx) / dt / 1e6).toFixed(2),
      tickRate: ht > 0 ? +((b.ticks - a.ticks) / ht).toFixed(2) : null, overBudget: b.overBudget - a.overBudget,
      hostBusyMax: Math.max(...inSpan(a, b).map((x, i, s) => (i ? (x.busy - s[i - 1].busy) / (x.busy - s[i - 1].busy + x.idle - s[i - 1].idle) : 0))).toFixed(3) * 1,
    };
  };
  out.hostBefore = fig(span(head.start_at - 90_000, head.start_at));
  out.hostDuring = fig(span(from, to));
}
console.log(JSON.stringify(out, null, 1));

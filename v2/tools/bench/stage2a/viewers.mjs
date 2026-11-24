// The limits run's viewers (0.133 P3): m viewers on one rung's world while its agents act, so a rung is measured with
// people watching. Each viewer is the viewers bench's reader (tools/bench/capacity/viewers/v2-readers.mjs: the page's
// stream worker without the drawing), forked over `procs` processes as that bench forks them. Fake viewers on
// loopback only: they read the rung's own origin and nothing else.
//
//   node v2/tools/bench/stage2a/viewers.mjs <origin url> <stream path> <replica pkg> <m> <even|uneven> <seconds> \
//        <driver.out> <out folder> [procs]
//
// even: the m viewers arrive spread over 30 s and stay. uneven: they arrive in one wave within 5 s, and half as many
// again arrive in a second wave at the load's middle (people come in waves). The load starts when the driver prints
// its `bodies:` line (every agent signed in), or 60 s after this starts if it never does. Every 10 s the readers'
// counters go to <out>/viewers.jsonl; on SIGTERM the run's summary goes to <out>/viewers.json and the readers stop.
import { fork } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hcount, hq, merge } from '../../../../tools/bench/capacity/viewers/v2-stats.mjs';

const [base, stream, pkg, mArg, arm, secsArg, driverOut, out, procsArg] = process.argv.slice(2);
const M = Number(mArg), SECS = Number(secsArg), PROCS = Number(procsArg ?? Math.max(1, Math.ceil(M / 250)));
const TAKE_MS = 10_000, READERS = new URL('../../../../tools/bench/capacity/viewers/v2-readers.mjs', import.meta.url).pathname;
const t0 = Date.now();
const kids = await Promise.all(Array.from({ length: PROCS }, () => new Promise((ok) => {
  const k = fork(READERS, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  k.once('message', () => ok(k));
  k.send({ init: { base, stream, pkg } });
})));
kids.forEach((k) => k.on('exit', () => { k.dead = true; }));
const share = (n, i) => Math.floor(n / PROCS) + (i < n % PROCS ? 1 : 0);
const add = (n, overMs) => kids.forEach((k, i) => !k.dead && share(n, i) && k.send({ add: share(n, i), overMs }));
const take = async () => (await Promise.all(kids.map((k) => (k.dead ? null : new Promise((ok) => {
  const t = setTimeout(() => ok(null), 5_000);
  k.once('message', (m) => { clearTimeout(t); ok(m.took); });
  k.send({ take: true });
}))))).filter(Boolean);

add(M, arm === 'uneven' ? 5_000 : 30_000);
let loadAt = null, second = false;
const windows = [];
const tick = async () => {
  if (loadAt == null && (/^bodies:/m.test(existsSync(driverOut) ? readFileSync(driverOut, 'utf8') : '') || Date.now() - t0 > 60_000)) loadAt = Date.now();
  if (arm === 'uneven' && !second && loadAt != null && Date.now() - loadAt >= (SECS * 1000) / 2) { second = true; add(Math.round(M / 2), 5_000); }
  const takes = await take();
  const w = { t: (Date.now() - t0) / 1000, load: loadAt == null ? null : (Date.now() - loadAt) / 1000, latency: {}, firstPicture: {}, errors: 0, behind: 0, reinstalls: 0, viewers: 0, waiting: 0, cpuSeconds: 0, loopP99Ms: 0 };
  for (const x of takes) {
    merge(w.latency, x.latency); merge(w.firstPicture, x.firstPicture);
    w.errors += Object.values(x.errors).reduce((a, b) => a + b, 0);
    for (const k of ['behind', 'reinstalls', 'viewers', 'waiting', 'cpuSeconds']) w[k] += x[k];
    w.loopP99Ms = Math.max(w.loopP99Ms, x.loopP99Ms);
  }
  windows.push(w);
  appendFileSync(`${out}/viewers.jsonl`, JSON.stringify({ ...w, latencyP50: hq(w.latency, 0.5), latencyP95: hq(w.latency, 0.95) }) + '\n');
};
const timer = setInterval(() => { tick().catch(() => {}); }, TAKE_MS);

/** The run's summary: the stream latency over the load window, its first and last minute (does it grow?), drops. */
function summary() {
  const inLoad = windows.filter((w) => w.load != null && w.load > (arm === 'uneven' ? 10 : 40) && w.load <= SECS + 5);
  const all = {}, first = {}, last = {}, pictures = {};
  for (const w of inLoad) merge(all, w.latency);
  for (const w of inLoad.slice(0, 6)) merge(first, w.latency);
  for (const w of inLoad.slice(-6)) merge(last, w.latency);
  for (const w of windows) merge(pictures, w.firstPicture);
  const q = (h) => ({ p50Ms: hq(h, 0.5), p95Ms: hq(h, 0.95), p99Ms: hq(h, 0.99), n: hcount(h) });
  const peak = Math.max(0, ...windows.map((w) => w.viewers));
  return {
    m: M, arm, procs: PROCS, peakViewers: peak, waitingAtEnd: windows.at(-1)?.waiting ?? null,
    latency: q(all), firstMinute: q(first), lastMinute: q(last), firstPicture: q(pictures),
    drops: windows.reduce((s, w) => s + w.errors + w.behind + w.reinstalls, 0),
    readerCores: +(windows.reduce((s, w) => s + w.cpuSeconds, 0) / Math.max(1, (Date.now() - t0) / 1000)).toFixed(2),
    readerLoopP99Ms: Math.max(0, ...windows.map((w) => w.loopP99Ms)),
  };
}

process.on('SIGTERM', async () => {
  clearInterval(timer);
  await tick().catch(() => {});
  writeFileSync(`${out}/viewers.json`, JSON.stringify(summary(), null, 1));
  kids.forEach((k) => !k.dead && k.send({ stop: true }));
  setTimeout(() => process.exit(0), 1_000);
});

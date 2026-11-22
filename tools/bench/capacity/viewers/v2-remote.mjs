#!/usr/bin/env node
// #4159: viewers of a world that is already served somewhere, read through its public address (the stream's CDN
// hostname), from this machine. Nothing is started but the viewers: v2-readers.mjs drivers (the page's stream worker
// without drawing), in join waves, as v2.mjs runs them against its own world. It only reads public stream files.
//
//   node tools/bench/capacity/viewers/v2-remote.mjs --base https://stream.eden.art/ --stream <stream path under /s/>
//        --pkg <replica wasm-bindgen pkg> [--steps 1000,2000,5000] [--wave-sec 5] [--settle-sec 10] [--window-sec 60]
//        [--drivers 8] [--poll-ms 250] [--out <dir>]
// Per step: the joiners' first picture p50/p95, failed requests by kind, requests and bytes a viewer-second by file
// type, and lateness. What reached the origin is the origin's own counters (ORIGIN_STATS), read on its host before and
// after. Writes <out>/results.json and prints one line a step; a driver whose event loop p99 passes 100 ms marks the
// step driver-bound (not judged).
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hcount, hq, merge } from './v2-stats.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const BASE = opt('base'), STREAM = opt('stream'), PKG = opt('pkg') && resolve(opt('pkg'));
if (!BASE || !STREAM || !PKG) throw new Error('--base <https URL>, --stream <path> and --pkg <replica pkg> are required');
const STEPS = opt('steps', '1000,2000,5000').split(',').map(Number), DRIVERS = Number(opt('drivers', 8)), POLL_MS = Number(opt('poll-ms', 250));
const WAVE_MS = Number(opt('wave-sec', 5)) * 1000, SETTLE_MS = Number(opt('settle-sec', 10)) * 1000, WINDOW_MS = Number(opt('window-sec', 60)) * 1000;
const OUT = resolve(opt('out', join('.local/bench/viewers-remote', new Date().toISOString().replace(/[:.]/g, '-'))));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kids = await Promise.all(Array.from({ length: DRIVERS }, () => new Promise((ok) => {
  const k = fork(new URL('./v2-readers.mjs', import.meta.url).pathname, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  k.once('message', () => ok(k));
  k.send({ init: { base: BASE, stream: STREAM.replace(/^\//, ''), pkg: PKG, pollMs: POLL_MS } });
})));
const take = async () => {
  const all = (await Promise.all(kids.map((k) => new Promise((ok) => { const t = setTimeout(() => ok(null), 30_000); k.once('message', (m) => { clearTimeout(t); ok(m.took); }); k.send({ take: true }); })))).filter(Boolean);
  const o = { bytes: {}, requests: {}, firstPicture: {}, latency: {}, errors: {}, viewers: 0, loopP99Ms: 0 };
  for (const t of all) { for (const k of ['bytes', 'requests', 'firstPicture', 'latency', 'errors']) merge(o[k], t[k]); o.viewers += t.viewers; o.loopP99Ms = Math.max(o.loopP99Ms, t.loopP99Ms); }
  return o;
};
const share = (n, i) => Math.floor(n / DRIVERS) + (i < n % DRIVERS ? 1 : 0);
const rows = [];
let held = 0;
await take();
for (const step of STEPS) {
  kids.forEach((k, i) => share(step - held, i) && k.send({ add: share(step - held, i), overMs: WAVE_MS }));
  held = step;
  await sleep(WAVE_MS + SETTLE_MS);
  const wave = await take();
  const t0 = Date.now();
  await sleep(WINDOW_MS);
  const win = await take(), vs = win.viewers * (Date.now() - t0) / 1000;
  const fp = merge({ ...wave.firstPicture }, win.firstPicture), per = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +(v / vs).toFixed(2)]));
  const row = { step, viewers: win.viewers, firstPictureP50: hq(fp, 0.5), firstPictureP95: hq(fp, 0.95), firstPictures: hcount(fp), errors: merge({ ...wave.errors }, win.errors),
    latencyP50: hq(win.latency, 0.5), latencyP99: hq(win.latency, 0.99), requestsPerViewerS: per(win.requests), bytesPerViewerS: per(win.bytes),
    joinBytes: Math.round(Object.values(wave.bytes).reduce((a, b) => a + b, 0) / Math.max(1, step - (rows.at(-1)?.step ?? 0))), driverLoopP99Ms: Math.max(wave.loopP99Ms, win.loopP99Ms) };
  row.driverBound = row.driverLoopP99Ms > 100;
  rows.push(row);
  console.log(JSON.stringify(row));
}
kids.forEach((k) => k.send({ stop: true }));
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ base: BASE, steps: STEPS, drivers: DRIVERS, pollMs: POLL_MS, rows }, null, 1));
await sleep(1000);
process.exit(0);

#!/usr/bin/env node
// #4985: remote readers on a served world's live stream, from outside its host and through its CDN. One machine's share
// of an arm: n readers (v2-readers.mjs, the page's stream worker without the drawing) over --procs processes, reading
// <base><stream> with the browser's Accept-Encoding. v2-remote-modal.py starts this on several machines at one
// --start-at, so an arm of 5,000 is several shares, each with its own address and link.
//
// even: the readers arrive spread over 30 s and stay to the end. uneven: they arrive in one join wave within 5 s; at the
// arm's middle a churn wave (a quarter leave and as many new ones join within 5 s) and --slow-share of n slow readers
// (at least 5 per arm, split over the shares) that ask for the baseline and never read, held to the end.
// Every 10 s one JSON line on stdout: the readers held and waiting for a first picture, requests and bytes by file
// type, cf-cache-status counts by file type, request time and stream latency histograms (10 ms buckets), first
// pictures, failures, viewers sent back to a baseline or left behind, the readers' own processor and event-loop delay.
//
//   node tools/bench/capacity/viewers/v2-remote.mjs --base https://stream.example --stream /s/w/<world>/views/.../everyone/
//        --pkg <replica wasm-bindgen pkg> --viewers 500 --arm even|uneven [--secs 240] [--procs 2] [--slow 0]
//        [--encoding 'br, gzip'] [--start-at <unix ms>]
import { fork } from 'node:child_process';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const BASE = opt('base'), STREAM = opt('stream'), PKG = opt('pkg'), N = Number(opt('viewers', 0)), ARM = opt('arm', 'even');
const SECS = Number(opt('secs', 240)), PROCS = Number(opt('procs', 2)), SLOW = Number(opt('slow', 0)), ENC = opt('encoding', 'br, gzip');
const START_AT = Number(opt('start-at', Date.now())), TAKE_MS = 10_000;
if (!BASE || !STREAM || !PKG || !(N >= 0) || !['even', 'uneven'].includes(ARM)) throw new Error('--base, --stream, --pkg, --viewers and --arm even|uneven');
const READERS = new URL('./v2-readers.mjs', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const kids = await Promise.all(Array.from({ length: PROCS }, () => new Promise((ok) => {
  const k = fork(READERS, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  k.once('message', () => ok(k));
  k.send({ init: { base: BASE, stream: STREAM, pkg: PKG, encoding: ENC } });
})));
kids.forEach((k) => k.on('exit', () => { k.dead = true; }));
const share = (n, i) => Math.floor(n / PROCS) + (i < n % PROCS ? 1 : 0);
const each = (n, m) => kids.forEach((k, i) => !k.dead && share(n, i) && k.send(m(share(n, i))));
const take = async () => (await Promise.all(kids.map((k) => (k.dead ? null : new Promise((ok) => {
  const t = setTimeout(() => ok(null), 5_000);
  k.once('message', (m) => { clearTimeout(t); ok(m.took); });
  k.send({ take: true });
}))))).filter(Boolean);

await sleep(START_AT - Date.now());
const t0 = Date.now();
each(N, (n) => ({ add: n, overMs: ARM === 'uneven' ? 5_000 : 30_000 }));
let churned = false;
for (let k = 1; (k - 1) * TAKE_MS < SECS * 1000; k++) {
  await sleep(t0 + k * TAKE_MS - Date.now());
  if (ARM === 'uneven' && !churned && Date.now() - t0 >= (SECS * 1000) / 2) {
    churned = true;
    const q = Math.round(N / 4);
    each(q, (n) => ({ drop: n }));
    each(q, (n) => ({ add: n, overMs: 5_000 }));
    if (SLOW) { const p = kids.find((x) => !x.dead); p?.send({ slow: SLOW }); }
  }
  const takes = await take();
  const sum = { t: Math.round((Date.now() - t0) / 1000), procs: takes.length };
  for (const x of takes) {
    for (const [key, v] of Object.entries(x)) {
      if (typeof v === 'number') sum[key] = (sum[key] ?? 0) + v;
      else if (v && typeof v === 'object') {
        sum[key] ??= {};
        for (const [a, b] of Object.entries(v)) {
          if (typeof b === 'number') sum[key][a] = (sum[key][a] ?? 0) + b;
          else { sum[key][a] ??= {}; for (const [c, d] of Object.entries(b)) sum[key][a][c] = (sum[key][a][c] ?? 0) + d; }
        }
      }
    }
    sum.loopP99Ms = Math.max(sum.loopP99Ms ?? 0, x.loopP99Ms);
    sum.loopMaxMs = Math.max(sum.loopMaxMs ?? 0, x.loopMaxMs);
  }
  console.log(JSON.stringify(sum));
}
kids.forEach((k) => !k.dead && k.send({ stop: true }));
await sleep(1000);
process.exit(0);

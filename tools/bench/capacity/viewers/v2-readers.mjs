// #4018 (X9): one driver process of the v2 viewers bench (v2.mjs forks several). Each viewer does what the page's
// stream worker does (v2/web/src/source/worker.ts), without playing: the pointer (read with replica's own
// `readPointer`), the bundle's header, the generation's baseline and its words (the first picture), then every part
// from the generation's first, AHEAD at a time (with its words while far behind, as the page's catch-up does), then
// the pointer every 250 ms and each new part. A handoff to the next generation is drained and crossed with no new
// baseline; a viewer whose generation is gone starts again from the newest baseline (counted). One keep-alive agent
// of two sockets per viewer. Slow readers ask for the baseline and never read.
// Messages from v2.mjs: {init: {base, stream, pkg}}, {add: n, overMs}, {slow: n}, {unslow: true}, {take: true}
// (answers with the counters since the last take, and resets them), {stop: true}.
import { Agent, request } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileType, record } from './v2-stats.mjs';

const AHEAD = 16, POLL_MS = 250, TIMEOUT_MS = 10_000;
const PERIOD_US = 500_000, BEHIND_US = 4 * PERIOD_US, CUT_US = 20_000_000; // v2/web/src/clock/clock.ts
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let cfg, readPointer;
const viewers = new Set(), slow = new Set();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const fresh = () => ({ bytes: {}, requests: {}, headerBytes: 0, installed: {}, firstPicture: {}, latency: {}, errors: {}, reinstalls: 0, crossed: 0, behind: 0, recovered: 0, joined: 0, left: 0 });
let w = fresh(), cpu0 = process.cpuUsage();

const fail = (code) => { w.errors[code] = (w.errors[code] ?? 0) + 1; };

/** GET `url` over `agent`: the body, counted by its file type; throws on a failure, counted by code. */
function get(url, agent) {
  const type = fileType(url.pathname);
  return new Promise((ok, no) => {
    const req = request(url, { agent, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        w.requests[type] = (w.requests[type] ?? 0) + 1;
        w.bytes[type] = (w.bytes[type] ?? 0) + body.length;
        w.headerBytes += res.rawHeaders.reduce((n, h) => n + h.length + 2, 0);
        if (res.statusCode !== 200) { fail(`${type} ${res.statusCode}`); return no(Object.assign(new Error('status'), { status: res.statusCode, counted: true })); }
        ok(body);
      });
      res.on('error', (e) => { fail(e.code ?? 'response'); e.counted = true; no(e); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.on('error', (e) => { if (!e.counted) { fail(e.code ?? 'request'); e.counted = true; } no(e); });
    req.end();
  });
}

const streamUrl = () => new URL(cfg.stream, cfg.base);
const at = (p, file) => new URL(p.generation ? `g/${p.generation}/${file}` : file, streamUrl());
const pointer = async (agent) => JSON.parse(readPointer(await get(new URL('pointer', streamUrl()), agent)));

/** The page's install: the header, then (on a generation) its baseline and the baseline's words. */
async function install(agent, p) {
  await get(new URL(`../../../headers/${p.header}`, streamUrl()), agent);
  if (!p.generation) return;
  await get(at(p, 'baseline'), agent);
  await get(at(p, 'baseline.text'), agent);
}

/** Parts `from`..`to` of `p`'s generation, AHEAD at a time, with their words while far behind; the next to ask for. */
async function parts(agent, p, from, to, far) {
  let next = from;
  while (next <= to) {
    const batch = [];
    for (let k = next; k <= to && k < next + AHEAD; k++) {
      batch.push(get(at(p, String(k)), agent).then(() => {
        if (k === p.newest && p.newestTo != null) record(w.latency, Date.now() - (p.anchorWallMs + (p.newestTo - p.anchorWorld) / 1000));
      }));
      if (p.newest - k > far) batch.push(get(at(p, `${k}.text`), agent));
    }
    await Promise.all(batch);
    next = Math.min(to + 1, next + AHEAD);
  }
  return next;
}

async function viewer(v) {
  const agent = new Agent({ keepAlive: true, maxSockets: 2 });
  const t0 = performance.now();
  w.joined++;
  try {
    let ptr = null;
    while (v.alive && !ptr) {
      try { ptr = await pointer(agent); await install(agent, ptr); } catch { ptr = null; await sleep(1000); }
    }
    if (!ptr) return;
    record(w.installed, performance.now() - t0); // the baseline drawn
    let active = ptr.generation, next = 0, live = false;
    const far = Math.ceil((BEHIND_US + CUT_US) / ptr.period);
    while (v.alive) {
      const started = performance.now();
      try {
        const p = await pointer(agent);
        if (p.generation !== active) {
          if (p.handoffFrom && p.handoffFrom === active && p.legacyNext != null) {
            next = await parts(agent, ptr, next, p.legacyNext - 1, far);
            w.crossed++;
          } else {
            await install(agent, p);
            w.reinstalls++;
          }
          active = p.generation;
          next = 0;
        }
        ptr = p;
        if (ptr.newest != null && next <= ptr.newest) {
          if (live && ptr.newest - next > far) { w.behind++; live = false; }
          next = await parts(agent, ptr, next, ptr.newest, far);
        }
        if (!live && ptr.newest != null && next > ptr.newest) {
          live = true;
          // The first picture is the live world drawn once; caught up again after falling behind is a recovery.
          if (v.drawn) w.recovered++;
          else { v.drawn = true; record(w.firstPicture, performance.now() - t0); }
        }
      } catch {
        // counted in get(); the page's worker also carries on at its next poll
      }
      await sleep(POLL_MS - (performance.now() - started));
    }
  } finally {
    agent.destroy();
    viewers.delete(v);
    w.left++;
  }
}

/** A slow reader: one socket asking for the baseline (and the pointer after it) that never reads its answers. */
function slowReader(p) {
  const url = at(p, 'baseline'), base = new URL(cfg.base);
  const s = connect(Number(base.port), base.hostname, () => {
    s.pause();
    const ask = (path) => `GET ${path} HTTP/1.1\r\nHost: ${base.host}\r\nConnection: keep-alive\r\n\r\n`;
    s.write(ask(url.pathname) + ask(new URL('pointer', streamUrl()).pathname));
  });
  s.on('error', () => fail('slow-reader'));
  slow.add(s);
}

// A driver never ends on one viewer's failure: it is counted (in get()) and the others carry on.
process.on('unhandledRejection', (e) => fail(`unhandled ${e?.code ?? e?.message ?? e}`));
process.on('message', async (m) => {
  if (m.init) {
    cfg = m.init;
    const r = await import(pathToFileURL(join(cfg.pkg, 'replica.js')).href);
    r.initSync({ module: readFileSync(join(cfg.pkg, 'replica_bg.wasm')) });
    readPointer = r.readPointer;
    process.send({ ready: true });
  } else if (m.add) {
    for (let k = 0; k < m.add; k++) {
      const v = { alive: true };
      viewers.add(v);
      setTimeout(() => viewer(v), (k / m.add) * m.overMs);
    }
  } else if (m.slow) {
    try {
      const p = await pointer(new Agent({ keepAlive: false }));
      for (let k = 0; k < m.slow; k++) slowReader(p);
    } catch { fail('slow-reader'); }
  } else if (m.unslow) {
    for (const s of slow) s.destroy();
    slow.clear();
  } else if (m.take) {
    const c = process.cpuUsage(cpu0);
    process.send({ took: { ...w, viewers: viewers.size, waiting: [...viewers].filter((v) => !v.drawn).length, slow: slow.size, cpuSeconds: (c.user + c.system) / 1e6, loopP99Ms: loop.percentile(99) / 1e6, loopMaxMs: loop.max / 1e6 } });
    w = fresh();
    cpu0 = process.cpuUsage();
    loop.reset();
  } else if (m.stop) {
    for (const v of viewers) v.alive = false;
    for (const s of slow) s.destroy();
    setTimeout(() => process.exit(0), 500);
  }
});

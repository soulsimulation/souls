// #2512: one driver process of the viewers bench (viewers.mjs starts --drivers of them, each with a share of the viewers).
// The parent decides who arrives, leaves and stalls; this process opens what the web page's entry opens (the world page,
// the snapshot, the config, the parts the snapshot names) and the world's socket:
// - a raw viewer: the WebSocket upgrade with compression offered on a raw socket, then frame headers only (frames.mjs):
//   frames, messages and their payload bytes as sent (compressed), never inflated; reopened after a close with the product
//   client's backoff (reconnectDelayMs; its tries count from the first message on a socket, the welcome);
// - a full viewer (the parent makes one in a hundred): the product client's own Connection (packages/client), which
//   inflates, keeps the replica and checks its view hash: first motion, resyncs and hash checks come from these;
// - a slow reader: a raw viewer that reads for 5 s after its upgrade (the join) and then stops reading; never reopened.
// Every second it sends the parent its counters (running totals), its CPU and memory, the HTTP answers and first-motion
// records since the last report, and who is still waiting for first motion. After a restart mark it records, per viewer,
// when its socket dropped and when a new one received its first message, and where the upgrade landed.
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { FrameCounter, upgradeRequest, parseUpgrade, pongFrame, closeFrame } from './frames.mjs';
import { reconnectDelayMs } from './stats.mjs';

const C = { bytes: 0, messages: 0, opens: 0, closes: 0, refused: 0, joins: 0, leaves: 0, reconnects: 0, fullBytes: 0, fullMessages: 0, resyncs: 0, heartbeats: 0, mismatches: 0, slowCut: 0 };
const viewers = new Map(), sampling = new Set();
let cfg = null, Connection = null, stopped = false, calls = [], motion = [], mark = null;
const MOTION_SAMPLED = 50, SLOW_READ_MS = 5000;

async function get(v, path) {
  try {
    const r = await fetch(`${cfg.base}/w/${cfg.slug}${path}`, { headers: { 'x-forwarded-for': v.address }, signal: AbortSignal.timeout(30_000) });
    const b = Buffer.from(await r.arrayBuffer());
    C.bytes += b.length; calls.push({ at: Date.now(), path: path.split('?')[0].replace(/[0-9a-f]{32}$/, '<part>'), status: r.status, cache: r.headers.get('x-sim-cache'), bytes: b.length });
    return r;
  } catch { calls.push({ at: Date.now(), path, status: 0, cache: null, bytes: 0 }); return null; }
}
async function open(v) {
  C.joins++;
  if (!cfg.stub) {
    const page = get(v, '/'), snap = get(v, '/v1/world/snapshot?defs=ref&cols=1'), conf = get(v, '/v1/config');
    v.full ? full(v) : raw(v);
    const r = await snap; await conf; await page;
    const parts = r ? ['x-defs-ref', 'x-ground-ref'].map((h) => r.headers.get(h)).filter((f) => /^[0-9a-f]{32}$/.test(f ?? '')) : [];
    await Promise.all(parts.map((f) => get(v, `/v1/world/part/${f}`)));
  } else raw(v);
}

/** A raw viewer's socket: upgrade, then count frames; reopened after a close unless it left (or is a slow reader). */
function raw(v) {
  if (stopped || v.left) return;
  const s = v.sock = connect(cfg.port, '127.0.0.1'), t0 = Date.now(); let acc = null, opened = false, code = null, counter = null;
  v.sockets++;
  s.setNoDelay(true);
  s.on('connect', () => s.write(upgradeRequest({ host: `127.0.0.1:${cfg.port}`, path: cfg.wsPath, address: v.address })));
  s.on('data', (b) => {
    if (!opened) {
      acc = acc ? Buffer.concat([acc, b]) : b;
      const u = parseUpgrade(acc);
      if (!u) { if (acc.length > 65536) s.destroy(); return; }
      acc = null;
      if (u.status !== 101) { s.destroy(); return; }
      opened = true; C.opens++; v.landed = u.headers['x-sim-served-by'] ?? 'world';
      let first = true;
      counter = new FrameCounter({
        onPing: (p) => s.write(pongFrame(p)),
        onClose: (c) => { code = c; s.end(closeFrame(c)); },
        onData: (len, fin) => {
          if (!v.slow) { C.bytes += len; if (fin) C.messages++; }   // a slow reader's 5 s of reading is not a viewer's stream
          if (first) { first = false; v.retry = 0; if (mark && v.dropped && v.backAt == null && t0 >= mark.at) v.backAt = Date.now(); }
        },
      });
      if (v.slow) setTimeout(() => { if (!s.destroyed) s.pause(); }, SLOW_READ_MS);
      b = u.rest; if (!b.length) return;
    }
    counter.feed(b);
  });
  s.on('error', () => {});
  s.on('close', () => {
    if (opened) C.closes++; else C.refused++;
    if (mark && v.inMark && !v.dropped) v.dropped = Date.now();
    if (v.slow) { if (!v.left && !stopped) { C.slowCut++; v.cutAt = Date.now(); } return; }
    if (stopped || v.left) return;
    C.reconnects++;
    v.timer = setTimeout(() => raw(v), reconnectDelayMs(v.retry, code));
    v.retry++;
  });
}

/** A full viewer: the product client's Connection over Node's WebSocket (which inflates), with its own reconnects. */
function full(v) {
  const t0 = performance.now(), last = { bytesIn: 0, msgsIn: 0, resyncs: 0, heartbeats: 0, reconnects: 0 };
  if (sampling.size < MOTION_SAMPLED) { v.waiting = true; v.motionAt = Date.now(); sampling.add(v); }
  const conn = v.conn = new Connection(`ws://127.0.0.1:${cfg.port}${cfg.wsPath.split('?')[0]}`, async () => null, {
    onTakes: (st) => { if (v.waiting && st?.chunks?.length) { v.waiting = false; sampling.delete(v); motion.push({ at: v.motionAt, ms: performance.now() - t0 }); } },
    onWelcome: () => { if (mark && v.dropped && v.backAt == null) v.backAt = Date.now(); },
  }, (u) => {
    const ws = new WebSocket(u, { headers: { 'x-forwarded-for': v.address } });
    ws.addEventListener('open', () => { C.opens++; });
    ws.addEventListener('close', () => { C.closes++; if (mark && v.inMark && !v.dropped) v.dropped = Date.now(); });
    return ws;
  });
  // the client's resync reasons ('view hash mismatch at tick …', 'gap: …'): a mismatch is a failed replica hash check
  const resync = conn.resync.bind(conn);
  conn.resync = (reason) => { if (/^view hash mismatch/.test(reason)) C.mismatches++; return resync(reason); };
  v.drain = () => {
    const s = conn.stats;
    C.fullBytes += s.bytesIn - last.bytesIn; C.fullMessages += s.msgsIn - last.msgsIn; C.resyncs += s.resyncs - last.resyncs; C.heartbeats += s.heartbeats - last.heartbeats; C.reconnects += s.reconnects - last.reconnects;
    Object.assign(last, { bytesIn: s.bytesIn, msgsIn: s.msgsIn, resyncs: s.resyncs, heartbeats: s.heartbeats, reconnects: s.reconnects });
  };
  conn.connect();
}

function leave(v) {
  if (!v || v.left) return;
  v.left = true; C.leaves++; clearTimeout(v.timer);
  if (v.waiting) { v.waiting = false; sampling.delete(v); }   // it did not wait: left out of first motion, not a miss
  try { v.drain?.(); v.conn?.close(); } catch { /* closed */ }
  try { v.sock?.destroy(); } catch { /* closed */ }
  viewers.delete(v.id);
}

function report() {
  for (const v of viewers.values()) v.drain?.();
  const u = process.cpuUsage();
  process.send?.({ op: 'stats', counters: { ...C }, cpuS: (u.user + u.system) / 1e6, rssMb: process.memoryUsage().rss / 2 ** 20, calls, motion,
    waiting: [...sampling].map((v) => ({ at: v.motionAt })), slowOpen: [...viewers.values()].filter((v) => v.slow && !v.cutAt).length });
  calls = []; motion = [];
}

process.on('message', async (m) => {
  if (m.op === 'init') {
    cfg = m;
    if (!m.stub) Connection = (await import(pathToFileURL(join(m.root, 'packages/client/src/index.ts')).href)).Connection;
    setInterval(report, 1000).unref();
    process.send?.({ op: 'ready' });
  } else if (m.op === 'add') {
    const v = { id: m.id, address: m.address, full: m.full && !!Connection, slow: !!m.slow, retry: 0, sockets: 0 };
    viewers.set(v.id, v); void open(v);
  } else if (m.op === 'leave') for (const id of m.ids) leave(viewers.get(id));
  else if (m.op === 'mark') {
    mark = { at: m.at };
    for (const v of viewers.values()) if (!v.slow) Object.assign(v, { inMark: true, dropped: null, backAt: null });
  } else if (m.op === 'restart') {
    const rows = [...viewers.values()].filter((v) => v.inMark).map((v) => ({ dropped: v.dropped ? v.dropped - mark.at : null, back: v.backAt ? v.backAt - mark.at : null, landed: v.landed ?? null, full: v.full }));
    process.send?.({ op: 'restart', rows });
  } else if (m.op === 'stop') {
    stopped = true; report();
    for (const v of [...viewers.values()]) leave(v);
    setTimeout(() => process.exit(0), 200);
  }
});
process.on('disconnect', () => process.exit(0));

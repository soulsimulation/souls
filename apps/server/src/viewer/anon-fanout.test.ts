// #2520: anonymous viewers on their own sender (SIM_ANON_FANOUT=1). The oracle is V1's (hub-join-cache.test.ts): two product
// Connections watch the same world while six Souls walk, one on the hub's path (a bare /ws and a frame hello) and one on the
// fanout (the page's URL hello); both must reach the same replica state, heartbeat by heartbeat, and see the same log,
// talk, plays and takes, through a join mid-stream, a resume after a dropped socket and a resync. The clock is driven tick
// by tick; Date is mocked so rate limits and the join picture's age are exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { WebSocket } from 'ws';
import { Connection } from '@souls/client';
import { marsFactory, EDEN_COMMONS_WORLD } from '@souls/engine-mars';
import { anonymousHello } from '../../../../packages/client/src/hello.ts';
import { Db } from '../db.ts';
import { WorldHost } from '../world.ts';
import { config } from '../config.ts';
import { Auth } from '../auth.ts';
import { Brain } from '../brain.ts';
import { Souls } from '../souls.ts';
import { Hub } from '../hub.ts';
import { buildApp } from '../http.ts';
import { optionsFor } from '../deck.ts';

const factory = await marsFactory(EDEN_COMMONS_WORLD);
type Seen = { raw: string[]; logs: Set<number>; talk: Set<number>; plays: Set<number>; takeEnds: Set<number>; hashes: Map<number, string>; mismatches: number; sockets: WebSocket[];
  /** While `rec`: every live message by type (raw frames; `kernel*` and `takes*` decoded, since each path encodes them per peer). */
  rec: boolean; live: Map<string, string[]> };
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(ok(), what); };

async function world(t: import('node:test').TestContext, name: string, fanout = true) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const db = new Db(':memory:'), host = new WorldHost(db, factory, name, 1e9, name); host.boot(); host.drainInputs();
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) void host.enqueue('birth', 'test', { soulId: `s_${n}`, entityId: `h_${n}`, name: n, description: 'test soul', owner: 'system' });
  for (let i = 0; i < 3; i++) { host.tickOnce(); host.drainInputs(); }
  for (let i = 0; i < 3; i++) db.saveTalk(host.worldId, { tick: i, at: 0, from: 's_a', to: 's_b', fromName: 'a', toName: 'b', act: 'say', text: `line ${i}`, place: null });
  const cfg = { ...config, worldId: host.worldId, worldKey: 'eden', brainMode: 'fake' as const, budgetUsdPerDay: 0, typesafeKey: undefined, anthropicKey: undefined, publicUrl: 'http://127.0.0.1:0',
    env: { ...config.env, SIM_ANON_FANOUT: fanout ? '1' : '0' } };
  host.config = cfg;
  let app: ReturnType<typeof buildApp> | undefined;
  const server = createServer((req, res) => { if (app) return getRequestListener(app.fetch)(req, res); res.statusCode = 404; res.end(); });
  const auth = new Auth(cfg, db), hub = new Hub(server, host, auth, db);
  // the sink as world-main wires it: the brain's live lines are broadcast
  const brain = new Brain(host, db, cfg, { clients: () => host.viewerCount(), onCall: (c) => hub.brainCall(c), onCamera: (line) => hub.broadcast({ t: 'camera', line }),
    onTicker: (lines) => hub.broadcast({ t: 'ticker', lines }), onNarrative: (view) => hub.broadcast({ t: 'narrative', view }), onTalk: (lines) => hub.broadcast({ t: 'talk', lines }) });
  hub.brain = brain;
  app = buildApp({ cfg, db, host, auth, hub, brain, souls: new Souls(host, db, brain, cfg) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  const conns: Connection[] = [], raws: WebSocket[] = [];
  t.after(async () => { for (const c of conns) c.close(); for (const w of raws) w.terminate(); await hub.closeClients('stopping'); hub.stopTimers(); brain.quiesce(); server.close(); host.stop(); db.close(); });
  let k = 0;
  /** `ticks` world ticks (20 a second), each Soul choosing an act every 170, the event loop turning after each. */
  const drive = async (ticks: number) => {
    for (let i = 0; i < ticks; i++, k++) {
      if (k % 170 === 7) for (const m of host.minds.values()) {
        const opts = optionsFor(host, m); if (!opts.length) continue; const o = opts[(k + m.name.charCodeAt(0)) % opts.length];
        void host.enqueue('decision', 'test', { soulId: m.soulId, entityId: m.entityId, option: o.id, label: o.label, steps: o.steps, reevalTicks: 600, fallback: false, trigger: 'test', card: o.card, target: o.cardTarget, manner: 'warmly', approachLen: o.approachLen });
      }
      host.tickOnce(); await turn();
    }
  };
  /** A product client as the page opens it (all take transports, columns). `fanout`: it says hello in the URL, as the page's
   *  entry socket does (its frame hello then falls within the 3 s hello spacing and is ignored, as on the hub). */
  const viewer = (onFanout: boolean) => {
    const seen: Seen = { raw: [], logs: new Set(), talk: new Set(), plays: new Set(), takeEnds: new Set(), hashes: new Map(), mismatches: 0, sockets: [], rec: false, live: new Map() };
    const c: Connection = new Connection(`ws://127.0.0.1:${port}/ws`, async () => null, {
      onLog: (es) => { for (const e of es) seen.logs.add(e.seq); }, onTalk: (ls) => { for (const l of ls) seen.talk.add(l.id); },
      onPlays: (ps) => { for (const p of ps) seen.plays.add(p.seq); }, onTakes: (m) => { for (const ch of m.chunks) seen.takeEnds.add((ch as { toTick: number }).toTick); keep(seen, 'takes*', JSON.stringify(m)); },
      onKernel: (v) => keep(seen, 'kernel*', JSON.stringify(v)),
      onChange: () => { const hb = c.heartbeat; if (hb && c.replica.seq === hb.seq && !seen.hashes.has(hb.seq)) seen.hashes.set(hb.seq, c.replica.viewHash(hb.tick)); if (c.stats.lastCheck === 'mismatch') seen.mismatches++; },
    }, (u) => {
      const url = new URL(u); if (onFanout && !url.searchParams.has('hello')) url.searchParams.set('hello', anonymousHello(true));
      const ws = new WebSocket(url.href); seen.sockets.push(ws);
      ws.on('message', (d) => { const s = String(d), t = /^\{"t":"([a-z-]+)"/.exec(s)?.[1] ?? '?'; seen.raw.push(s); if (!PER_PEER.has(t)) keep(seen, t, s); }); return ws as never;
    }, undefined, undefined, undefined, true);
    conns.push(c); return { c, seen };
  };
  /** A raw socket and the messages it got. */
  const raw = async (path: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`), got: { t: string; [k: string]: unknown }[] = []; raws.push(ws);
    let closed: number | null = null; ws.on('close', (code) => { closed = code; });
    ws.on('message', (d) => got.push(JSON.parse(String(d)))); await once(ws, 'open'); return { ws, got, closed: () => closed };
  };
  return { host, hub, brain, drive, viewer, raw, port, t };
}
/** Encoded per peer (compared decoded) or answering this peer only. */
const PER_PEER = new Set(['takes', 'take-chunks', 'take-entities', 'take-boundary-wire', 'kernel', 'kernel-tick', 'pong']);
const keep = (s: Seen, t: string, x: string) => { if (s.rec) { let l = s.live.get(t); if (!l) s.live.set(t, l = []); l.push(x); } };
/** Both viewers record every live message while the world runs `ticks`, from quiet to quiet; then each type must match. */
async function live(w: { drive: (n: number) => Promise<void>; host: WorldHost }, a: Seen, b: Seen, conns: Connection[], ticks: number) {
  const quiet = async () => { await until(() => conns.every((c) => c.replica.seq === w.host.currentBatchSeq), 'caught up'); await new Promise((r) => setTimeout(r, 50)); };
  await quiet(); a.live.clear(); b.live.clear(); a.rec = b.rec = true;
  await w.drive(ticks); await quiet(); a.rec = b.rec = false;
  assert.deepEqual([...b.live.keys()].sort(), [...a.live.keys()].sort(), 'the same message types, live');
  for (const k of ['batch', 'heartbeat', 'plays', 'kernel*', 'takes*']) assert.ok((a.live.get(k)?.length ?? 0) > 0, `live ${k}`);
  for (const [k, xs] of a.live) assert.deepEqual(b.live.get(k), xs, `live ${k}: the same messages in the same order`);
}
const isTake = (m: { t: string }) => m.t === 'takes' || m.t === 'take-chunks' || m.t === 'take-entities' || m.t === 'take-boundary-wire';
const count = (s: Seen, t: string) => s.raw.filter((x) => x.startsWith(`{"t":"${t}"`)).length;
const from = (a: Set<number>, b: Set<number>) => { const lo = Math.max(Math.min(...a), Math.min(...b)); return [[...a].filter((x) => x >= lo).sort((x, y) => x - y), [...b].filter((x) => x >= lo).sort((x, y) => x - y)]; };
const fanoutSize = (hub: Hub) => hub.fanout!.size;

/** V1's oracle: the same replica state at every heartbeat both saw, and the same log, talk, plays and takes. */
function oracle(hubSide: { c: Connection; seen: Seen }, fan: { c: Connection; seen: Seen }, resyncs: [number, number]) {
  assert.deepEqual([hubSide.c.stats.resyncs, fan.c.stats.resyncs], resyncs, 'resyncs (hub, fanout)');
  assert.deepEqual([hubSide.seen.mismatches, fan.seen.mismatches], [0, 0], 'no view hash mismatch');
  const common = [...hubSide.seen.hashes.keys()].filter((s) => fan.seen.hashes.has(s));
  assert.ok(common.length >= 10, `heartbeats compared over 60 s: ${common.length}`);
  for (const s of common) assert.equal(fan.seen.hashes.get(s), hubSide.seen.hashes.get(s), `viewHash at heartbeat seq ${s}`);
  assert.equal(fan.c.stats.lastCheck, 'ok'); assert.equal(hubSide.c.stats.lastCheck, 'ok');
  const [la, lb] = from(hubSide.seen.logs, fan.seen.logs); assert.ok(la.length > 0, 'log events'); assert.deepEqual(lb, la, 'log sequences');
  assert.deepEqual([...fan.seen.talk].sort(), [...hubSide.seen.talk].sort(), 'talk ids'); assert.ok(hubSide.seen.talk.size > 0);
  assert.deepEqual([...fan.seen.plays].sort(), [...hubSide.seen.plays].sort(), 'play sequences'); assert.ok(hubSide.seen.plays.size > 0, 'cards were played');
  const [ta, tb] = from(hubSide.seen.takeEnds, fan.seen.takeEnds); assert.deepEqual(tb, ta, 'take end ticks'); assert.ok(ta.length >= 50, 'takes');
}

test('A1: a fanout viewer and a hub viewer hold the same replica for 60 s through a join mid-stream, a resume and a resync', async (t) => {
  const w = await world(t, 'anon-fanout-a1');
  await w.drive(40);
  const hubSide = w.viewer(false); hubSide.c.connect(); await until(() => hubSide.c.replica.ready, 'the hub viewer has its snapshot');
  assert.equal(w.hub.clients.size, 1, 'a bare /ws stays on the hub');
  await w.drive(30); t.mock.timers.tick(1_500);                    // mid-stream, the shared picture 1.5 s old
  const fan = w.viewer(true); fan.c.connect(); await until(() => fan.c.replica.ready, 'the fanout viewer has its snapshot');
  assert.deepEqual([w.hub.clients.size, fanoutSize(w.hub)], [1, 1], 'the URL hello went to the fanout');
  await live(w, hubSide.seen, fan.seen, [hubSide.c, fan.c], 400);
  // #2521: the fanout's frames are its own shared compressed ones, and the product client decodes them (the oracle below)
  const s0 = fan.seen.sockets[0] as unknown as WebSocket & { _socket: { bytesRead: number } };
  assert.ok(s0.extensions.includes('permessage-deflate'), 'the fanout socket negotiated permessage-deflate');
  const decoded = fan.seen.raw.reduce((n, x) => n + Buffer.byteLength(x), 0);
  assert.ok(s0._socket.bytesRead < decoded / 2, `compressed on the wire: ${s0._socket.bytesRead} bytes read for ${decoded} decoded`);
  // resume: the socket drops; the Connection comes back with since and the hub's epoch in its URL hello
  const snapshots = count(fan.seen, 'snapshot'), batchesBefore = count(fan.seen, 'batch');
  fan.seen.sockets.at(-1)!.terminate();
  await until(() => fan.seen.sockets.length === 2 && fan.c.stats.state === 'open' && fanoutSize(w.hub) === 1, 'the fanout viewer reconnected');
  await w.drive(20);
  await until(() => fan.c.replica.seq === w.host.currentBatchSeq, 'the fanout viewer resumed');
  assert.equal(new URL(fan.seen.sockets[1].url).searchParams.get('hello')!.includes('"since"'), true, 'the reconnect resumed from its seq');
  assert.equal(count(fan.seen, 'snapshot'), snapshots, 'a resume, not a new picture');
  assert.ok(count(fan.seen, 'batch') > batchesBefore, 'the batches it missed were replayed');
  await live(w, hubSide.seen, fan.seen, [hubSide.c, fan.c], 400);
  // resync: answered with the picture and the batches after it
  t.mock.timers.tick(3_100);
  fan.c.resync('test');
  await until(() => count(fan.seen, 'snapshot') === snapshots + 1, 'the resync snapshot');
  await live(w, hubSide.seen, fan.seen, [hubSide.c, fan.c], 400);
  await until(() => fan.c.replica.seq === w.host.currentBatchSeq && hubSide.c.replica.seq === w.host.currentBatchSeq, 'both caught up');
  oracle(hubSide, fan, [0, 1]);
});

test('A2: a recovery re-pictures fanout viewers and they converge; clock-unavailable closes them with 1013 (try later)', async (t) => {
  const w = await world(t, 'anon-fanout-a2');
  await w.drive(40);
  const hubSide = w.viewer(false); hubSide.c.connect(); await until(() => hubSide.c.replica.ready, 'the hub viewer has its snapshot');
  const fan = w.viewer(true); fan.c.connect(); await until(() => fan.c.replica.ready, 'the fanout viewer has its snapshot');
  await w.drive(300);
  const before = count(fan.seen, 'snapshot');
  for (const l of w.host.listeners) l.onApplied?.({ seq: 1, tick: 0, kind: 'rules', author: 'world:recovery', payload: { recovery: {} }, at: 0 } as never);
  await until(() => count(fan.seen, 'snapshot') === before + 1, 'the fanout viewer got the picture again');
  const r = JSON.parse(fan.seen.raw.filter((s) => s.startsWith('{"t":"snapshot"')).at(-1)!) as { tick: number; seq: number };
  assert.deepEqual([r.tick, r.seq], [w.host.engine.world.tick, w.host.currentBatchSeq], 'a picture of now, not the one from before the recovery');
  await live(w, hubSide.seen, fan.seen, [hubSide.c, fan.c], 1_000);
  await until(() => fan.c.replica.seq === w.host.currentBatchSeq && hubSide.c.replica.seq === w.host.currentBatchSeq, 'both caught up');
  oracle(hubSide, fan, [0, 0]);
  // the clock becomes unavailable
  const closed = once(fan.seen.sockets.at(-1)!, 'close');
  (w.host as unknown as { clockFailure: unknown }).clockFailure = new Error('test: clock unavailable');
  for (const l of w.host.listeners) l.onClockUnavailable?.();
  const [code] = await closed as [number];
  assert.equal(code, 1013, 'try again later');
});

test('A3: with viewers only on the fanout the world is watched, counted in all six places, and takes go out; a join wakes it', async (t) => {
  const w = await world(t, 'anon-fanout-a3');
  await w.drive(40);
  const woke = t.mock.method(w.host, 'wake');
  assert.deepEqual([w.host.viewerCount(), w.host.watched!(), w.brain.sink.clients()], [0, false, 0], 'nobody yet');
  const v = await w.raw(`/ws?hello=${encodeURIComponent(anonymousHello(true))}`);
  await until(() => v.got.some(isTake), 'the join set');
  assert.ok(woke.mock.callCount() >= 1, 'the join woke the world');
  assert.deepEqual([w.hub.clients.size, fanoutSize(w.hub)], [0, 1], 'the viewer is on the fanout only');
  assert.equal(w.host.viewerCount(), 1, 'host.viewerCount()');
  assert.equal(w.host.watched!(), true, '1/6 host.watched');
  assert.equal(w.brain.sink.clients(), 1, '2/6 the brain (director and talk), its sink wired as world-main wires it');
  assert.equal(w.hub.stats().clients, 1, '3/6 stats()');
  const health = await (await fetch(`http://127.0.0.1:${w.port}/healthz`)).json() as { clients: number };
  assert.equal(health.clients, 1, '4/6 /healthz');
  const takesBefore = v.got.filter(isTake).length;
  await w.drive(120);
  await until(() => v.got.some((m) => m.t === 'heartbeat'), 'a heartbeat');
  assert.equal(v.got.find((m) => m.t === 'heartbeat')!.clients, 1, '5/6 the heartbeat\'s clients');
  const takesAfter = v.got.filter(isTake).length;
  assert.ok(takesAfter > takesBefore, '6/6 takes are broadcast (the afterTick skip sees the fanout viewer)');
  // a signed-in hello on the anonymous socket is closed with 4401
  w.t.mock.timers.tick(3_100);
  v.ws.send(JSON.stringify({ t: 'hello', proto: 1, token: 'x' }));
  await until(() => v.closed() !== null, 'closed');
  assert.equal(v.closed(), 4401);
  await until(() => w.host.viewerCount() === 0, 'the count drops when it leaves');
});

test('A4: flag off, a URL hello stays on the hub', async (t) => {
  const w = await world(t, 'anon-fanout-a4', false);
  await w.drive(40);
  assert.equal(w.hub.fanout, null);
  const v = await w.raw(`/ws?hello=${encodeURIComponent(anonymousHello(true))}`);
  await until(() => v.got.some(isTake), 'the join set');
  assert.deepEqual([w.hub.clients.size, w.host.viewerCount(), w.host.watched!()], [1, 1, true]);
});

test('#2522 A2: a fanout viewer that stalls for 10 s is skipped, re-pictured when it reads again, and converges with no reconnect; the others lose nothing', async (t) => {
  const w = await world(t, 'anon-fanout-behind');
  await w.drive(40);
  const hubSide = w.viewer(false); hubSide.c.connect(); await until(() => hubSide.c.replica.ready, 'the hub viewer has its snapshot');
  const fan = w.viewer(true); fan.c.connect(); await until(() => fan.c.replica.ready, 'the fanout viewer has its snapshot');
  const other = w.viewer(true); other.c.connect(); await until(() => other.c.replica.ready, 'an ordinary fanout viewer has its snapshot');
  await w.drive(100);
  const conns = [hubSide.c, fan.c, other.c], counts = w.hub.fanout!.counts;
  const quiet = async (cs: Connection[]) => { await until(() => cs.every((c) => c.replica.seq === w.host.currentBatchSeq), 'caught up'); await new Promise((r) => setTimeout(r, 50)); };
  await quiet(conns);
  // the stall: its socket is not read for 10 s while the world runs; public lines too large to compress (about 0.3 MB on the
  // wire each, which the readers read as they come) take it past the kernel's buffers and 1 MB unsent
  const sock = (fan.seen.sockets[0] as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  hubSide.seen.live.clear(); other.seen.live.clear(); hubSide.seen.rec = other.seen.rec = true;
  sock.pause();
  const tickers = count(other.seen, 'ticker');
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 4; k++) {
      w.hub.broadcast({ t: 'ticker', lines: [{ tick: w.host.engine.world.tick, text: randomBytes(300_000).toString('base64') }] });
      await until(() => count(other.seen, 'ticker') === tickers + 4 * i + k + 1 && count(hubSide.seen, 'ticker') === count(other.seen, 'ticker'), 'the readers read it');
    }
    await w.drive(5); t.mock.timers.tick(250);
  }
  assert.equal(counts.behind, 1, 'the stalled socket was marked behind');
  assert.equal(counts.repictures, 0, 'and not re-pictured while it is stalled');
  // it reads again: once its queue drains it gets the picture and the batches after it
  const snapshots = count(fan.seen, 'snapshot');
  sock.resume();
  // the queue drains in real time (a loaded runner takes longer), so wait on the clock, not on a count of ticks
  for (const stop = performance.now() + 20_000; performance.now() < stop && counts.repictures === 0;) { await w.drive(1); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(counts.repictures, 1, 're-pictured once its queue drained');
  await quiet(conns); hubSide.seen.rec = other.seen.rec = false;
  // A4: an ordinary fanout viewer got every live message the hub viewer got, the same and in the same order
  assert.deepEqual([...other.seen.live.keys()].sort(), [...hubSide.seen.live.keys()].sort(), 'the same message types');
  for (const k of ['batch', 'heartbeat', 'ticker', 'kernel*', 'takes*']) assert.ok((hubSide.seen.live.get(k)?.length ?? 0) > 0, `live ${k}`);
  for (const [k, xs] of hubSide.seen.live) assert.deepEqual(other.seen.live.get(k), xs, `live ${k}: the same messages in the same order`);
  assert.equal(count(fan.seen, 'snapshot'), snapshots + 1, 'one picture again');
  assert.deepEqual([fan.seen.sockets.length, fan.c.stats.state, fan.c.stats.resyncs], [1, 'open', 0], 'no reconnect, no resync asked');
  // converged: V1's oracle bars from the re-picture on (what fell while it was behind was skipped by design)
  for (const s of [hubSide.seen, fan.seen]) { s.logs.clear(); s.talk.clear(); s.plays.clear(); s.takeEnds.clear(); s.hashes.clear(); }
  await live(w, hubSide.seen, fan.seen, [hubSide.c, fan.c], 400);
  await w.drive(800);
  await until(() => fan.c.replica.seq === w.host.currentBatchSeq && hubSide.c.replica.seq === w.host.currentBatchSeq, 'both caught up');
  oracle(hubSide, fan, [0, 0]);
  assert.equal(other.seen.mismatches, 0);
});

test('#2522 A5: in green, a fanout viewer that stops reading for 30 s at 200 KB/s stays connected through the ping sweep, then gets one picture and converges', async (t) => {
  const w = await world(t, 'anon-fanout-a5');
  await w.drive(40);
  const hubSide = w.viewer(false); hubSide.c.connect(); await until(() => hubSide.c.replica.ready, 'the hub viewer has its snapshot');
  const fan = w.viewer(true); fan.c.connect(); await until(() => fan.c.replica.ready, 'the fanout viewer has its snapshot');
  await w.drive(100);
  await until(() => [hubSide.c, fan.c].every((c) => c.replica.seq === w.host.currentBatchSeq), 'caught up');
  const fanout = w.hub.fanout!, counts = fanout.counts, server = [...fanout.wss.clients][0];
  const load = () => (w.hub as unknown as { loadLevel: string }).loadLevel;
  assert.equal(load(), 'green');
  const pings = t.mock.method(server, 'ping');
  // 30 s of real time (two or three 15 s ping sweeps, the real interval) with its socket not read, the world running and
  // public lines of about 10 KB on the wire every 50 ms; Date is not moved, so every sweep judges
  const sock = (fan.seen.sockets[0] as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  sock.pause();
  const end = performance.now() + 30_000;
  while (performance.now() < end) {
    w.hub.broadcast({ t: 'ticker', lines: [{ tick: w.host.engine.world.tick, text: randomBytes(11_000).toString('base64') }] });
    await w.drive(1); await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(pings.mock.callCount() >= 1, 'the sweep pinged it while it was not reading');
  assert.notEqual(load(), 'black', 'not black, so the sweep judged');
  assert.equal(counts.behind, 1, 'it was marked behind');
  assert.deepEqual([server.readyState, fanout.size, fan.seen.sockets.length], [1, 1, 1], 'the sweep did not end it: still connected, on its one socket');
  // it reads again: one picture, the same socket, then V1's oracle bars against the hub viewer
  const snapshots = count(fan.seen, 'snapshot');
  sock.resume();
  // the queue drains in real time (a loaded runner takes longer), so wait on the clock, not on a count of ticks
  for (const stop = performance.now() + 20_000; performance.now() < stop && counts.repictures === 0;) { await w.drive(1); await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(counts.repictures, 1, 're-pictured once its queue drained');
  await until(() => [hubSide.c, fan.c].every((c) => c.replica.seq === w.host.currentBatchSeq), 'caught up after the picture');
  assert.equal(count(fan.seen, 'snapshot'), snapshots + 1, 'one picture again');
  assert.deepEqual([fan.seen.sockets.length, fan.c.stats.state, fan.c.stats.resyncs], [1, 'open', 0], 'no reconnect, no resync asked');
  for (const s of [hubSide.seen, fan.seen]) { s.logs.clear(); s.talk.clear(); s.plays.clear(); s.takeEnds.clear(); s.hashes.clear(); }
  await live(w, hubSide.seen, fan.seen, [hubSide.c, fan.c], 400);
  await w.drive(800);
  await until(() => fan.c.replica.seq === w.host.currentBatchSeq && hubSide.c.replica.seq === w.host.currentBatchSeq, 'both caught up');
  oracle(hubSide, fan, [0, 0]);
});

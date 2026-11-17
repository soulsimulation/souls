// #2519: a token-less join is answered from one shared join picture (the snapshot and log list, at most 2 s old) and then
// every ring batch after it. The oracle is the product client: two Connections (each with its Replica) join the same world
// at the same moment, one with the cache off (a fresh snapshot) and one on (the shared picture, built earlier), while six
// Souls walk; both must reach the same replica state, heartbeat by heartbeat, with no resync. The world clock is driven
// tick by tick; Date is mocked so the picture's age is exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Connection } from '@souls/client';
import { marsFactory, EDEN_COMMONS_WORLD } from '@souls/engine-mars';
import { anonymousHello } from '../../../packages/client/src/hello.ts';
import { Db } from './db.ts';
import { WorldHost } from './world.ts';
import { config } from './config.ts';
import { Auth } from './auth.ts';
import { Hub } from './hub.ts';
import { optionsFor } from './deck.ts';

const factory = await marsFactory(EDEN_COMMONS_WORLD);
type Seen = { raw: string[]; logs: Set<number>; talk: Set<number>; plays: Set<number>; takeEnds: Set<number>; hashes: Map<number, string>; mismatches: number };
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(ok(), what); };

async function world(t: import('node:test').TestContext, name: string) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const db = new Db(':memory:'), host = new WorldHost(db, factory, name, 1e9, name); host.boot(); host.drainInputs();
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) void host.enqueue('birth', 'test', { soulId: `s_${n}`, entityId: `h_${n}`, name: n, description: 'test soul', owner: 'system' });
  for (let i = 0; i < 3; i++) { host.tickOnce(); host.drainInputs(); }
  for (let i = 0; i < 3; i++) db.saveTalk(host.worldId, { tick: i, at: 0, from: 's_a', to: 's_b', fromName: 'a', toName: 'b', act: 'say', text: `line ${i}`, place: null });
  const cfg = { ...config, worldId: host.worldId, worldKey: 'eden', brainMode: 'fake' as const, budgetUsdPerDay: 0, publicUrl: 'http://127.0.0.1:0' };
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); }), hub = new Hub(server, host, new Auth(cfg, db), db);
  hub.brain = { camera: null, ticker: [], narratives: new Map(), inflight: new Map(), mode: 'fake', callsToday: 0 } as never;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  const conns: Connection[] = [];
  t.after(async () => { for (const c of conns) c.close(); await hub.closeClients('stopping'); hub.stopTimers(); server.close(); host.stop(); db.close(); });
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
  /** A product client as the page opens it (all take transports, columns), and what it saw. */
  const viewer = (cache: boolean) => {
    const seen: Seen = { raw: [], logs: new Set(), talk: new Set(), plays: new Set(), takeEnds: new Set(), hashes: new Map(), mismatches: 0 };
    const c: Connection = new Connection(`ws://127.0.0.1:${port}/ws`, async () => null, {
      onLog: (es) => { for (const e of es) seen.logs.add(e.seq); }, onTalk: (ls) => { for (const l of ls) seen.talk.add(l.id); },
      onPlays: (ps) => { for (const p of ps) seen.plays.add(p.seq); }, onTakes: (m) => { for (const ch of m.chunks) seen.takeEnds.add((ch as { toTick: number }).toTick); },
      onChange: () => { const hb = c.heartbeat; if (hb && c.replica.seq === hb.seq && !seen.hashes.has(hb.seq)) seen.hashes.set(hb.seq, c.replica.viewHash(hb.tick)); if (c.stats.lastCheck === 'mismatch') seen.mismatches++; },
    }, (u) => { (hub as unknown as { joinCacheOn: boolean }).joinCacheOn = cache; const ws = new WebSocket(u); ws.on('message', (d) => seen.raw.push(String(d))); return ws as never; }, undefined, undefined, undefined, true);
    conns.push(c); return { c, seen };
  };
  /** Both clients join now, the uncached one first; the cache flag is set as each socket opens. */
  // A join set ends with its takes message; a client's replica is ready at its snapshot, before the frames after it (the
  // replayed batches among them) have necessarily been read, so each join is awaited to its end
  const joined = (v: { seen: Seen }) => v.seen.raw.some((s) => /^\{"t":"(takes|take-entities|take-boundary-wire|take-chunks)"/.test(s));
  const pair = async () => {
    const off = viewer(false); off.c.connect(); await until(() => joined(off), 'the uncached client has its join set');
    const on = viewer(true); on.c.connect(); await until(() => joined(on), 'the cached client has its join set');
    return { off, on };
  };
  /** An anonymous page join that only builds the shared picture. */
  const prime = async () => {
    (hub as unknown as { joinCacheOn: boolean }).joinCacheOn = true;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?hello=${encodeURIComponent(anonymousHello(true))}`), raw: string[] = [];
    ws.on('message', (d) => raw.push(String(d)));
    await until(() => raw.some((s) => s.startsWith('{"t":"snapshot"')), 'the priming join has its snapshot');
    ws.close(); await once(ws, 'close'); return JSON.parse(raw.find((s) => s.startsWith('{"t":"snapshot"'))!) as { tick: number; seq: number };
  };
  return { host, hub, drive, pair, prime, t };
}
const snapshotOf = (s: Seen) => JSON.parse(s.raw.find((x) => x.startsWith('{"t":"snapshot"'))!) as { tick: number; seq: number };
const from = (a: Set<number>, b: Set<number>) => { const lo = Math.max(Math.min(...a), Math.min(...b)); return [[...a].filter((x) => x >= lo).sort((x, y) => x - y), [...b].filter((x) => x >= lo).sort((x, y) => x - y)]; };

/** The oracle: the same replica state at every heartbeat both saw, and the same log, talk, plays and takes. */
function oracle(off: { c: Connection; seen: Seen }, on: { c: Connection; seen: Seen }, resyncs: [number, number]) {
  assert.deepEqual([off.c.stats.resyncs, on.c.stats.resyncs], resyncs, 'resyncs (uncached, cached)');
  assert.deepEqual([off.seen.mismatches, on.seen.mismatches], [0, 0], 'no view hash mismatch');
  const common = [...off.seen.hashes.keys()].filter((s) => on.seen.hashes.has(s));
  assert.ok(common.length >= 10, `heartbeats compared over 60 s: ${common.length}`);
  for (const s of common) assert.equal(on.seen.hashes.get(s), off.seen.hashes.get(s), `viewHash at heartbeat seq ${s}`);
  assert.equal(on.c.stats.lastCheck, 'ok'); assert.equal(off.c.stats.lastCheck, 'ok');
  const [la, lb] = from(off.seen.logs, on.seen.logs); assert.ok(la.length > 0, 'log events'); assert.deepEqual(lb, la, 'log sequences');
  assert.deepEqual([...on.seen.talk].sort(), [...off.seen.talk].sort(), 'talk ids'); assert.ok(off.seen.talk.size > 0);
  assert.deepEqual([...on.seen.plays].sort(), [...off.seen.plays].sort(), 'play sequences'); assert.ok(off.seen.plays.size > 0, 'cards were played');
  assert.deepEqual([...on.seen.takeEnds].sort(), [...off.seen.takeEnds].sort(), 'take end ticks'); assert.ok(off.seen.takeEnds.size >= 50, 'takes');
}

test('A1: a join from the shared picture (1.5 s old, batches replayed) reaches the fresh join\'s replica for 60 s', async (t) => {
  const w = await world(t, 'hub-join-cache-a1');
  await w.drive(40);
  const primed = await w.prime();
  await w.drive(30); t.mock.timers.tick(1_500);     // the Souls walk on; the picture is 1.5 s old
  const { off, on } = await w.pair();
  const a = snapshotOf(off.seen), b = snapshotOf(on.seen);
  assert.deepEqual([b.tick, b.seq], [primed.tick, primed.seq], 'the cached client got the shared picture');
  assert.ok(a.tick > b.tick && a.seq > b.seq, 'and it is older than the fresh one');
  const replayed = on.seen.raw.filter((s) => s.startsWith('{"t":"batch"')).map((s) => JSON.parse(s).seq);
  assert.deepEqual(replayed, Array.from({ length: a.seq - b.seq }, (_, i) => b.seq + 1 + i), 'every batch after the picture, in order');
  assert.ok(on.seen.raw.findIndex((s) => s.startsWith('{"t":"log"')) < on.seen.raw.findIndex((s) => s.startsWith('{"t":"batch"')), 'its log before the batches');
  await w.drive(1_200);                              // 60 s
  await until(() => on.c.replica.seq === w.host.currentBatchSeq && off.c.replica.seq === w.host.currentBatchSeq, 'both clients caught up');
  oracle(off, on, [0, 0]);
});

test('A2: a join in the 2 s after a recovery takes a new picture; a resync is answered fresh; both converge', async (t) => {
  const w = await world(t, 'hub-join-cache-a2');
  await w.drive(40);
  const primed = await w.prime();
  await w.drive(20); t.mock.timers.tick(500);
  for (const l of w.host.listeners) l.onApplied?.({ seq: 1, tick: 0, kind: 'rules', author: 'world:recovery', payload: { recovery: {} }, at: 0 } as never);
  t.mock.timers.tick(500);                           // 1 s after the picture, 0.5 s after the recovery
  const { off, on } = await w.pair();
  const a = snapshotOf(off.seen), b = snapshotOf(on.seen);
  assert.ok(b.seq > primed.seq, 'not the picture from before the recovery');
  assert.deepEqual([b.tick, b.seq], [a.tick, a.seq], 'a picture of now');
  await w.drive(600);
  t.mock.timers.tick(2_100);                         // past the per-socket resync spacing
  const before = on.seen.raw.filter((s) => s.startsWith('{"t":"snapshot"')).length;
  on.c.resync('test');
  await until(() => on.seen.raw.filter((s) => s.startsWith('{"t":"snapshot"')).length === before + 1, 'the resync snapshot');
  const r = JSON.parse(on.seen.raw.filter((s) => s.startsWith('{"t":"snapshot"')).at(-1)!) as { tick: number; reason: string };
  assert.deepEqual([r.tick, r.reason], [w.host.engine.world.tick, 'resync: test'], 'answered from the world as it is now');
  await w.drive(600);
  await until(() => on.c.replica.seq === w.host.currentBatchSeq && off.c.replica.seq === w.host.currentBatchSeq, 'both clients caught up');
  oracle(off, on, [0, 1]);
});

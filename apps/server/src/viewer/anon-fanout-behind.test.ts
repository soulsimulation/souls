// #2522 (Scaling V4): a fanout viewer that cannot keep up is skipped and re-pictured, never queued without limit. Real
// sockets that stop reading (their TCP socket paused), against the fanout fed a synthetic public stream at 20 batches a
// second; Date is mocked so 120 s of the stream runs in a few seconds. A1: each stalled socket holds at most 1 MB plus one
// picture on the server, for 120 s (its queue, and the process's heap and buffers over 16 such sockets). A3: the fanout
// counts the sockets behind, and one that reads again is re-pictured. A4: viewers that keep reading get every batch in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate as turn } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTO } from '@souls/protocol';
import { AnonFanout, type PublicFeed } from './anon-fanout.ts';

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;
const MB = 1_000_000, STALLED = 16, SECONDS = 120, RING = 600;
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 4000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(ok(), what); };
/** The process's heap and buffers. */
const used = () => { gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };

/** A batch of about 10 KB: the stream runs at about 200 KB a second, so a stalled socket would queue 24 MB in 120 s. */
const batchOf = (seq: number) => JSON.stringify({ t: 'batch', seq, tick: seq, ops: Array.from({ length: 100 }, (_, i) => ({ op: 'move', id: `e${i}`, x: seq * 7 + i, y: (seq * 31 + i * 17) % 9973, note: `${seq}:${i}:${(seq * 2654435761 + i) % 4294967296}` })) });

test('A1, A3, A4: stalled sockets hold at most 1 MB plus one picture for 120 s; readers lose nothing; one that reads again is re-pictured', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  let seq = 0;
  // the join picture: about 220 KB, its seq the latest batch (so a join replays nothing after it)
  const entities = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}`, kind: 'thing', x: i, y: i * 3, label: `entity number ${i} with a name` }));
  const feed: PublicFeed = {
    welcome: () => ({ build: 'test', proto: PROTO, worldId: 'w', rulesVersion: 1, schema: 1, dt: 0.05, clockRate: 1, serverTick: seq, epoch: 'e', paused: false }) as never,
    join: () => ({ seq, snapshot: { t: 'snapshot', reason: 'join', seq, tick: seq, entities } as never, log: JSON.stringify({ t: 'log', events: [] }), rest: [] }),
    available: () => true, load: () => 'green',
  };
  const picture = Buffer.byteLength(JSON.stringify({ t: 'snapshot', reason: 'join', seq: 0, tick: 0, entities }));
  const fanout = new AnonFanout(feed);
  const server = createServer(); server.on('upgrade', (req, socket, head) => fanout.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port, socks: WebSocket[] = [];
  t.after(() => { for (const w of socks) w.terminate(); fanout.stopTimers(); server.close(); });
  /** A raw viewer with the page's URL hello; it keeps what it got as `b<seq>` (batch), `p<seq>` (picture) or the type. */
  const viewer = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?hello=${encodeURIComponent(JSON.stringify({ t: 'hello', proto: PROTO }))}`, { perMessageDeflate: false });
    socks.push(ws); const got: string[] = [];
    ws.on('message', (d) => { const s = String(d), ty = /^\{"t":"([a-z-]+)"/.exec(s)![1]; got.push(ty === 'batch' ? `b${/"seq":(\d+)/.exec(s)![1]}` : ty === 'snapshot' ? `p${(JSON.parse(s) as { seq: number }).seq}` : ty); });
    await once(ws, 'open');
    return { ws, got, seqs: () => got.filter((x) => x[0] === 'b').map((x) => Number(x.slice(1))), pictures: () => got.filter((x) => x[0] === 'p').length };
  };
  const pause = (v: { ws: WebSocket }, on: boolean) => { const s = (v.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket; if (on) s.pause(); else s.resume(); };
  const readers = [await viewer(), await viewer()], stalled = await Promise.all(Array.from({ length: STALLED }, viewer)), back = await viewer();
  await until(() => [...readers, ...stalled, back].every((v) => v.pictures() === 1), 'every viewer has its picture');
  assert.equal(fanout.size, STALLED + 3);
  for (const v of [...stalled, back]) pause(v, true);
  const serverSide = () => [...fanout.wss.clients];
  const before = used();
  let maxQueue = 0, maxUsed = 0;
  for (let s = 1; s <= SECONDS * 20; s++) {
    seq = s; fanout.pub('batch', batchOf(s)); t.mock.timers.tick(50);
    if (s % 20 === 0) {
      // a second of stream: the readers have read it (they keep up), the stalled sockets have not
      await until(() => readers.every((r) => r.seqs().at(-1) === s), `readers caught up at ${s}`);
      for (const ws of serverSide()) maxQueue = Math.max(maxQueue, ws.bufferedAmount);
    }
    if (s === 30 * 20) pause(back, false);                                         // 30 s in, one reads again
    if (s % (15 * 20) === 0) maxUsed = Math.max(maxUsed, used() - before);
    await turn();
  }
  // the ring of the last 600 batches is the fanout's own, whoever watches
  const ring = RING * batchOf(SECONDS * 20).length, perSocket = (maxUsed - ring) / STALLED;
  t.diagnostic(`largest server-side queue ${(maxQueue / MB).toFixed(2)} MB (picture ${(picture / MB).toFixed(2)} MB); the process's heap and buffers ${(perSocket / MB).toFixed(2)} MB per stalled socket at most (${STALLED} sockets, ring of ${(ring / MB).toFixed(1)} MB excluded); counts ${JSON.stringify(fanout.counts)}`);
  // A1: per stalled socket, at most 1 MB plus one picture (plus the one batch that crossed the line)
  const bound = MB + picture + 20_000;
  assert.ok(maxQueue <= bound, `a socket's server-side queue stayed under 1 MB plus one picture: ${maxQueue} <= ${bound}`);
  assert.ok(perSocket <= bound, `the process's memory per stalled socket stayed under 1 MB plus one picture: ${perSocket} <= ${bound}`);
  // A4: the readers got every batch, in order, and no second picture
  for (const r of readers) {
    assert.deepEqual(r.seqs(), Array.from({ length: SECONDS * 20 }, (_, i) => i + 1), 'a reader lost no batch');
    assert.equal(r.pictures(), 1, 'a reader got one picture');
  }
  // A3: the stalled sockets were counted behind; the one that read again was re-pictured and then followed the stream
  assert.ok(fanout.counts.behind >= STALLED + 1, `behind counted: ${fanout.counts.behind}`);
  assert.ok(fanout.counts.repictures >= 1, `re-pictures counted: ${fanout.counts.repictures}`);
  await until(() => back.seqs().at(-1) === SECONDS * 20, 'the socket that read again follows the stream');
  const at = back.got.map((x) => x[0]).lastIndexOf('p'), from = Number(back.got[at].slice(1));
  assert.equal(back.pictures(), 2, 'it got the picture again');
  assert.deepEqual(back.got.slice(at + 1).filter((x) => x[0] === 'b'), Array.from({ length: SECONDS * 20 - from }, (_, i) => `b${from + 1 + i}`), 'after its picture, every batch in order');
  assert.ok(back.seqs().length < SECONDS * 20, 'it was skipped while behind');
  // a socket behind for more than 60 s is closed with "try later" (a stalled reader cannot read the close frame)
  assert.equal(serverSide().filter((ws) => ws.readyState !== 1).length, STALLED, 'the stalled sockets were closed after 60 s behind');
});

test('A5: the ping sweep still ends a dead socket (no answer, its ping handed on, no TCP progress); one that answers stays', async (t) => {
  const feed: PublicFeed = {
    welcome: () => ({ build: 'test', proto: PROTO, worldId: 'w', rulesVersion: 1, schema: 1, dt: 0.05, clockRate: 1, serverTick: 0, epoch: 'e', paused: false }) as never,
    join: () => ({ seq: 0, snapshot: { t: 'snapshot', reason: 'join', seq: 0, tick: 0, entities: [] } as never, log: JSON.stringify({ t: 'log', events: [] }), rest: [] }),
    available: () => true, load: () => 'green',
  };
  const fanout = new AnonFanout(feed);
  const server = createServer(); server.on('upgrade', (req, socket, head) => fanout.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port, socks: WebSocket[] = [];
  t.after(() => { for (const w of socks) w.terminate(); fanout.stopTimers(); server.close(); });
  const viewer = async () => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?hello=${encodeURIComponent(JSON.stringify({ t: 'hello', proto: PROTO }))}`); socks.push(ws); await once(ws, 'open'); return ws; };
  const live = await viewer(), dead = await viewer();
  await until(() => fanout.size === 2 && fanout.hasReady(), 'joined');
  await new Promise((r) => setTimeout(r, 50));
  (dead as unknown as { _socket: { pause(): void } })._socket.pause();   // it never reads its ping, so never answers
  const sweep = async () => { (fanout as unknown as { sweep(): void }).sweep(); await turn(); await new Promise((r) => setTimeout(r, 100)); };
  await sweep();                                                         // pings both
  await sweep();                                                         // judges: the live one answered, the dead one did not
  assert.equal(fanout.size, 1, 'the dead socket was ended by the sweep');
  assert.equal(live.readyState, 1, 'the one that answers stays');
});

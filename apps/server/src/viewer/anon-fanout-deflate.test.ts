// #2521 (Scaling V3): the fanout compresses each string once and writes the same frame to every socket that negotiated
// permessage-deflate. A2: one broadcast to 100 sockets calls the compressor once per distinct string, and every socket
// decodes the exact string (compressed or plain). A4: the `ws` internals this relies on are pinned with the version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as wsLib from 'ws';
import { WebSocket } from 'ws';
import { PROTO, type ServerMsg } from '@souls/protocol';
import { AnonFanout, deflateMessage, type PublicFeed } from './anon-fanout.ts';

const PINNED = '8.22.0';
const require = createRequire(import.meta.url);

/** A minimal public feed: a clock that runs and a small join set. */
const feed: PublicFeed = {
  welcome: () => ({ build: 'test', proto: PROTO, worldId: 'w', rulesVersion: 1, schema: 1, dt: 0.05, clockRate: 1, serverTick: 0, epoch: 'e', paused: false }) as never,
  join: () => ({ seq: 0, snapshot: { t: 'snapshot', reason: 'join', seq: 0, tick: 0, entities: [] } as never, log: JSON.stringify({ t: 'log', events: [] }), rest: [] }),
  available: () => true, load: () => 'green',
};

async function fanoutServer(t: import('node:test').TestContext) {
  let calls = 0;
  const fanout = new AnonFanout(feed, { deflate: (s) => { calls++; return deflateMessage(s); } });
  const server = createServer(); server.on('upgrade', (req, socket, head) => fanout.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port, socks: WebSocket[] = [];
  t.after(() => { for (const w of socks) w.terminate(); fanout.stopTimers(); server.close(); });
  /** A viewer with the page's URL hello; `deflate`: it offers permessage-deflate. */
  const viewer = async (deflate: boolean, hello: object = { t: 'hello', proto: PROTO }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?hello=${encodeURIComponent(JSON.stringify(hello))}`, { perMessageDeflate: deflate });
    socks.push(ws); const got: string[] = []; ws.on('message', (d) => got.push(String(d)));
    await once(ws, 'open'); return { ws, got };
  };
  return { fanout, viewer, calls: () => calls };
}
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(ok(), what); };

test('A2: with 100 sockets, one broadcast calls the compressor once per distinct string; every socket decodes it exactly', async (t) => {
  const f = await fanoutServer(t);
  // 80 offer permessage-deflate (as browsers do), 20 do not
  const vs = await Promise.all(Array.from({ length: 100 }, (_, i) => f.viewer(i % 5 !== 0)));
  await until(() => f.fanout.hasReady() && vs.every((v) => v.got.length >= 3), 'every viewer has its join set');
  assert.equal(vs.filter((v) => v.ws.extensions.includes('permessage-deflate')).length, 80, '80 negotiated deflate');
  for (const v of vs) v.got.length = 0;
  const big = JSON.stringify({ t: 'talk', lines: Array.from({ length: 40 }, (_, i) => ({ id: i, text: `a line long enough to compress, number ${i} — ü` })) });
  const small = JSON.stringify({ t: 'ticker', lines: ['short'] });
  assert.ok(Buffer.byteLength(big) >= 1024 && Buffer.byteLength(small) < 1024);
  const before = f.calls();
  f.fanout.pub('talk', big);
  assert.equal(f.calls() - before, 1, 'one broadcast of one string to 100 sockets: one compression');
  f.fanout.pub('ticker', small);
  assert.equal(f.calls() - before, 1, 'a string under 1 KB is not compressed');
  // a batch: compressed once for the broadcast; a resume replays the ring's frame without compressing again
  const batch = JSON.stringify({ t: 'batch', seq: 1, tick: 1, ops: Array.from({ length: 60 }, (_, i) => ({ op: 'move', id: `e${i}`, x: i, y: i * 2 })) } as unknown as ServerMsg);
  f.fanout.pub('batch', batch);
  assert.equal(f.calls() - before, 2, 'the batch: one compression');
  await until(() => vs.every((v) => v.got.length === 3), 'every viewer got the three messages');
  for (const v of vs) assert.deepEqual(v.got, [big, small, batch], 'decoded byte for byte, in order');
  // on the wire: the deflate sockets read fewer bytes than the messages hold
  const read = (v: { ws: WebSocket }) => (v.ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
  const plain = read(vs[0]), deflated = read(vs[1]);
  assert.ok(deflated < plain - 1000, `compressed frames on the wire (${deflated} < ${plain} bytes read)`);
  const r = await f.viewer(true, { t: 'hello', proto: PROTO, since: 0, epoch: 'e' });
  await until(() => r.got.includes(batch), 'the resumed viewer got the batch');
  assert.equal(f.calls() - before, 2, 'a resume replays the ring batch\'s frame');
});

test('A4: the ws version is pinned and the internals the shared frame relies on are where they were', async (t) => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies.ws, PINNED, 'apps/server/package.json pins ws exactly');
  const installed = JSON.parse(readFileSync(join(dirname(require.resolve('ws')), 'package.json'), 'utf8')) as { version: string };
  assert.equal(installed.version, PINNED, 'the installed ws is the pinned one');
  const Sender = (wsLib as unknown as { Sender: { frame: unknown } }).Sender;
  assert.equal(typeof Sender?.frame, 'function', 'the static Sender.frame');
  const [head, data] = (Sender.frame as (d: Buffer, o: object) => Buffer[])(Buffer.from('x'), { fin: true, rsv1: true, opcode: 1, mask: false, readOnly: false });
  assert.deepEqual([head[0], head[1], data.toString()], [0xc1, 1, 'x'], 'FIN + RSV1 + text, unmasked length 1');
  // a server-side socket: its sender, its idle state and its negotiated extension params
  const f = await fanoutServer(t);
  await f.viewer(true);
  await until(() => f.fanout.hasReady(), 'joined');
  const ws = [...f.fanout.wss.clients][0] as unknown as { _sender: { _state: number; sendFrame: unknown; _queue: unknown[] }; _extensions: Record<string, { params: Record<string, unknown> }> };
  assert.equal(typeof ws._sender.sendFrame, 'function', 'a socket\'s _sender.sendFrame');
  assert.deepEqual([ws._sender._state, ws._sender._queue.length], [0, 0], 'an idle sender is in state 0 with an empty queue');
  assert.equal(ws._extensions['permessage-deflate'].params.server_no_context_takeover, true, 'no context takeover negotiated');
});

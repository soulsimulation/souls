// #2512: the raw viewer's frame counter and upgrade, against frames as a server writes them, in any chunking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameCounter, parseUpgrade, upgradeRequest, pongFrame, closeFrame, serverFrame } from './frames.mjs';

const stream = Buffer.concat([
  serverFrame(1, Buffer.from('{"t":"welcome"}')),
  serverFrame(2, Buffer.alloc(300), { rsv1: true }),               // 16-bit length, compressed
  serverFrame(9, Buffer.from('hb')),                               // a ping
  serverFrame(2, Buffer.alloc(70_000)),                            // 64-bit length
  serverFrame(1, Buffer.from('par'), { fin: false }), serverFrame(0, Buffer.from('t two')),   // one message in two frames
  serverFrame(8, Buffer.from([0x03, 0xf5, 0x78])),                 // close 1013
]);
const count = (chunks) => {
  const seen = { pings: [], closes: [], data: 0 }, c = new FrameCounter({ onPing: (p) => seen.pings.push(p.toString()), onClose: (code) => seen.closes.push(code), onData: () => seen.data++ });
  for (const b of chunks) c.feed(b);
  return { frames: c.frames, messages: c.messages, payloadBytes: c.payloadBytes, ...seen };
};
const want = { frames: 7, messages: 4, payloadBytes: 15 + 300 + 70_000 + 3 + 5, pings: ['hb'], closes: [1013], data: 5 };

test('frames, messages and payload bytes are counted from headers alone; pings and the close code are read', () => {
  assert.deepEqual(count([stream]), want);
});
test('any chunking counts the same, down to one byte at a time', () => {
  assert.deepEqual(count(Array.from(stream, (b) => Buffer.from([b]))), want);
  for (const cut of [1, 2, 3, 4, 7, 10, 17, 323, 70_010]) assert.deepEqual(count([stream.subarray(0, cut), stream.subarray(cut)]), want, `cut at ${cut}`);
});
test('the upgrade answer is read once its head is complete; the first frames after it are kept', () => {
  const head = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nX-Sim-Served-By: viewer-thread\r\n\r\n', frame = serverFrame(1, Buffer.from('x'));
  assert.equal(parseUpgrade(Buffer.from(head.slice(0, 20))), null);
  const u = parseUpgrade(Buffer.concat([Buffer.from(head), frame]));
  assert.equal(u.status, 101); assert.equal(u.headers['x-sim-served-by'], 'viewer-thread'); assert.deepEqual(u.rest, frame);
  assert.equal(parseUpgrade(Buffer.from('HTTP/1.1 503 Service Unavailable\r\n\r\n')).status, 503);
});
test('the upgrade offers compression and carries the viewer\'s own address; client frames are masked', () => {
  const r = upgradeRequest({ host: 'h:1', path: '/w/x/ws?hello=%7B%7D', address: '198.18.0.1', key: 'k' });
  assert.match(r, /^GET \/w\/x\/ws\?hello=%7B%7D HTTP\/1\.1\r\n/); assert.match(r, /\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n/);
  assert.match(r, /\r\nX-Forwarded-For: 198\.18\.0\.1\r\n\r\n$/);
  assert.doesNotMatch(upgradeRequest({ host: 'h', path: '/', address: 'a', deflate: false }), /permessage-deflate/);
  assert.deepEqual([...pongFrame(Buffer.from('hb'))], [0x8a, 0x82, 0, 0, 0, 0, 0x68, 0x62]);
  assert.deepEqual([...closeFrame(1000)], [0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8]);
});

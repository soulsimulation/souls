#!/usr/bin/env node
// #2512 A4: a stub in place of the world, for the viewers bench's dry run (viewers.mjs --stub): no world, no launcher. It
// accepts every WebSocket upgrade (with compression when offered), discards what the viewers send, and sends each socket
// --kb kilobytes a second of filler as --hz binary messages a second (marked compressed when it was negotiated, as the
// world's are; the drivers never inflate), pings every 15 s as the hub does, and answers any HTTP GET with `{}` and
// /w/<slug>/healthz with {ok, clients}. A socket with over 1 MB unsent is skipped, as the hub skips one. So the drivers
// carry the frame and byte rate of a real stream with nothing else on their cores.
//
//   node tools/bench/capacity/viewers/stub.mjs --port <p> [--kb 50] [--hz 10]
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { serverFrame } from './frames.mjs';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const PORT = Number(opt('port', 4800)), KB = Number(opt('kb', 50)), HZ = Number(opt('hz', 10)), GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set(), body = randomBytes(Math.max(1, Math.round((KB * 1000) / HZ)));
const plain = serverFrame(2, body), deflated = serverFrame(2, body, { rsv1: true }), ping = serverFrame(9, Buffer.alloc(0));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(req.url.endsWith('/healthz') ? JSON.stringify({ ok: true, stub: true, clients: clients.size }) : '{}');
});
server.on('upgrade', (req, sock) => {
  const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64'), deflate = /permessage-deflate/.test(String(req.headers['sec-websocket-extensions'] ?? ''));
  sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`,
    ...(deflate ? ['Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover'] : []), '', ''].join('\r\n'));
  const c = { sock, frame: deflate ? deflated : plain };
  clients.add(c); sock.setNoDelay(true);
  sock.on('data', () => {});   // pongs and closes: discarded
  sock.on('error', () => {}); sock.on('close', () => clients.delete(c));
});
setInterval(() => { for (const c of clients) if (c.sock.writableLength < 1_000_000) c.sock.write(c.frame); }, 1000 / HZ);
setInterval(() => { for (const c of clients) c.sock.write(ping); }, 15_000);
server.listen(PORT, '127.0.0.1', () => console.log(`stub on ${PORT}: ${KB} kB/s per socket in ${HZ} messages/s`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

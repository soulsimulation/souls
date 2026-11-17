// #2512: a viewer's WebSocket on a raw socket, without a WebSocket library: the upgrade request (compression offered, its
// own X-Forwarded-For), the server's answer, and a counter that reads frame headers only. Payloads are skipped, never
// inflated or parsed, so a driver process can hold thousands of viewers on one core. Pings are answered (the hub cuts a
// socket that misses its sweep's ping), a close frame is answered and ends the socket.
import { randomBytes } from 'node:crypto';

/** The upgrade request for `path` with `address` as the viewer's forwarded address; `deflate` offers permessage-deflate as
 *  a browser does (the server then compresses its messages, and their compressed size is what the counter counts). */
export function upgradeRequest({ host, path, address, deflate = true, key = randomBytes(16).toString('base64') }) {
  return [`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
    ...(deflate ? ['Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits'] : []), `X-Forwarded-For: ${address}`, '', ''].join('\r\n');
}

/** The server's answer to the upgrade, from the bytes read so far: null until its head is complete, else its status, its
 *  headers (lower-case names) and the bytes after the head (the first frames). */
export function parseUpgrade(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n'), status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0])?.[1] ?? 0), headers = {};
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  return { status, headers, rest: buf.subarray(end + 4) };
}

/** A client frame (masked, as RFC 6455 requires of a client; the all-zero mask leaves the payload as it is). */
const clientFrame = (opcode, payload) => Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length, 0, 0, 0, 0]), payload]);
export const pongFrame = (payload) => clientFrame(0xa, payload.subarray(0, 125));
export const closeFrame = (code) => clientFrame(0x8, code == null ? Buffer.alloc(0) : Buffer.from([code >> 8, code & 255]));

/** Counts a server's frames from its byte stream, fed in any chunking: data frames (text, binary, continuation) add their
 *  payload length to `payloadBytes` and a finished message to `messages`; control frames call `onPing(payload)` and
 *  `onClose(code | null)`. `onData(len, fin)` is called at the start of each data frame. Only control payloads (at most
 *  125 bytes) are ever kept. */
export class FrameCounter {
  constructor({ onPing = () => {}, onClose = () => {}, onData = () => {} } = {}) {
    Object.assign(this, { onPing, onClose, onData, frames: 0, messages: 0, payloadBytes: 0 });
    this.h = Buffer.alloc(14); this.hn = 0; this.left = 0; this.op = 0; this.ctl = null;
  }
  feed(b) {
    let i = 0;
    while (i < b.length) {
      if (this.left > 0) {
        const n = Math.min(this.left, b.length - i);
        if (this.ctl) this.ctl.push(b.subarray(i, i + n));
        i += n; this.left -= n;
        if (this.left === 0) this.end();
        continue;
      }
      this.h[this.hn++] = b[i++];
      if (this.hn < 2) continue;
      const len7 = this.h[1] & 127, need = 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (this.h[1] & 128 ? 4 : 0);
      if (this.hn < need) continue;
      const len = len7 === 126 ? this.h.readUInt16BE(2) : len7 === 127 ? Number(this.h.readBigUInt64BE(2)) : len7;
      this.op = this.h[0] & 15; this.fin = (this.h[0] & 128) !== 0; this.hn = 0; this.left = len;
      this.ctl = this.op >= 8 ? [] : null;
      if (this.op < 8) { this.payloadBytes += len; this.onData(len, this.fin); }
      if (len === 0) this.end();
    }
  }
  end() {
    this.frames++;
    if (this.op < 8) { if (this.fin) this.messages++; return; }
    const p = Buffer.concat(this.ctl ?? []); this.ctl = null;
    if (this.op === 9) this.onPing(p);
    else if (this.op === 8) this.onClose(p.length >= 2 ? p.readUInt16BE(0) : null);
  }
}

/** A server frame (unmasked) for tests and the stub: `rsv1` marks a compressed message as permessage-deflate does. */
export function serverFrame(opcode, payload, { fin = true, rsv1 = false } = {}) {
  const n = payload.length, head = n < 126 ? Buffer.from([0, n]) : n < 65536 ? Buffer.from([0, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0, 127]), Buffer.alloc(8)]);
  if (n >= 65536) head.writeBigUInt64BE(BigInt(n), 2);
  head[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  return Buffer.concat([head, payload]);
}

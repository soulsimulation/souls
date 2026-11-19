// V13 (#2745): the owner's socket source and its clock. A3: when the socket drops, the page falls back to the files
// by slowing its clock and never jumps back. A4 (the page's half): the socket source keeps nothing it is sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decode, encode } from 'cborg';
import { FILES_US, NEAR_US, NearClock, SLOW_RATE } from './near.ts';
import { ENTRY, GRANT, ITEM, SUBSCRIBE, SocketSource, chooseFollow, exchange, frames, idValue, key, readItem } from './socket.ts';

const M = (pairs: [number, unknown][]) => new Map<number, unknown>(pairs);
const id = (b: number, n: number) => [new Uint8Array(16).fill(b), n];

test('an entry item gives its motion samples, its time and its audience; a grant item its levels', () => {
  const body = id(7, 10), hall = id(7, 1), soul = id(1, 1);
  const handoff = M([[1, body], [2, 1_250_000], [3, M([[1, 2]])], [4, M([[1, 2]])],
    [5, M([[1, [hall]], [2, [1_000_000, 0, -2_000]], [3, [1 << 30, 0, 0, 0]], [4, M([[1, 1]])]])], [6, [0, 0, 0]], [7, [0, 0, 0]]]);
  const entry = M([[1, 4], [2, 1_250_000], [3, M([[1, 1]])], [4, M([[1, 1]])], [5, M([[1, 2], [2, soul]])], [6, body], [7, [M([[1, 7], [2, handoff]])]]]);
  const item = readItem(encode(M([[1, ENTRY], [2, entry]])));
  assert.deepEqual(item, { t: 'entry', e: { at: 1_250_000, audience: key(soul as never), samples: [[key(body as never), key(hall as never), null, 1_250_000, 1_000_000, 0, -2_000]] } });
  const grant = readItem(encode(M([[1, GRANT], [2, M([[1, 3], [2, 1], [3, 'souls:over-budget']])]])));
  assert.deepEqual(grant, { t: 'grant', g: { level: 'outline', asked: 'full', reason: 'souls:over-budget' } });
});

test('the subscribe frame follows a body by its id, as gatewayd reads it', () => {
  const k = '07070707070707070707070707070707.10';
  assert.deepEqual(key(idValue(k)), k);
  const f = decode(frames.subscribe(k, 1, 16_000), { useMaps: true }) as Map<number, Map<number, unknown>>;
  const r = f.get(SUBSCRIBE)!;
  assert.deepEqual([(r.get(1) as Map<number, unknown>[])[0].get(2), r.get(2), r.get(3)], [idValue(k), 1, 16_000]);
  assert.equal(ITEM, 31);
});

test('A3: live at 150 ms behind; on a drop it slows to the files, two seconds behind, and never goes back', () => {
  const c = new NearClock();
  const dt = 1000 / 60;
  let wall = 0, t = 0, prev = -Infinity;
  const world = () => 10_000_000 + wall * 1000; // world time now, µs
  const step = (live: boolean) => {
    wall += dt;
    // The files' newest part ends 1.5 s behind the world; the socket's newest entry is 20 ms old.
    t = c.step(dt, live ? world() - 20_000 : null, world(), world() - 1_500_000)!;
    assert.ok(t >= prev, `never back: ${t} after ${prev}`);
    prev = t;
  };
  for (let i = 0; i < 300; i++) step(true);
  assert.equal(c.state, 'live');
  assert.ok(Math.abs(world() - t - (NEAR_US + 20_000)) < 20_000, `live: ${(world() - t) / 1000} ms behind`);
  // The socket drops.
  let slowed = false;
  for (let i = 0; i < 600; i++) {
    step(false);
    if (c.rate < 1 && c.rate >= SLOW_RATE - 1e-9) slowed = true;
    assert.ok(c.rate >= SLOW_RATE - 1e-9 || (c.state as string) === 'holding: no parts', `rate ${c.rate} in ${c.state}`);
  }
  assert.ok(slowed, 'it slowed');
  assert.equal(c.state, 'files');
  assert.ok(Math.abs(world() - t - FILES_US) < 40_000, `on the files: ${(world() - t) / 1000} ms behind`);
  // The socket is back: it catches up, never jumping.
  for (let i = 0; i < 60 * 30; i++) step(true);
  assert.equal(c.state, 'live');
});

test('A4: the socket source keeps nothing it is sent: no storage, no cache, no file, no fetch', () => {
  const src = readFileSync(new URL('./socket.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  // The one request is V13b's exchange, through the `post` it is given (`globalThis.fetch` by default).
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'fetch(', 'writeFile', 'console.'])
    assert.ok(!src.includes(api), `socket.ts uses ${api}`);
});

// V13b (#3407): the page signs in from its web session.

/** A gateway's socket as a test drives it: what the page sent, and the gateway's frames pushed to the page. */
class FakeSocket {
  static made: FakeSocket[] = [];
  sent: Uint8Array[] = [];
  readyState = 1;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; FakeSocket.made.push(this); }
  send(b: Uint8Array) { this.sent.push(b); }
  close() { this.readyState = 3; this.onclose?.(); }
  push(v: unknown) { const b = encode(v); this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }); }
  /** T10's first frame, the sign-in's outcome. */
  signIn() { this.onopen?.(); this.push(M([[1, 1]])); this.push(M([[4, 'view.started']])); }
}

const entryAt = (at: number) => {
  const body = id(7, 10), hall = id(7, 1);
  const handoff = M([[1, body], [2, at], [3, M([[1, 2]])], [4, M([[1, 2]])],
    [5, M([[1, [hall]], [2, [0, 0, 0]], [3, [1 << 30, 0, 0, 0]], [4, M([[1, 1]])]])], [6, [0, 0, 0]], [7, [0, 0, 0]]]);
  const e = M([[1, 4], [2, at], [3, M([[1, 1]])], [4, M([[1, 1]])], [5, M([[1, 1]])], [6, body], [7, [M([[1, 7], [2, handoff]])]]]);
  return M([[ITEM, encode(M([[1, ENTRY], [2, e]]))]]);
};
const signInFrames = (ws: FakeSocket) =>
  ws.sent.map((b) => decode(b, { useMaps: true }) as Map<number, unknown>).filter((m) => typeof m.get(1) === 'string').map((m) => m.get(1));
const TOKEN = 'view.1900000000.soul-01010101010101010101010101010101-1.' + 'ab'.repeat(32);
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('V13b A1: the session exchanges for a view token that reaches no address, log or storage', async () => {
  const urls: string[] = [], inits: RequestInit[] = [], logged: unknown[] = [], stored: unknown[] = [];
  const post = (async (url: string, init: RequestInit) => (urls.push(url), inits.push(init), answer({
    token: TOKEN, expires: 1_900_000_000, owned: [{ grant: 'soul-01010101010101010101010101010101-1', follow: '0707.10' }, { grant: 'creator-02-1', follow: null }],
  }))) as unknown as typeof fetch;
  const saved = { ...console };
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) console[k] = (...a: unknown[]) => void logged.push(a);
  const storage = { setItem: (...a: unknown[]) => void stored.push(a), getItem: () => null };
  Object.assign(globalThis, { localStorage: storage, sessionStorage: storage });
  try {
    const g = await exchange('http://127.0.0.1:7100/', { testName: 'Ada' }, post);
    assert.equal(urls[0], 'http://127.0.0.1:7100/v1/account/view-token');
    assert.deepEqual([inits[0].cache, inits[0].credentials, inits[0].referrerPolicy], ['no-store', 'omit', 'no-referrer']);
    assert.equal(chooseFollow(g.owned, '0707.99'), '0707.10', 'the follow target is the account\'s own Soul');
    FakeSocket.made = [];
    const src = new SocketSource({ url: 'ws://127.0.0.1:7200/v2/ws', token: g.token, expires: g.expires, follow: chooseFollow(g.owned, null)!, WebSocket: FakeSocket as never });
    src.start({ pointer: () => {}, part: () => {}, error: (m) => console.error(m) });
    const ws = FakeSocket.made[0];
    ws.signIn();
    ws.push(entryAt(1_000_000));
    src.stop();
    assert.deepEqual(signInFrames(ws), [TOKEN], 'the token goes to the gateway in the sign-in frame alone');
    const everywhere = JSON.stringify([urls, ws.url, logged, stored, String(src), Object.keys(src)]);
    assert.ok(!everywhere.includes(TOKEN.slice(-64)), 'never in an address, a log or storage');
    assert.equal(stored.length, 0);
    // A refused session: an error naming the refusal, never a token.
    const refused = (async () => answer({ refused: 'session-revoked' }, 401)) as unknown as typeof fetch;
    await assert.rejects(exchange('http://127.0.0.1:7100', { bearer: async () => 'jwt' }, refused), /session-revoked/);
  } finally {
    Object.assign(console, saved);
    delete (globalThis as any).localStorage, delete (globalThis as any).sessionStorage;
  }
});

test('V13b A3: a token near expiry is renewed on the open socket, with no new socket and no gap; a lapsed one is renewed before reconnecting', async () => {
  FakeSocket.made = [];
  let wall = 1_900_000_000_000, n = 0;
  const renew = async () => ({ token: `${TOKEN}-${++n}`, expires: Math.floor(wall / 1000) + 120 });
  // Expires 31 s from now: renewed 30 s before, so in a second.
  const src = new SocketSource({ url: 'ws://gw', token: TOKEN, expires: wall / 1000 + 31, follow: '0707.10', renew, now: () => wall, WebSocket: FakeSocket as never });
  const parts: number[] = [];
  src.start({ pointer: () => {}, part: (p) => void parts.push(p.from), error: (m) => assert.fail(m) });
  const ws = FakeSocket.made[0];
  ws.signIn();
  ws.push(entryAt(1_000_000));
  await new Promise((r) => setTimeout(r, 1200));
  ws.push(M([[4, 'view.renewed']]));
  ws.push(entryAt(1_050_000));
  assert.equal(src.renewals, 1);
  assert.deepEqual(signInFrames(ws), [TOKEN, `${TOKEN}-1`], 'the fresh token is sent on the same socket');
  assert.equal(FakeSocket.made.length, 1, 'no second socket: the subscription carries on');
  assert.ok(src.up, 'up throughout');
  assert.deepEqual(parts, [1_000_000, 1_050_000], 'entries before and after the renewal, none lost');
  // The socket drops and the token has lapsed meanwhile: a fresh one is got before the socket opens again.
  src.stop();
  wall += 200_000;
  const again = new SocketSource({ url: 'ws://gw', token: TOKEN, expires: wall / 1000 - 1, follow: '0707.10', renew, now: () => wall, WebSocket: FakeSocket as never });
  again.start({ pointer: () => {}, part: () => {}, error: (m) => assert.fail(m) });
  await new Promise((r) => setTimeout(r, 10));
  const ws2 = FakeSocket.made[1];
  ws2.signIn();
  again.stop();
  assert.deepEqual(signInFrames(ws2), [`${TOKEN}-2`]);
});

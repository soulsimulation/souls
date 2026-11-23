// A recorded stretch of Eden for `history` (Engine v2 R16, #2817): the public event index and coarse counts V4 writes
// (`v2/docs/archive.md` rules 9 and 10, T0's deterministic CBOR), for `days` world days of `souls` acting Souls, and
// the script it was written from, so an answer can be checked against what happened.
//
// The places and things are Eden 2026's busiest room as today's catalog has it (`../brief/eden-busiest-room.json`:
// the Reading Room of the Eden Library and its 36 things), and 20 more rooms of 10 things each. Each Soul acts
// `perMinute` times a world minute, at a seeded moment: it ends an act on a thing, arrives at a room, or says
// something (a public `souls:said` row: V4's index has no fields, so the words are in no file), in a room it picks
// by a seeded walk that stays in one room for a while. Every hour then has 1,000 rows or more and an object of its own.
//
//   node v2/client/src/history/day.mjs bench [--souls 100] [--per-minute 1] [--days 4]
//
// serves the files over HTTP on 127.0.0.1 and times the three questions, five times each.

import { isMain } from '../../../../tools/lib/is-main.mjs';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { DAY, HOUR, TEN_MINUTES, YEAR_DAYS, history, keys } from './history.mjs';

/** T0's deterministic CBOR for what V4's objects hold: integers, bytes, text, arrays, maps with integer keys. */
export function encode(v) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 0x100) out.push((major << 5) | 24, n);
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 255);
    else if (n < 2 ** 32) out.push((major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
    else { const hi = Math.floor(n / 2 ** 32), lo = n >>> 0; out.push((major << 5) | 27, hi >>> 24, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, lo >>> 24, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255); }
  };
  const item = (x) => {
    if (typeof x === 'number') { if (x >= 0) head(0, x); else head(1, -1 - x); }
    else if (x instanceof Uint8Array) { head(2, x.length); out.push(...x); }
    else if (typeof x === 'string') { const b = Buffer.from(x, 'utf8'); head(3, b.length); out.push(...b); }
    else if (Array.isArray(x)) { head(4, x.length); x.forEach(item); }
    else if (x instanceof Map) { const ks = [...x.keys()].sort((a, b) => a - b); head(5, ks.length); for (const k of ks) { item(k); item(x.get(k)); } }
    else throw new Error(`encode: ${typeof x}`);
  };
  item(v);
  return Uint8Array.from(out);
}

const SOUL_SCOPE = '5a'.repeat(16), PLACE_SCOPE = 'e0'.repeat(16);
const scopeBytes = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
export const soulId = (n) => `${SOUL_SCOPE}-${n}`;
const nodeId = (n) => `${PLACE_SCOPE}-${n}`;
const idValue = (id) => { const [s, c] = id.split('-'); return [scopeBytes(s), Number(c)]; };

/** The copy's rows (as `rowsOf` gives them): the Eden room and its things, 20 more rooms, and the Souls' bodies. */
export function edenRows(souls) {
  const eden = JSON.parse(readFileSync(new URL('../brief/eden-busiest-room.json', import.meta.url), 'utf8')).room.rows;
  const rows = new Map(), byOld = new Map();
  let n = 0;
  for (const r of eden) byOld.set(r.id, nodeId(++n));
  for (const r of eden) rows.set(byOld.get(r.id), { id: byOld.get(r.id), name: r.name, kind: r.kind, parent: r.parent ? byOld.get(r.parent) ?? null : null });
  const room = byOld.get(JSON.parse(readFileSync(new URL('../brief/eden-busiest-room.json', import.meta.url), 'utf8')).room.room);
  const rooms = [room];
  for (let k = 1; k <= 20; k++) {
    const id = nodeId(++n);
    rows.set(id, { id, name: `Room ${k}`, kind: 'room', parent: byOld.get('world') ?? null });
    rooms.push(id);
    for (let t = 1; t <= 10; t++) { const tid = nodeId(++n); rows.set(tid, { id: tid, name: `thing ${k}.${t}`, kind: 'thing', parent: id }); }
  }
  for (let s = 1; s <= souls; s++) rows.set(soulId(s), { id: soulId(s), name: `body ${s}`, kind: 'body', parent: room });
  return { rows, rooms, room, things: (r) => [...rows.values()].filter((x) => x.parent === r && x.kind !== 'body').map((x) => x.id) };
}

/** A seeded generator (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

const KINDS = ['souls:act-ended', 'souls:arrived', 'souls:said'];

/** The script: every act, `{ at, kind, node, actor }`, in time order. */
export function script({ souls = 100, perMinute = 1, days = 4, seed = 1 } = {}) {
  const world = edenRows(souls), rnd = seeded(seed), acts = [];
  const where = Array.from({ length: souls }, (_, i) => world.rooms[i % world.rooms.length]);
  const things = new Map(world.rooms.map((r) => [r, world.things(r)]));
  for (let minute = 0; minute < days * 1440; minute++) {
    for (let s = 1; s <= souls; s++) {
      for (let k = 0; k < perMinute; k++) {
        const at = minute * 60_000_000 + Math.floor(rnd() * 60_000_000);
        const roll = rnd();
        if (roll < 0.05) { where[s - 1] = world.rooms[Math.floor(rnd() * world.rooms.length)]; acts.push({ at, kind: KINDS[1], node: where[s - 1], actor: soulId(s) }); }
        else if (roll < 0.25) acts.push({ at, kind: KINDS[2], node: where[s - 1], actor: soulId(s) });
        else { const ts = things.get(where[s - 1]); acts.push({ at, kind: KINDS[0], node: ts[Math.floor(rnd() * ts.length)], actor: soulId(s) }); }
      }
    }
  }
  acts.sort((a, b) => a.at - b.at);
  return { ...world, acts };
}

/** V4's objects for the script, by key: each day's object, each hour of 1,000 rows or more, day and year counts. */
export function objects(acts) {
  const out = new Map(), byDay = new Map();
  for (const a of acts) { const d = Math.floor(a.at / DAY); (byDay.get(d) ?? byDay.set(d, []).get(d)).push(a); }
  const index = (rows, day, hour, split) => {
    const kinds = [];
    const num = (k) => { let i = kinds.indexOf(k); if (i < 0) { kinds.push(k); i = kinds.length - 1; } return i; };
    const rs = rows.map((a) => [a.at, num(a.kind), idValue(a.node), [1, idValue(a.actor)]]);
    const m = new Map([[1, 1], [2, day], [4, kinds], [5, rs]]);
    if (hour != null) m.set(3, hour);
    if (split?.length) m.set(6, split);
    return encode(m);
  };
  const counts = (span, n, rows, slotOf) => {
    const kinds = [], c = new Map();
    for (const a of rows) { if (!kinds.includes(a.kind)) kinds.push(a.kind); const key = `${slotOf(a.at)} ${kinds.indexOf(a.kind)}`; c.set(key, (c.get(key) ?? 0) + 1); }
    const rs = [...c].map(([k, v]) => [...k.split(' ').map(Number), v]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return encode(new Map([[1, 1], [2, span], [3, n], [4, kinds], [5, rs]]));
  };
  const years = new Map();
  for (const [day, rows] of byDay) {
    const byHour = new Map();
    for (const a of rows) { const h = Math.floor((a.at - day * DAY) / HOUR); (byHour.get(h) ?? byHour.set(h, []).get(h)).push(a); }
    const split = [...byHour].filter(([, r]) => r.length >= 1000).map(([h]) => h).sort((a, b) => a - b);
    for (const h of split) out.set(keys.events(day, h), index(byHour.get(h), day, h));
    out.set(keys.events(day), index(rows.filter((a) => !split.includes(Math.floor((a.at - day * DAY) / HOUR))), day, null, split));
    out.set(keys.dayCounts(day), counts(1, day, rows, (at) => Math.floor((at - day * DAY) / TEN_MINUTES)));
    const y = Math.floor(day / YEAR_DAYS);
    const ys = years.get(y) ?? years.set(y, []).get(y);
    for (const a of rows) ys.push(a);
  }
  for (const [y, rows] of years) out.set(keys.yearCounts(y), counts(2, y, rows, (at) => Math.floor(at / DAY) % YEAR_DAYS));
  return out;
}

/** Serves the objects by key on 127.0.0.1; `stop()` ends the server. */
export async function serve(files) {
  const server = createServer((req, res) => {
    const b = files.get(decodeURIComponent(req.url.slice(1)));
    if (!b) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/cbor' }).end(b);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}/`, stop: () => server.close() };
}

/** `get` over HTTP, as the daemon's: the bytes, or null for a file the history does not have. */
export const getter = (base) => async (key) => {
  const r = await fetch(new URL(key, base));
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};

if (isMain(import.meta.url) && process.argv[2] === 'bench') {
  const opt = (n, d) => { const k = process.argv.indexOf(n); return k > 0 ? Number(process.argv[k + 1]) : d; };
  const souls = opt('--souls', 100), perMinute = opt('--per-minute', 1), days = opt('--days', 4);
  const s = script({ souls, perMinute, days });
  const files = objects(s.acts);
  const day = Math.floor(s.acts.at(-1).at / DAY);
  let dayBytes = 0, dayDeflated = 0;
  for (const [k, b] of files) if (k.startsWith(keys.events(day))) { dayBytes += b.length; dayDeflated += deflateRawSync(b).length; }
  console.log(JSON.stringify({ souls, perMinute, days, acts: s.acts.length, lastDay: day, lastDayIndexBytes: dayBytes, lastDayIndexDeflated: dayDeflated }));
  const { base, stop } = await serve(files);
  const get = getter(base);
  const desk = s.things(s.room)[0];
  const asks = [['place', { by: 'place', id: s.room }], ['thing', { by: 'thing', id: desk }], ['soul', { by: 'soul', id: soulId(42) }]];
  for (const [what, ask] of asks) {
    const times = [];
    let a;
    for (let r = 0; r < 5; r++) { const t0 = performance.now(); a = await history(ask, { get, rows: s.rows, me: soulId(1) }); times.push(performance.now() - t0); }
    times.sort((x, y) => x - y);
    console.log(JSON.stringify({ question: what, msMedian: Math.round(times[2]), msMax: Math.round(times[4]), answerBytes: Buffer.byteLength(JSON.stringify(a)), answer: a }));
  }
  stop();
}

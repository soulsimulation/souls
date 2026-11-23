// Asking what happened (Engine v2 R16, #2817): `history --at <place> | --thing <id> | --soul <name>`, answered by the
// daemon from what any viewer can read, and from the asker's own memory.
//
// - **The public event index** (V4, `v2/docs/archive.md` rule 9) is fetched as files from the world's history:
//   `history/everyone/events/<day>` and the hours it names as split (`<day>/<hour>`). A row is `[at µs, kind number,
//   node, actor]` and nothing else, so no answer from it carries words. Only the hours in the span are fetched; the
//   rows are scanned here and named from the daemon's copy (`rowsOf`), and a node or Soul the copy does not hold is
//   named from memory, else by its id.
// - **The coarse counts** (rule 10) find where the record ends (the newest day of the year counts, the newest ten
//   minutes of that day's counts) and count, by day, what a span beyond the look-back left out.
// - **The asker's memory** (R14) comes first: its own lines about the Soul, place or thing asked, newest first, with
//   their words, which it heard or said itself.
// - **The look-back** is one world day, or from `since`; never more than seven. The answer states its span; a question
//   beyond it says so, with what it left out. At most LINES_MOST lines, newest first, the rest counted, and the whole
//   answer within ANSWER_MOST bytes: an hour of raw rows never reaches a model.

/** World time units, µs (T5; V4's split and coarse levels). */
export const HOUR = 3_600_000_000, DAY = 86_400_000_000, TEN_MINUTES = 600_000_000, YEAR_DAYS = 365;
/** The look-back: by default, and at most, in world days. */
export const LOOK_BACK = 1, LOOK_BACK_MOST = 7;
export const LINES_MOST = 5, MEMORY_MOST = 2, WORDS_MOST = 80, FETCHES_AT_ONCE = 6;
/** The answer's own bytes; the daemon adds `at` and `age` within the 600 the issue allows. */
export const ANSWER_MOST = 500;

const pad = (n, w) => String(n).padStart(w, '0');
export const keys = {
  events: (day, hour) => `history/everyone/events/${pad(day, 8)}${hour == null ? '' : `/${pad(hour, 2)}`}`,
  dayCounts: (day) => `history/everyone/counts/day/${pad(day, 8)}`,
  yearCounts: (year) => `history/everyone/counts/year/${pad(year, 4)}`,
};

/**
 * One CBOR item in T0's profile, read for speed over many small rows: integers as numbers (V4's are world µs and
 * counters, below 2^53), bytes as views into the buffer, text as strings. Anything else is refused.
 */
export function decodeFast(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const arg = (info) => {
    if (info < 24) return info;
    let v;
    if (info === 24) v = bytes[at];
    else if (info === 25) v = dv.getUint16(at);
    else if (info === 26) v = dv.getUint32(at);
    else if (info === 27) { v = dv.getUint32(at) * 2 ** 32 + dv.getUint32(at + 4); if (v > Number.MAX_SAFE_INTEGER) throw new Error('cbor: past 2^53'); }
    else throw new Error('cbor: not in the profile');
    at += 1 << (info - 24);
    return v;
  };
  const item = () => {
    const b = bytes[at++], major = b >> 5, info = b & 31;
    if (major === 7) { if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('cbor: not in the profile'); }
    const n = arg(info);
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const out = bytes.subarray(at, at + n); at += n; return out; }
      case 3: { const out = Buffer.from(bytes.buffer, bytes.byteOffset + at, n).toString('utf8'); at += n; return out; }
      case 4: { const out = new Array(n); for (let k = 0; k < n; k++) out[k] = item(); return out; }
      case 5: { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
      default: throw new Error('cbor: not in the profile');
    }
  };
  const v = item();
  if (at !== bytes.length) throw new Error('cbor: bytes after the item');
  return v;
}

const hex = (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
const idOf = (v) => `${hex(v[0])}-${v[1]}`;
const ID = /^([0-9a-f]{32})-(\d+)$/;
/** World time as `d<day> hh:mm`. */
export const when = (at) => {
  const day = Math.floor(at / DAY), s = Math.floor((at - day * DAY) / 1e6);
  return `d${day} ${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}`;
};
const plain = (kind) => String(kind).replace(/@.*$/, '').replace(/^souls:/, '');

/** A counts object's rows: `{ slot → total }`, every kind added. */
function totals(bytes) {
  const m = decodeFast(bytes), out = new Map();
  for (const [slot, , n] of m.get(5) ?? []) out.set(slot, (out.get(slot) ?? 0) + n);
  return out;
}

/**
 * Where the record ends, from the coarse counts: the end of the newest ten minutes with an event. Years are read from
 * the first one held until one is missing (two or three small requests): year 0 for a world whose time starts at 0,
 * else, for a world on the machine's clock (`worldd serve`), this year or the two before it (R16b). Also gives the
 * year counts read, by day.
 */
async function recordEnd(get, now) {
  const byDay = new Map();
  let newest = null, first = 0;
  if (!(await get(keys.yearCounts(0)))) {
    const year = Math.floor(Math.floor(now / DAY) / YEAR_DAYS);
    for (first = year; first > year - 3 && !(await get(keys.yearCounts(first)));) first--;
  }
  for (let y = first; ; y++) {
    const b = await get(keys.yearCounts(y));
    if (!b) break;
    for (const [slot, n] of totals(b)) { byDay.set(y * YEAR_DAYS + slot, n); newest = Math.max(newest ?? -Infinity, y * YEAR_DAYS + slot); }
  }
  if (newest === null) return { end: null, byDay };
  const day = await get(keys.dayCounts(newest));
  const slots = day ? [...totals(day).keys()] : [];
  const slot = slots.length ? Math.max(...slots) : 143;
  return { end: newest * DAY + (slot + 1) * TEN_MINUTES, byDay };
}

/** The tasks' results in order, at most FETCHES_AT_ONCE running at a time. */
async function few(tasks) {
  const out = new Array(tasks.length);
  let next = 0;
  const lane = async () => { while (next < tasks.length) { const k = next++; out[k] = await tasks[k](); } };
  await Promise.all(Array.from({ length: Math.min(FETCHES_AT_ONCE, tasks.length) }, lane));
  return out;
}

/**
 * The rows of the public index in [from, to] that `match(node, actor)` takes, newest last, with the bytes and requests
 * read. Day objects first (they name the split hours), then the split hours in the span, each set in parallel.
 */
export async function scan(get, from, to, match) {
  let bytes = 0, requests = 0;
  const fetched = async (k) => { requests++; const b = await get(k); if (b) bytes += b.length; return b; };
  const days = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor((to - 1) / DAY); d++) days.push(d);
  const objects = (await few(days.map((d) => () => fetched(keys.events(d))))).filter(Boolean).map(decodeFast);
  const hours = [];
  for (const m of objects) {
    const day = m.get(2);
    for (const h of m.get(6) ?? []) {
      const start = day * DAY + h * HOUR;
      if (start + HOUR > from && start <= to) hours.push(keys.events(day, h));
    }
  }
  objects.push(...(await few(hours.map((k) => () => fetched(k)))).filter(Boolean).map(decodeFast));
  const found = [];
  for (const m of objects) {
    const kinds = m.get(4);
    for (const [at, k, node, actor] of m.get(5)) {
      if (at < from || at > to) continue;
      if (match(node, actor)) found.push({ at, kind: kinds[k], node: idOf(node), actor: actor[0] === 3 ? null : idOf(actor[1]), by: actor[0] });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return { found, bytes, requests };
}

/** A matcher on raw rows for a set of node ids, and (for a Soul) its actor id: counters compared first, then scopes. */
function matcher(nodes, actorId) {
  const counters = new Set([...nodes].map((id) => Number(ID.exec(id)?.[2])));
  const actorCounter = actorId ? Number(ID.exec(actorId)?.[2]) : null;
  return (node, actor) => (counters.has(node[1]) && nodes.has(idOf(node)))
    || (actorCounter !== null && actor[0] === 1 && actor[1][1] === actorCounter && idOf(actor[1]) === actorId);
}

/** The node and every node the copy holds under it. */
function under(rows, id) {
  const kids = new Map();
  for (const r of rows.values()) if (r.parent) (kids.get(r.parent) ?? kids.set(r.parent, []).get(r.parent)).push(r.id);
  const out = new Set([id]);
  for (const todo = [id]; todo.length;) for (const k of kids.get(todo.pop()) ?? []) if (!out.has(k)) { out.add(k); todo.push(k); }
  return out;
}

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return [...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t; };

/**
 * The asker's own memory lines about the question, newest first (R14's log records, `{kind, value}`): about itself,
 * all of them; about another Soul, those naming it; about a place or a thing, those at it or naming it. Words only
 * from speech it heard or said, marked UNTRUSTED when someone else said them.
 */
export function memoryLines(records, { by, id, me, nameOf = (x) => x }) {
  const about = (v) => {
    if (by === 'soul' && id === me) return true;
    const ids = [v.personId, ...(v.personIds ?? []), v.person?.id, v.placeId, v.endedAt?.place, ...(v.produced ?? []).map((p) => p.id)];
    return ids.includes(id);
  };
  const line = (v) => {
    const t = v.at.slice(0, 16).replace('T', ' ');
    switch (v.type) {
      case 'speech': return `${t} heard ${nameOf(v.personId)}: "${clip(v.text, WORDS_MOST)}" (UNTRUSTED)`;
      case 'told': return `${t} I said: "${clip(v.text, WORDS_MOST)}"`;
      case 'meet': return `${t} met ${clip(v.person?.name, 40) || v.person?.id}`;
      case 'arrival': return `${t} arrived at ${nameOf(v.placeId)}`;
      case 'outcome': return `${t} ${clip(v.act, 30)} ${v.phase}`;
      default: return null;
    }
  };
  return records.map((r) => r.value).filter((v) => v && about(v)).map(line).filter(Boolean).reverse();
}

/**
 * The answer to one question. `ask` is `{ by: 'place'|'thing'|'soul', id, since?, until? }` (world µs); `get(key)` gives
 * a history file's bytes or null; `rows` is the copy's rows by id; `names` names Souls as the asker's memory knows them
 * (before the copy's names, and for a Soul that has left); `memory` is the asker's memory records; `me` its Soul id.
 */
export async function history(ask, { get, rows = new Map(), names = new Map(), memory = [], me = null, now = Date.now() * 1000 }) {
  const { by, id } = ask;
  const nameOf = (x) => (x === me ? 'me' : names.get(x) ?? rows.get(x)?.name ?? x);
  const { end, byDay } = await recordEnd(get, now);
  const to = ask.until ?? end;
  const mine = memoryLines(memory, { by, id, me, nameOf });
  const out = { ok: true, by, about: nameOf(id), memory: mine };
  if (to == null) return fit({ ...out, span: null, found: 0, lines: [] });
  let from = ask.since ?? to - LOOK_BACK * DAY, beyond = null;
  if (to - from > LOOK_BACK_MOST * DAY) {
    const asked = from;
    from = to - LOOK_BACK_MOST * DAY;
    let days = 0, events = 0;
    for (const [day, n] of byDay) if (day >= Math.floor(asked / DAY) && day < Math.floor(from / DAY)) { days++; events += n; }
    beyond = { asked: when(asked), mostDays: LOOK_BACK_MOST, leftOut: { days: Math.ceil((from - asked) / DAY), daysWithEvents: days, publicEvents: events } };
  }
  const nodes = by === 'place' ? under(rows, id) : new Set([id]);
  const { found } = await scan(get, from, to, matcher(nodes, by === 'soul' ? id : null));
  const kinds = {};
  for (const f of found) kinds[plain(f.kind)] = (kinds[plain(f.kind)] ?? 0) + 1;
  // A line names who, unless the question is that Soul, and where, unless it is the thing or place asked about.
  const lines = found.slice(-LINES_MOST).reverse().map((f) => [when(f.at), by === 'soul' && f.actor === id ? null
    : f.by === 3 ? 'the world' : nameOf(f.actor), plain(f.kind), f.node === id ? null : nameOf(f.node)].filter(Boolean).join(' '));
  return fit({ ...out, span: { from: when(from), to: when(to) }, ...(beyond ? { beyond } : {}), found: found.length, kinds, lines });
}

/** The answer within ANSWER_MOST bytes: memory lines and then index lines dropped, oldest first, and counted. */
function fit(a) {
  const memory = a.memory.slice(0, MEMORY_MOST);
  let lines = [...a.lines];
  const make = () => {
    const o = { ...a, lines, memory };
    if (!memory.length) delete o.memory;
    if (a.memory.length > memory.length) o.memoryMore = a.memory.length - memory.length;
    if (a.found > lines.length) o.more = a.found - lines.length;
    if (a.kinds && Object.keys(a.kinds).length > 4) o.kinds = Object.fromEntries(Object.entries(a.kinds).sort((x, y) => y[1] - x[1]).slice(0, 4));
    return o;
  };
  let o = make();
  while (Buffer.byteLength(JSON.stringify(o)) > ANSWER_MOST && (lines.length || memory.length)) {
    if (lines.length > 1 || !memory.length) lines = lines.slice(0, -1); else memory.pop();
    o = make();
  }
  return o;
}

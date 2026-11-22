// #4018 (X9): pure helpers for the v2 viewers bench (v2.mjs, v2-readers.mjs): a CBOR reader for the stream's records,
// what kind of file a stream path is, a latency histogram, and the bars each step is judged by.

/** A CBOR reader for T6's records: every major type (tags kept as `{tag, value}`, simple values as JS values). */
export function cbor(buf) {
  let i = 0;
  const arg = (info) => {
    if (info < 24) return info;
    const n = 1 << (info - 24);
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + buf[i++];
    return v;
  };
  const item = () => {
    const b = buf[i++], major = b >> 5, info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      const n = 1 << (info - 24), v = new DataView(buf.buffer, buf.byteOffset + i, n);
      i += n;
      return info === 25 ? v.getFloat16?.(0) ?? NaN : info === 26 ? v.getFloat32(0) : v.getFloat64(0);
    }
    const a = arg(info);
    switch (major) {
      case 0: return a;
      case 1: return -1 - a;
      case 2: return buf.subarray(i, (i += a));
      case 3: return Buffer.from(buf.subarray(i, (i += a))).toString('utf8');
      case 4: return Array.from({ length: a }, item);
      case 5: { const m = new Map(); for (let k = 0; k < a; k++) m.set(item(), item()); return m; }
      default: return { tag: a, value: item() };
    }
  };
  return item();
}

/** A node id value (`[scope bytes, counter]`) as the intents' target text, `<scope hex>-<counter>`; null if not one. */
export function idText(v) {
  const x = v && typeof v === 'object' && 'tag' in v ? v.value : v;
  if (!Array.isArray(x) || x.length !== 2 || !(x[0] instanceof Uint8Array) || !Number.isInteger(x[1])) return null;
  return `${Buffer.from(x[0]).toString('hex')}-${x[1]}`;
}

/**
 * Places a Soul can be sent to walk, from a played copy's snapshot (replica's `StreamPlayer.snapshot()`: node records
 * `{1: id, 2: kind, 3: parent, ...}`): the children of the node with the most children (the open ground), bodies left
 * out. Ids as `<scope hex>-<counter>`.
 */
export function walkTargets(snapshot) {
  const kids = new Map();
  for (const node of cbor(snapshot)) {
    const parent = idText(node.get(3)), me = idText(node.get(1));
    if (!parent || !me || /body/.test(String(node.get(2)))) continue;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(me);
  }
  return [...kids.values()].sort((a, b) => b.length - a.length)[0] ?? [];
}

/** What a stream file is, by its path: the bytes per viewer are counted by these. */
export function fileType(path) {
  if (/(^|\/)pointer$/.test(path)) return 'pointer';
  if (/(^|\/)headers\//.test(path)) return 'header';
  if (/(^|\/)baseline\.text$/.test(path)) return 'baseline.text';
  if (/(^|\/)baseline$/.test(path)) return 'baseline';
  if (/(^|\/)\d+\.text$/.test(path)) return 'part.text';
  if (/(^|\/)\d+$/.test(path)) return 'part';
  return 'other';
}

export const BUCKET_MS = 10;
/** Adds `ms` to a histogram of 10 ms buckets (an object, so it crosses IPC and merges by key). */
export const record = (hist, ms) => { const b = Math.max(0, Math.floor(ms / BUCKET_MS)); hist[b] = (hist[b] ?? 0) + 1; };
export function merge(into, hist) { for (const [k, v] of Object.entries(hist)) into[k] = (into[k] ?? 0) + v; return into; }
/** The q quantile of a histogram, as its bucket's top in ms; null when empty. */
export function hq(hist, q) {
  const keys = Object.keys(hist).map(Number).sort((a, b) => a - b), n = keys.reduce((s, k) => s + hist[k], 0);
  let seen = 0;
  for (const k of keys) if ((seen += hist[k]) >= Math.max(1, Math.ceil(q * n))) return (k + 1) * BUCKET_MS;
  return null;
}
export const hcount = (hist) => Object.values(hist).reduce((s, v) => s + v, 0);

/**
 * The bars a step is judged by, declared on #4018 before the first run. `row`: one step's figures. Each bar is
 * `{bar, met, value, limit}`; `met` is null when the step has nothing to judge it by.
 * - B1 first picture: p95 of the step's joiners (the join wave) at most 3 s: from the first ask to holding the newest
 *   part (the baseline, its words and every part after it), when the page can draw the live world; and none of them
 *   still without it at the window's end.
 * - B2 stream latency: p99 of a newest part's arrival after its end at most 2 s (the page draws four parts, 2 s, behind).
 * - B3 drops: no failed request, no viewer sent back to a new baseline, none left behind (more than 22 s, the page's
 *   cut), no origin restart.
 * - B4 origin memory: resident at most 256 MB (the production unit's MemoryMax), slow readers held included.
 * - B5 origin processor: at most 0.9 of a core (the origin is one Node thread).
 * - B6 the world's tick: mean within 10 % of the zero-viewer windows' (before and after the ladder; A3), or within
 *   0.5 ms of it (1 % of the 50 ms tick), below which the machine's other work moves it.
 */
export function bars(row, zeroTickMean) {
  const b = (bar, value, limit, ok) => ({ bar, value, limit, met: value == null ? null : ok(value) });
  return [
    // A joiner still without a picture at the window's end has no time yet: the bar is missed, not judged on the rest.
    row.waitingAtEnd ? { bar: 'B1 first picture p95 ms', value: row.firstPictureP95, limit: 3000, met: false, waiting: row.waitingAtEnd } : b('B1 first picture p95 ms', row.firstPictureP95, 3000, (v) => v <= 3000),
    b('B2 latency p99 ms', row.latencyP99, 2000, (v) => v <= 2000),
    b('B3 drops', row.viewers ? row.errors + row.reinstalls + row.behind + (row.originRestarts ?? 0) : null, 0, (v) => v === 0),
    b('B4 origin RSS MB', row.originRssMaxMb, 256, (v) => v <= 256),
    b('B5 origin cores', row.originCores, 0.9, (v) => v <= 0.9),
    b('B6 tick mean ratio', row.tickMeanUs != null && zeroTickMean ? +(row.tickMeanUs / zeroTickMean).toFixed(3) : null, 1.1, (v) => v <= 1.1 || row.tickMeanUs - zeroTickMean <= 500),
  ];
}

/** Linux `/proc/<pid>/stat`'s user + system time in seconds (fields 14 and 15, after the command's parentheses). */
export function procCpuSeconds(stat, hz = 100) {
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return (Number(f[11]) + Number(f[12])) / hz;
}
/** `ps -o time=`'s `[[dd-]hh:]mm:ss[.cc]` in seconds. */
export function psSeconds(t) {
  const [d, rest] = t.includes('-') ? t.split('-') : [0, t];
  return Number(d) * 86400 + rest.split(':').reduce((s, x) => s * 60 + Number(x), 0);
}

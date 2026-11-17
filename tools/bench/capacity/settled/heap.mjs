// #2553: what holds a world's main heap, from a V8 heap snapshot (.heapsnapshot, as the inspector writes it after a forced
// collection). The file is read in chunks (a large world's snapshot is past what one string can hold), into typed arrays:
// each node's type, name, self size and edge count, and each edge's type, name and target. Then:
//   - the dominator tree over the strong edges (weak edges never keep anything alive), Cooper, Harvey and Kennedy's
//     iterative algorithm as the browser's own snapshot viewer uses it, and each node's retained size;
//   - `holders`: per `<owner class>.<property>` (or `context.<variable>` for a module's or closure's variable), the size
//     retained by the objects it alone holds (dominated by the owner), summed over the owner's instances;
//   - `groups`: the size freed if a named set of objects went away, by reachability from the root without them, so a menu
//     shared between two caches is counted once. Groups are cumulative in the order given (each is what it adds to the
//     ones before it), and the rest of the heap is what none of them holds.
// No I/O beyond reading the one file. `node heap.mjs <file.heapsnapshot>` prints the summary.
import { openSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHUNK = 1 << 24;
/** The snapshot's arrays: { meta, n, nodeType, nodeName, nodeSelf, nodeEdges, e, edgeType, edgeName, edgeTo, strings }. */
export function readSnapshot(file) {
  const fd = openSync(file, 'r'), buf = Buffer.allocUnsafe(CHUNK);
  let pos = 0, len = 0, at = 0;   // file position of buf[0], bytes in buf, cursor in buf
  const fill = () => { if (at < len) return true; pos += len; len = readSync(fd, buf, 0, CHUNK, pos); at = 0; return len > 0; };
  /** Advance past the next occurrence of `token` (ASCII); returns the text before it when `keep`. */
  const seek = (token, keep = false) => {
    let text = '', m = 0;
    while (fill()) { const c = buf[at++]; if (keep) text += String.fromCharCode(c); if (c === token.charCodeAt(m)) { if (++m === token.length) return keep ? text.slice(0, -token.length) : ''; } else m = c === token.charCodeAt(0) ? 1 : 0; }
    throw new Error(`heap snapshot: ${token} not found`);
  };
  /** Numbers of a flat array up to its closing bracket, each through `put(k, value)`. */
  const numbers = (put) => {
    let v = 0, inNum = false, k = 0;
    while (fill()) {
      const c = buf[at++];
      if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); inNum = true; continue; }
      if (inNum) { put(k++, v); v = 0; inNum = false; }
      if (c === 93) return k;   // ]
    }
    throw new Error('heap snapshot: an array did not close');
  };
  try {
    const head = seek('"nodes":[', true), meta = JSON.parse(head.slice(head.indexOf('{')).replace(/,\s*$/, '') + '}').snapshot;
    const NF = meta.meta.node_fields.length, EF = meta.meta.edge_fields.length, n = meta.node_count, e = meta.edge_count;
    const nf = (k) => meta.meta.node_fields.indexOf(k), ef = (k) => meta.meta.edge_fields.indexOf(k);
    const [fT, fN, fS, fE, eT, eN, eTo] = [nf('type'), nf('name'), nf('self_size'), nf('edge_count'), ef('type'), ef('name_or_index'), ef('to_node')];
    const nodeType = new Uint8Array(n), nodeName = new Uint32Array(n), nodeSelf = new Float64Array(n), nodeEdges = new Uint32Array(n);
    const gotN = numbers((k, x) => { const i = (k / NF) | 0, f = k - i * NF; if (f === fT) nodeType[i] = x; else if (f === fN) nodeName[i] = x; else if (f === fS) nodeSelf[i] = x; else if (f === fE) nodeEdges[i] = x; });
    if (gotN !== n * NF) throw new Error(`heap snapshot: ${gotN} node fields, expected ${n * NF}`);
    seek('"edges":[');
    const edgeType = new Uint8Array(e), edgeName = new Uint32Array(e), edgeTo = new Uint32Array(e);
    const gotE = numbers((k, x) => { const j = (k / EF) | 0, f = k - j * EF; if (f === eT) edgeType[j] = x; else if (f === eN) edgeName[j] = x; else if (f === eTo) edgeTo[j] = x / NF; });
    if (gotE !== e * EF) throw new Error(`heap snapshot: ${gotE} edge fields, expected ${e * EF}`);
    seek('"strings":[');
    // JSON strings, each decoded with JSON.parse; a string may span chunks
    const strings = []; let parts = null, start = -1, esc = false;
    for (;;) {
      if (!fill()) throw new Error('heap snapshot: the strings did not close');
      if (start < 0 && parts == null) {
        const c = buf[at++]; if (c === 34) { start = at; esc = false; } else if (c === 93) break; continue;
      }
      if (start < 0) start = at;
      let end = -1;
      for (; at < len; at++) { const c = buf[at]; if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) { end = at; break; } }
      const piece = Buffer.from(buf.subarray(start, end < 0 ? len : end));
      if (end < 0) { (parts ??= []).push(piece); start = -1; continue; }
      const raw = parts ? Buffer.concat([...parts, piece]) : piece; parts = null; start = -1; at = end + 1;
      strings.push(JSON.parse('"' + raw.toString('utf8') + '"'));
    }
    return { meta, n, nodeType, nodeName, nodeSelf, nodeEdges, e, edgeType, edgeName, edgeTo, strings };
  } finally { closeSync(fd); }
}

/** First edge of each node, the strong-edge test, the postorder from the root, dominators and retained sizes. */
export function analyse(s) {
  const { n, nodeEdges, edgeType, edgeTo, nodeSelf } = s, types = s.meta.meta.edge_types[0], WEAK = types.indexOf('weak'), SHORTCUT = types.indexOf('shortcut');
  const first = new Uint32Array(n + 1); for (let i = 0; i < n; i++) first[i + 1] = first[i] + nodeEdges[i];
  const strong = (j) => edgeType[j] !== WEAK && edgeType[j] !== SHORTCUT;
  // postorder by an iterative depth-first walk from node 0 (the synthetic root)
  const order = new Int32Array(n).fill(-1), post = new Uint32Array(n), stack = new Uint32Array(n), next = new Uint32Array(n); let sp = 0, k = 0;
  const seen = new Uint8Array(n); stack[sp++] = 0; seen[0] = 1; next[0] = first[0];
  while (sp) {
    const v = stack[sp - 1];
    if (next[v] < first[v + 1]) { const j = next[v]++; if (!strong(j)) continue; const w = edgeTo[j]; if (!seen[w]) { seen[w] = 1; next[w] = first[w]; stack[sp++] = w; } continue; }
    sp--; order[v] = k; post[k++] = v;
  }
  const reached = k;
  // predecessors over strong edges between reached nodes (CSR)
  const pc = new Uint32Array(n + 1);
  for (let v = 0; v < n; v++) if (order[v] >= 0) for (let j = first[v]; j < first[v + 1]; j++) if (strong(j) && order[edgeTo[j]] >= 0) pc[edgeTo[j] + 1]++;
  for (let v = 0; v < n; v++) pc[v + 1] += pc[v];
  const preds = new Uint32Array(pc[n]), fillAt = pc.slice(0, n);
  for (let v = 0; v < n; v++) if (order[v] >= 0) for (let j = first[v]; j < first[v + 1]; j++) if (strong(j) && order[edgeTo[j]] >= 0) preds[fillAt[edgeTo[j]]++] = v;
  // dominators by postorder number; the root is the last in postorder
  const UNDEF = 0xffffffff, dom = new Uint32Array(reached).fill(UNDEF), root = reached - 1; dom[root] = root;
  for (let changed = true; changed;) {
    changed = false;
    for (let o = root - 1; o >= 0; o--) {
      const v = post[o]; let nd = UNDEF;
      for (let q = pc[v]; q < pc[v + 1]; q++) {
        let p = order[preds[q]]; if (dom[p] === UNDEF) continue;
        if (nd === UNDEF) { nd = p; continue; }
        let a = p, b = nd; while (a !== b) { while (a < b) a = dom[a]; while (b < a) b = dom[b]; } nd = a;
      }
      if (nd !== UNDEF && dom[o] !== nd) { dom[o] = nd; changed = true; }
    }
  }
  const retained = new Float64Array(n), idom = new Int32Array(n).fill(-1); let total = 0;
  for (let o = 0; o < reached; o++) { const v = post[o]; retained[v] += nodeSelf[v]; total += nodeSelf[v]; if (o !== root && dom[o] !== UNDEF) { const d = post[dom[o]]; idom[v] = d; retained[d] += retained[v]; } }
  return { first, strong, order, reached, idom, retained, total };
}

/** Bytes freed if every node in `drop` went away: the strong reach from the root, skipping them, against the whole. */
export function freedWithout(s, a, drop) {
  const { n, edgeTo, nodeSelf } = s, seen = new Uint8Array(n), q = new Uint32Array(n); let h = 0, t = 0, kept = 0;
  seen[0] = 1; q[t++] = 0;
  while (h < t) { const v = q[h++]; kept += nodeSelf[v]; for (let j = a.first[v]; j < a.first[v + 1]; j++) { const w = edgeTo[j]; if (!seen[w] && a.strong(j) && !drop.has(w)) { seen[w] = 1; q[t++] = w; } } }
  return a.total - kept;
}

const MB = (b) => Math.round(b / 2 ** 20 * 100) / 100;
const USER_CLASS = /^[A-Z][A-Za-z0-9_$]*$/, BUILTIN = new Set(['Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Function', 'Promise', 'Error', 'String', 'Number', 'Boolean', 'Symbol', 'Date', 'RegExp', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Buffer', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray']);
/** The named sets this task asks about (#2553 design): the ledger's menu caches; the replica and take state; the stores
 *  kept per Soul. Matched by class and property name in the snapshot. */
export const GROUPS = [
  { id: 'menu', label: 'menu caches (EdgeLedger capCache, focusCache, wordsCache, lastMenu)', props: { EdgeLedger: ['capCache', 'focusCache', 'wordsCache', 'lastMenu'] } },
  { id: 'replica-take', label: 'replica and take state (instances of classes named *Replica*, *Take*)', classes: /Replica|Take/ },
  { id: 'soul-stores', label: 'per-Soul stores (Souls, SoulNow, SoulProfiles, SoulTimeline, SoulSlowed, PersonalReminders, ActionOutcomes, Together; the other Maps of EdgeLedger)', classes: /^(Souls|SoulNow|SoulProfiles|SoulTimeline|SoulSlowed|PersonalReminders|ActionOutcomes|Together)$/, otherProps: 'EdgeLedger' },
];
export const MENU_PARTS = ['capCache', 'focusCache', 'wordsCache', 'lastMenu'];

/** The summary of one snapshot file: totals, top holders, the groups (cumulative), each menu cache alone, class counts. */
export function summarize(file, { top = 60, minMb = 0.25 } = {}) {
  const s = readSnapshot(file), a = analyse(s), { n, nodeType, nodeName, edgeType, edgeName, edgeTo, strings } = s;
  const ntypes = s.meta.meta.node_types[0], etypes = s.meta.meta.edge_types[0], OBJECT = ntypes.indexOf('object'), PROP = etypes.indexOf('property'), CONTEXT = etypes.indexOf('context'), INTERNAL = etypes.indexOf('internal');
  const nameOf = (v) => strings[nodeName[v]] ?? '';
  const holders = new Map(), classes = new Map(), propTargets = new Map();   // label → {mb, n}; class → {n, self, retained}
  for (let v = 0; v < n; v++) {
    if (a.order[v] < 0) continue;
    const cls = nameOf(v), isObj = nodeType[v] === OBJECT;
    if (isObj && USER_CLASS.test(cls) && !BUILTIN.has(cls)) { const c = classes.get(cls) ?? { n: 0, retained: 0 }; c.n++; c.retained += a.retained[v]; classes.set(cls, c); }
    for (let j = a.first[v]; j < a.first[v + 1]; j++) {
      const t = edgeType[j], w = edgeTo[j];
      if (t !== PROP && t !== CONTEXT && t !== INTERNAL) continue;
      const prop = strings[edgeName[j]] ?? '';
      if (isObj && t === PROP && USER_CLASS.test(cls) && !BUILTIN.has(cls)) { const k = `${cls}.${prop}`; let l = propTargets.get(k); if (!l) propTargets.set(k, (l = [])); l.push(w); }
      if (a.idom[w] !== v) continue;
      const label = t === CONTEXT ? `context.${prop}` : isObj && USER_CLASS.test(cls) && !BUILTIN.has(cls) && t === PROP ? `${cls}.${prop}` : null;
      if (!label) continue;
      const h = holders.get(label) ?? { bytes: 0, n: 0 }; h.bytes += a.retained[w]; h.n++; holders.set(label, h);
    }
  }
  const setOf = (g) => {
    const out = new Set();
    for (const [cls, props] of Object.entries(g.props ?? {})) for (const p of props) for (const w of propTargets.get(`${cls}.${p}`) ?? []) out.add(w);
    if (g.otherProps) for (const [k, ws] of propTargets) if (k.startsWith(g.otherProps + '.') && !MENU_PARTS.includes(k.slice(g.otherProps.length + 1))) for (const w of ws) if (/^(Map|Set)$/.test(nameOf(w))) out.add(w);
    if (g.classes) for (let v = 0; v < n; v++) if (a.order[v] >= 0 && nodeType[v] === OBJECT && g.classes.test(nameOf(v))) out.add(v);
    return out;
  };
  const groups = [], drop = new Set(); let before = 0;
  for (const g of GROUPS) { const own = setOf(g); for (const w of own) drop.add(w); const freed = freedWithout(s, a, drop); groups.push({ id: g.id, label: g.label, objects: own.size, mb: MB(freed - before) }); before = freed; }
  groups.push({ id: 'rest', label: 'everything else', mb: MB(a.total - before) });
  const menuAlone = Object.fromEntries(MENU_PARTS.map((p) => { const ws = propTargets.get(`EdgeLedger.${p}`) ?? []; return [p, ws.length ? MB(freedWithout(s, a, new Set(ws))) : null]; }));
  return {
    file: file.split('/').pop(), nodes: n, edges: s.e, reached: a.reached, totalMb: MB(a.total),
    groups, menuAlone,
    holders: [...holders].map(([label, h]) => ({ label, mb: MB(h.bytes), n: h.n })).filter((h) => h.mb >= minMb).sort((x, y) => y.mb - x.mb).slice(0, top),
    classes: [...classes].map(([cls, c]) => ({ cls, n: c.n, mb: MB(c.retained) })).sort((x, y) => y.mb - x.mb).slice(0, top),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) console.log(JSON.stringify(summarize(process.argv[2]), null, 1));

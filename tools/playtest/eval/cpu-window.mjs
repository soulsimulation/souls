// MEASUREMENT BRANCH ONLY (agent/profile-24-*, never merged): a world's --cpu-prof profile → the samples inside one time
// window (the load), as self time by function, inclusive time by function, and folded stacks of the repo's own frames.
// The window is given in microseconds of the monotonic clock that both process.hrtime and V8's profile timestamps use.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** The main thread's profile in dir (thread id 0 in Node's CPU.<date>.<time>.<pid>.<tid>.<seq>.cpuprofile), and the others. */
export function profilesIn(dir) {
  let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')); } catch { return { main: null, workers: [] }; }
  const tid = (f) => Number(f.split('.').at(-3));
  return { main: files.find((f) => tid(f) === 0) ? join(dir, files.find((f) => tid(f) === 0)) : null, workers: files.filter((f) => tid(f) !== 0).map((f) => join(dir, f)) };
}

export function summarizeWindow(p, { fromUs, toUs, root = '', top = 40, folded = 1500 } = {}) {
  if (!p?.nodes?.length) return null;
  const byId = new Map(p.nodes.map((n) => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(); let t = p.startTime, inN = 0;
  (p.samples ?? []).forEach((id, i) => { const d = p.timeDeltas?.[i] ?? 0; t += d; if (t >= fromUs && t <= toUs) { inN++; self.set(id, (self.get(id) ?? 0) + d / 1000); } });
  const fileOf = (f) => { const u = String(f.url ?? '').replace(/^file:\/\//, ''); return root && u.startsWith(root) ? u.slice(root.length).replace(/^\//, '') : u; };
  const keyOf = (n) => { const f = n.callFrame, file = fileOf(f); return `${f.functionName || '(anonymous)'}${file ? `@${file}:${f.lineNumber + 1}` : ''}`; };
  const own = (n) => { const file = fileOf(n.callFrame); return file && !file.startsWith('node:') && !file.startsWith('/') && !file.includes('node_modules/'); };
  const selfBy = new Map(), inclBy = new Map(), fileBy = new Map(), fold = new Map();
  let total = 0, idle = 0, gc = 0, program = 0;
  for (const [id, ms] of self) {
    const n = byId.get(id), k = keyOf(n); total += ms;
    if (k === '(idle)') { idle += ms; continue; }
    if (k === '(garbage collector)') gc += ms; if (k === '(program)') program += ms;
    selfBy.set(k, (selfBy.get(k) ?? 0) + ms);
    const file = fileOf(n.callFrame) || k; fileBy.set(file, (fileBy.get(file) ?? 0) + ms);
    const seen = new Set(), stack = [];
    for (let x = id; x != null; x = parent.get(x)) {
      const nx = byId.get(x), kk = keyOf(nx);
      if (!seen.has(kk)) { seen.add(kk); inclBy.set(kk, (inclBy.get(kk) ?? 0) + ms); }
      if (x === id || own(nx)) { if (stack.at(-1) !== kk) stack.push(kk); }
    }
    const s = stack.reverse().join(';'); fold.set(s, (fold.get(s) ?? 0) + ms);
  }
  const busy = total - idle;
  const list = (m, n) => [...m].filter(([k]) => k !== '(root)').sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, ms]) => ({ fn, ms: r(ms, 0), share: busy ? r(ms / busy, 4) : null }));
  const folds = [...fold].sort((a, b) => b[1] - a[1]), kept = folds.slice(0, folded);
  return {
    window: { fromUs, toUs, profileStartUs: p.startTime, profileEndUs: p.endTime, samplesIn: inN },
    sampledMs: r(total, 0), idleMs: r(idle, 0), busyMs: r(busy, 0), gcMs: r(gc, 0), programMs: r(program, 0),
    self: list(selfBy, top), files: list(fileBy, 30), inclusive: list(inclBy, 80),
    folded: kept.map(([s, ms]) => [s, r(ms, 1)]), foldedRestMs: r(folds.slice(folded).reduce((a, [, ms]) => a + ms, 0), 0),
  };
}

export function summarizeFile(file, o) { try { return summarizeWindow(JSON.parse(readFileSync(file, 'utf8')), o); } catch (e) { return { error: String(e?.message ?? e) }; } }
